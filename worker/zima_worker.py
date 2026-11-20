"""Zima Video — Ajudante (roda no PC).

Pede vídeos ao servidor Zima Video, tira alguns quadros de cada um (lendo só os trechos necessários pela
rede), encontra os rostos e calcula a "assinatura" de cada rosto usando a placa de vídeo do PC (DirectML:
AMD, NVIDIA ou Intel). Manda as assinaturas e recortes pequenos dos rostos de volta ao servidor, que
agrupa os rostos e sugere as tags de pessoas. O NAS não faz o trabalho pesado.

O jeito normal de usar é pela janela (ajudante.pyw), que controla quanto do PC o ajudante pode usar.
Este arquivo também roda sozinho, no console:
      python zima_worker.py             analisa com o nível "Máximo"
      python zima_worker.py --setup     configura endereço e código
      python zima_worker.py --cpu       força o processador (sem placa de vídeo)
      python zima_worker.py --nivel leve|medio|maximo
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
import threading
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

# ---------------------------------------------------------------- níveis de uso do PC
# duty: fração do tempo trabalhando (o resto ele descansa); parallel: quadros lidos ao mesmo tempo;
# pause: descanso entre um vídeo e outro; prio: prioridade dos processos no Windows
LEVELS = {
    'pausado': {'nome': 'Pausado', 'duty': 0.0, 'parallel': 1, 'pause': 0, 'prio': 'idle'},
    'leve':    {'nome': 'Leve',    'duty': 0.25, 'parallel': 1, 'pause': 6, 'prio': 'idle'},
    'medio':   {'nome': 'Médio',   'duty': 0.6, 'parallel': 2, 'pause': 1, 'prio': 'below'},
    'maximo':  {'nome': 'Máximo',  'duty': 1.0, 'parallel': 4, 'pause': 0, 'prio': 'below'},
}
LEVEL_ORDER = ['pausado', 'leve', 'medio', 'maximo']

IS_WIN = os.name == 'nt'
NOWINDOW = 0x08000000 if IS_WIN else 0                       # sem janela de console piscando no Windows
PRIO_FLAGS = {'idle': 0x00000040, 'below': 0x00004000, 'normal': 0x00000020}


def set_process_priority(prio):
    """Prioridade deste processo: o Windows dá preferência aos seus programas quando você está usando o PC."""
    try:
        if IS_WIN:
            import ctypes
            h = ctypes.windll.kernel32.GetCurrentProcess()
            ctypes.windll.kernel32.SetPriorityClass(h, PRIO_FLAGS.get(prio, PRIO_FLAGS['below']))
        else:
            os.setpriority(os.PRIO_PROCESS, 0, {'idle': 19, 'below': 10, 'normal': 0}.get(prio, 10))
    except Exception:
        pass


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
    data = {k: v for k, v in cfg.items() if not k.startswith('_')}
    tmp = CONFIG + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, CONFIG)


def setup(cfg):
    print('\n=== Configurar o ajudante do Zima Video ===')
    print('No app: menu ⋮ → Pessoas → "Conectar ajudante" mostra o endereço e o código.\n')
    srv = input(f'Endereço do Zima Video [{cfg.get("server", "http://IP-DO-ZIMA:8096")}]: ').strip() or cfg.get('server', '')
    tok = input('Código de conexão: ').strip() or cfg.get('token', '')
    try:
        name = check_connection(cfg, srv, tok)
        print(f'\nConectado! Este PC aparece no app como "{name}".')
    except Exception as e:
        print(f'\nNão consegui conectar: {e}\nConfira o endereço e o código e rode a configuração de novo.')
        return False
    return True


def check_connection(cfg, server, token):
    """Confere endereço e código; se der certo, grava na configuração. Devolve o nome do PC no app."""
    server = (server or '').strip()
    if server and not server.startswith('http'):
        server = 'http://' + server
    server = server.rstrip('/')
    test = dict(cfg, server=server, token=(token or '').strip())
    r = api(test, 'GET', '/api/worker/hello', timeout=15)
    cfg.update(server=test['server'], token=test['token'])
    save_config(cfg)
    return r.get('name')


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
def ensure_models(progress=None):
    if all(os.path.exists(os.path.join(MODELS, f)) for f in MODEL_FILES):
        return
    os.makedirs(MODELS, exist_ok=True)
    say = progress or (lambda m: log(m))
    say('Baixando os modelos de reconhecimento facial (≈ 290 MB, só na primeira vez)…')
    tmp = os.path.join(tempfile.gettempdir(), 'zima_buffalo_l.zip')
    with requests.get(MODEL_URL, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get('content-length', 0)); done = 0; last = 0
        with open(tmp, 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk); done += len(chunk)
                if total and time.time() - last > 2:
                    last = time.time(); say(f'Baixando os modelos… {done * 100 // total}%')
    with zipfile.ZipFile(tmp) as z:
        for n in z.namelist():
            if os.path.basename(n) in MODEL_FILES:
                with z.open(n) as src, open(os.path.join(MODELS, os.path.basename(n)), 'wb') as dst:
                    shutil.copyfileobj(src, dst)
    os.remove(tmp)
    say('Modelos prontos.')


def ffmpeg_path():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which('ffmpeg') or 'ffmpeg'


def sample_times(duration, n):
    if duration <= 0:
        return [1.0]
    n = int(max(6, min(n, duration / 8)))
    a, b = duration * 0.03, duration * 0.97
    return [a + (b - a) * i / max(1, n - 1) for i in range(n)]


# ---------------------------------------------------------------- o ajudante (controlável)
class Stopped(Exception):
    pass


class Helper:
    """Trabalha numa thread. A janela muda o nível a qualquer momento com set_level();
    on_event(tipo, dados) avisa a janela do que está acontecendo."""

    def __init__(self, cfg, force_cpu=False, on_event=None):
        self.cfg = cfg
        self.force_cpu = force_cpu
        self.on_event = on_event or (lambda kind, data: None)
        self.level = 'maximo'
        self._wake = threading.Event()
        self._stop = threading.Event()
        self.thread = None
        self.eng = None
        self.ffmpeg = None
        self.device = ''
        self.done = 0
        self.failed = 0
        self.current = None
        self._procs = set()
        self._lock = threading.Lock()

    # --- controle
    def set_level(self, level):
        if level not in LEVELS or level == self.level:
            return
        self.level = level
        set_process_priority(LEVELS[level]['prio'])
        self.emit('level', level)
        self._wake.set()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self._stop.clear()
        self.thread = threading.Thread(target=self._run, name='ajudante', daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set(); self._wake.set()
        with self._lock:
            for p in list(self._procs):
                try: p.kill()
                except Exception: pass

    def emit(self, kind, data=None):
        try: self.on_event(kind, data)
        except Exception: pass

    def say(self, msg):
        self.emit('log', time.strftime('%H:%M:%S ') + msg)

    # espera respeitando pausa/parada; volta antes se o nível mudar
    def _sleep(self, sec):
        end = time.time() + sec
        while not self._stop.is_set():
            left = end - time.time()
            if left <= 0:
                return
            self._wake.wait(min(left, 1.0)); self._wake.clear()
            if self.level == 'pausado':
                return

    def _wait_if_paused(self):
        announced = False
        while self.level == 'pausado' and not self._stop.is_set():
            if not announced:
                self.emit('state', {'state': 'paused'}); announced = True
            self._wake.wait(1.0); self._wake.clear()
        if self._stop.is_set():
            raise Stopped()

    # descanso proporcional ao trabalho feito (ex.: nível Leve trabalha 25% do tempo)
    def _breathe(self, worked):
        duty = LEVELS[self.level]['duty']
        if 0 < duty < 1 and worked > 0:
            self._sleep(worked * (1 - duty) / duty)
        self._wait_if_paused()

    # --- trabalho
    def _grab(self, url, t, fast=True):
        cmd = [self.ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error',
               '-headers', f'Authorization: Bearer {self.cfg["token"]}\r\n']
        if fast:
            cmd += ['-skip_frame', 'nokey', '-noaccurate_seek']
        cmd += ['-ss', f'{t:.2f}', '-i', url, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2",
                '-f', 'image2pipe', '-vcodec', 'bmp', '-']
        flags = NOWINDOW | (PRIO_FLAGS[LEVELS[self.level]['prio']] if IS_WIN else 0)
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
        except Exception:
            return None
        with self._lock:
            self._procs.add(p)
        try:
            out, _ = p.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            p.kill(); out = b''
        finally:
            with self._lock:
                self._procs.discard(p)
        if self._stop.is_set():
            raise Stopped()
        if not out:
            return self._grab(url, t, fast=False) if fast else None
        return cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)

    def analyze(self, job):
        url = urljoin(self.cfg['server'] + '/', job['url'].lstrip('/'))
        times = sample_times(job.get('duration') or 0, self.cfg.get('frames', 36))
        t0 = time.time()
        groups = []  # rostos da mesma pessoa dentro do vídeo
        nframes = 0
        i = 0
        # lê os quadros em pequenos lotes (o tamanho do lote acompanha o nível) e analisa cada lote
        while i < len(times):
            self._wait_if_paused()
            par = max(1, min(int(self.cfg.get('parallel', 4)), LEVELS[self.level]['parallel']))
            batch = times[i:i + par]
            tb = time.time()
            with ThreadPoolExecutor(max_workers=par) as ex:
                frames = list(ex.map(lambda t: (t, self._grab(url, t)), batch))
            for t, img in frames:
                if img is None:
                    continue
                nframes += 1
                for f in self.eng.analyze(img):
                    size = float(min(f['box'][2] - f['box'][0], f['box'][3] - f['box'][1]))
                    crop = face_crop(img, f['box'])
                    item = {'t': t, 'score': f['score'], 'size': size, 'emb': f['emb'], 'box': f['box'], 'crop': crop}
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
            i += len(batch)
            self.emit('progress', {'frames': i, 'total': len(times)})
            self._breathe(time.time() - tb)
        out = []
        for gi, g in enumerate(groups):
            reps = sorted(g['items'], key=lambda x: x['score'] * min(x['size'], 300), reverse=True)[:REPS_PER_PERSON]
            for r in reps:
                jpg = cv2.imencode('.jpg', r['crop'], [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() if r['crop'] is not None else b''
                out.append({
                    't': round(r['t'], 2), 'score': round(r['score'], 3), 'n': len(g['items']), 'group': gi,
                    'box': [round(float(v), 1) for v in r['box']],
                    'emb': base64.b64encode(r['emb'].astype('<f4').tobytes()).decode(),
                    'crop': base64.b64encode(jpg).decode() if jpg else None,
                })
        return {'path': job['path'], 'key': job['key'], 'frames': nframes, 'faces': out,
                'ms': int((time.time() - t0) * 1000), 'people': len(groups)}

    def _prepare(self):
        self.emit('state', {'state': 'starting'})
        ensure_models(progress=self.say)
        self.ffmpeg = ffmpeg_path()
        self.eng = FaceEngine(MODELS, prefer_gpu=not self.force_cpu)
        self.device = {'DmlExecutionProvider': 'placa de vídeo (DirectML)', 'CUDAExecutionProvider': 'placa NVIDIA (CUDA)',
                       'CPUExecutionProvider': 'processador'}.get(self.eng.provider, self.eng.provider)
        self.cfg['_info'] = f'{socket.gethostname()} · {platform.system()} · {self.device}'
        set_process_priority(LEVELS[self.level]['prio'])
        self.emit('device', self.device)
        self.say(f'Pronto — analisando com: {self.device}')

    def _run(self):
        try:
            self._prepare()
        except Exception as e:
            self.emit('state', {'state': 'error', 'msg': f'Não consegui iniciar: {e}'})
            self.say(f'Erro ao iniciar: {e}')
            return
        fails = 0
        while not self._stop.is_set():
            try:
                self._wait_if_paused()
                try:
                    job = api(self.cfg, 'GET', '/api/worker/job')
                    fails = 0
                except Exception as e:
                    fails += 1
                    wait = min(300, 10 * fails)
                    self.emit('state', {'state': 'offline', 'msg': str(e)})
                    self.say(f'Sem conexão com o servidor ({e}). Nova tentativa em {wait}s.')
                    self._sleep(wait); continue
                if job.get('progress'):
                    self.emit('server', job['progress'])
                if job.get('none'):
                    self.emit('state', {'state': 'idle'})
                    self._sleep(job.get('wait', 60)); continue
                self.current = job['path']
                self.emit('state', {'state': 'working', 'path': job['path']})
                try:
                    res = self.analyze(job)
                    api(self.cfg, 'POST', '/api/worker/result', json=res, timeout=300)
                    self.done += 1
                    self.emit('done', {'path': job['path'], 'people': res['people'], 'ms': res['ms']})
                    self.say(f'✓ {os.path.basename(job["path"])} — {res["people"]} pessoa(s), {res["ms"] / 1000:.1f}s')
                except Stopped:
                    raise
                except Exception as e:
                    self.failed += 1
                    self.say(f'✗ {os.path.basename(job["path"])}: {e}')
                    try: api(self.cfg, 'POST', '/api/worker/result', json={'path': job['path'], 'key': job['key'], 'faces': [], 'error': str(e)[:300]})
                    except Exception: pass
                self.current = None
                self._sleep(LEVELS[self.level]['pause'])
            except Stopped:
                break
        self.emit('state', {'state': 'stopped'})


# ---------------------------------------------------------------- console (sem janela)
def main():
    ap = argparse.ArgumentParser(description='Ajudante do Zima Video (reconhecimento facial no PC)')
    ap.add_argument('--setup', action='store_true', help='configurar endereço e código')
    ap.add_argument('--server'); ap.add_argument('--token')
    ap.add_argument('--cpu', action='store_true', help='usar só o processador')
    ap.add_argument('--nivel', choices=['leve', 'medio', 'maximo'], default='maximo')
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

    limit = 1 if args.once else args.max
    finished = threading.Event()

    def on_event(kind, data):
        if kind == 'log':
            print(data, flush=True)
        elif kind == 'done':
            if limit and h.done >= limit:
                finished.set()
        elif kind == 'state':
            st = data.get('state')
            if st in ('error', 'stopped'):
                print(data.get('msg', ''), flush=True); finished.set()
            elif st == 'idle':
                print(time.strftime('%H:%M:%S'), 'Nenhum vídeo pendente.' if limit else 'Tudo analisado. Verificando de novo daqui a pouco…', flush=True)
                if limit: finished.set()

    h = Helper(cfg, force_cpu=args.cpu, on_event=on_event)
    h.level = args.nivel
    h.start()
    try:
        while not finished.wait(0.5):
            pass
    except KeyboardInterrupt:
        print('\nAjudante encerrado.')
    h.stop()


if __name__ == '__main__':
    main()
