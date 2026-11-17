"""Zima Video — Ajudante (roda no PC).

Pede vídeos ao servidor Zima Video, tira alguns quadros de cada um (lendo só os trechos necessários pela
rede), encontra os rostos e calcula a "assinatura" de cada rosto usando a placa de vídeo do PC (DirectML:
AMD, NVIDIA ou Intel). Manda as assinaturas e recortes pequenos dos rostos de volta ao servidor, que
agrupa os rostos e sugere as tags de pessoas. O NAS não faz o trabalho pesado.

Uso:  iniciar.bat            (ou: python zima_worker.py)
      python zima_worker.py --setup     configura endereço e código
      python zima_worker.py --cpu       força o processador (sem placa de vídeo)
"""
import argparse
import base64
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin

import cv2
import numpy as np
import requests

from faces import FaceEngine, face_crop

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'config.json')
MODELS = os.path.join(HERE, 'models')
MODEL_URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
MODEL_FILES = ('det_10g.onnx', 'w600k_r50.onnx')
GROUP_SIM = 0.45      # rostos de um mesmo vídeo com semelhança acima disso = mesma pessoa
REPS_PER_PERSON = 3   # quantos rostos de cada pessoa por vídeo são enviados (os melhores)


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ---------------------------------------------------------------- configuração
def load_config():
    try:
        with open(CONFIG, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=1)


def setup(cfg):
    print('\n=== Configurar o ajudante do Zima Video ===')
    print('No app: menu ⋮ → Pessoas → "Conectar ajudante" mostra o endereço e o código.\n')
    srv = input(f'Endereço do Zima Video [{cfg.get("server", "http://IP-DO-ZIMA:8096")}]: ').strip() or cfg.get('server', '')
    if srv and not srv.startswith('http'):
        srv = 'http://' + srv
    tok = input('Código de conexão: ').strip() or cfg.get('token', '')
    cfg.update(server=srv.rstrip('/'), token=tok)
    save_config(cfg)
    try:
        r = api(cfg, 'GET', '/api/worker/hello')
        print(f'\nConectado! Este PC aparece no app como "{r.get("name")}".')
    except Exception as e:
        print(f'\nNão consegui conectar: {e}\nConfira o endereço e o código e rode a configuração de novo.')
        return False
    return True


# ---------------------------------------------------------------- servidor
SESSION = requests.Session()


def api(cfg, method, path, **kw):
    headers = kw.pop('headers', {})
    headers['Authorization'] = 'Bearer ' + cfg['token']
    headers['X-Worker-Info'] = cfg.get('_info', '')
    r = SESSION.request(method, cfg['server'] + path, headers=headers, timeout=kw.pop('timeout', 60), **kw)
    if r.status_code >= 400:
        try:
            msg = r.json().get('error')
        except Exception:
            msg = r.text[:200]
        raise RuntimeError(f'{r.status_code} {msg}')
    return r.json()


# ---------------------------------------------------------------- modelos e ffmpeg
def ensure_models():
    if all(os.path.exists(os.path.join(MODELS, f)) for f in MODEL_FILES):
        return
    os.makedirs(MODELS, exist_ok=True)
    log('Baixando os modelos de reconhecimento facial (≈ 290 MB, só na primeira vez)…')
    tmp = os.path.join(tempfile.gettempdir(), 'zima_buffalo_l.zip')
    with requests.get(MODEL_URL, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get('content-length', 0)); done = 0; last = 0
        with open(tmp, 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk); done += len(chunk)
                if total and time.time() - last > 2:
                    last = time.time(); print(f'   {done * 100 // total}%', end='\r', flush=True)
    with zipfile.ZipFile(tmp) as z:
        for n in z.namelist():
            if os.path.basename(n) in MODEL_FILES:
                with z.open(n) as src, open(os.path.join(MODELS, os.path.basename(n)), 'wb') as dst:
                    shutil.copyfileobj(src, dst)
    os.remove(tmp)
    log('Modelos prontos.')


def ffmpeg_path():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which('ffmpeg') or 'ffmpeg'


FFMPEG = None
NOWINDOW = 0x08000000 if os.name == 'nt' else 0  # sem janela de console piscando no Windows


def grab(cfg, url, t, fast=True):
    """Um quadro do vídeo no tempo t (o ffmpeg busca pela rede só o trecho necessário)."""
    cmd = [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error',
           '-headers', f'Authorization: Bearer {cfg["token"]}\r\n']
    if fast:
        cmd += ['-skip_frame', 'nokey', '-noaccurate_seek']
    cmd += ['-ss', f'{t:.2f}', '-i', url, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2",
            '-f', 'image2pipe', '-vcodec', 'bmp', '-']
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=NOWINDOW)
    except subprocess.TimeoutExpired:
        return None
    if not p.stdout:
        return grab(cfg, url, t, fast=False) if fast else None
    img = cv2.imdecode(np.frombuffer(p.stdout, np.uint8), cv2.IMREAD_COLOR)
    return img


def sample_times(duration, n):
    if duration <= 0:
        return [1.0]
    n = int(max(6, min(n, duration / 8)))
    a, b = duration * 0.03, duration * 0.97
    return [a + (b - a) * i / max(1, n - 1) for i in range(n)]


# ---------------------------------------------------------------- análise de um vídeo
def analyze(cfg, eng, job):
    url = urljoin(cfg['server'] + '/', job['url'].lstrip('/'))
    times = sample_times(job.get('duration') or 0, cfg.get('frames', 36))
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=cfg.get('parallel', 4)) as ex:
        frames = list(ex.map(lambda t: (t, grab(cfg, url, t)), times))
    t_grab = time.time() - t0
    groups = []  # rostos da mesma pessoa dentro do vídeo
    nframes = 0
    for t, img in frames:
        if img is None:
            continue
        nframes += 1
        for f in eng.analyze(img):
            size = float(min(f['box'][2] - f['box'][0], f['box'][3] - f['box'][1]))
            item = {'t': t, 'score': f['score'], 'size': size, 'emb': f['emb'], 'box': f['box'], 'img': img}
            best, bs = None, GROUP_SIM
            for g in groups:
                s = float(np.dot(g['mean'], f['emb']))
                if s > bs:
                    best, bs = g, s
            if best is None:
                groups.append({'sum': f['emb'].copy(), 'mean': f['emb'].copy(), 'items': [item]})
            else:
                best['items'].append(item)
                best['sum'] += f['emb']
                best['mean'] = best['sum'] / max(np.linalg.norm(best['sum']), 1e-9)
    out = []
    for gi, g in enumerate(groups):
        reps = sorted(g['items'], key=lambda x: x['score'] * min(x['size'], 300), reverse=True)[:REPS_PER_PERSON]
        for r in reps:
            crop = face_crop(r['img'], r['box'])
            jpg = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() if crop is not None else b''
            out.append({
                't': round(r['t'], 2), 'score': round(r['score'], 3), 'n': len(g['items']), 'group': gi,
                'box': [round(float(v), 1) for v in r['box']],
                'emb': base64.b64encode(r['emb'].astype('<f4').tobytes()).decode(),
                'crop': base64.b64encode(jpg).decode() if jpg else None,
            })
    for _, img in frames:
        del img
    return {'path': job['path'], 'key': job['key'], 'frames': nframes, 'faces': out,
            'ms': int((time.time() - t0) * 1000), 'grab_ms': int(t_grab * 1000), 'people': len(groups)}


# ---------------------------------------------------------------- laço principal
def main():
    global FFMPEG
    ap = argparse.ArgumentParser(description='Ajudante do Zima Video (reconhecimento facial no PC)')
    ap.add_argument('--setup', action='store_true', help='configurar endereço e código')
    ap.add_argument('--server'); ap.add_argument('--token')
    ap.add_argument('--cpu', action='store_true', help='usar só o processador')
    ap.add_argument('--once', action='store_true', help='analisar um vídeo e sair (teste)')
    ap.add_argument('--max', type=int, default=0, help='analisar no máximo N vídeos')
    args = ap.parse_args()

    cfg = load_config()
    if args.server: cfg['server'] = args.server.rstrip('/')
    if args.token: cfg['token'] = args.token
    if args.server or args.token: save_config(cfg)
    if args.setup or not cfg.get('server') or not cfg.get('token'):
        ok = setup(cfg)
        ensure_models()
        if args.setup:
            sys.exit(0 if ok else 1)

    ensure_models()
    FFMPEG = ffmpeg_path()
    eng = FaceEngine(MODELS, prefer_gpu=not args.cpu)
    dev = {'DmlExecutionProvider': 'placa de vídeo (DirectML)', 'CUDAExecutionProvider': 'placa NVIDIA (CUDA)',
           'CPUExecutionProvider': 'processador'}.get(eng.provider, eng.provider)
    cfg['_info'] = f'{socket.gethostname()} · {platform.system()} · {dev}'
    log(f'Ajudante iniciado — analisando com: {dev}')
    log(f'Servidor: {cfg["server"]}')
    done = 0; fails = 0
    while True:
        try:
            job = api(cfg, 'GET', '/api/worker/job')
            fails = 0
        except Exception as e:
            fails += 1
            wait = min(300, 10 * fails)
            log(f'Sem conexão com o servidor ({e}). Nova tentativa em {wait}s.')
            time.sleep(wait); continue
        if job.get('none'):
            if args.once or args.max:
                log('Nenhum vídeo pendente.'); break
            log(f'Tudo analisado. Verificando de novo em {job.get("wait", 60)}s…')
            time.sleep(job.get('wait', 60)); continue
        try:
            res = analyze(cfg, eng, job)
            api(cfg, 'POST', '/api/worker/result', json=res, timeout=300)
            done += 1
            log(f'✓ {job["path"]} — {res["people"]} pessoa(s), {res["frames"]} quadros, {res["ms"] / 1000:.1f}s')
        except Exception as e:
            log(f'✗ {job["path"]}: {e}')
            try: api(cfg, 'POST', '/api/worker/result', json={'path': job['path'], 'key': job['key'], 'faces': [], 'error': str(e)[:300]})
            except Exception: pass
        if args.once or (args.max and done >= args.max):
            break


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nAjudante encerrado.')
