"""Zima Video — Ajudante: compressão de vídeos no PC.

O app (Zima Video → selecionar vídeos/pasta → Comprimir) coloca vídeos numa fila. Este módulo pega um por
vez, comprime aqui no PC (pela placa de vídeo quando dá: AMD AMF, NVIDIA NVENC ou Intel QSV; senão pelo
processador), e manda o arquivo pronto de volta. O servidor confere o arquivo e o coloca no lugar do
original (mesmo nome, mesma pasta, mesma data; o original vai para a Lixeira).

Respeita o nível de uso do PC: comprime nos níveis Médio e Máximo; no Leve/Pausado a compressão fica
congelada (sem perder o que já foi feito) e continua sozinha quando o nível volta a permitir.
"""
import os
import re
import subprocess
import tempfile
import threading
import time

import requests

from faces import readable_error
from zima_worker import IS_WIN, LEVELS, NOWINDOW, PRIO_FLAGS, SESSION, api, ffmpeg_path

try:
    import psutil  # congelar/continuar o ffmpeg quando você volta a usar o PC
except Exception:  # pragma: no cover
    psutil = None

GPU_ENC = {'av1': ['av1_amf', 'av1_nvenc', 'av1_qsv'], 'hevc': ['hevc_amf', 'hevc_nvenc', 'hevc_qsv'], 'h264': ['h264_amf', 'h264_nvenc', 'h264_qsv']}
CPU_ENC = {'av1': 'libsvtav1', 'hevc': 'libx265', 'h264': 'libx264'}
ENC_NAMES = {'amf': 'placa AMD', 'nvenc': 'placa NVIDIA', 'qsv': 'Intel Quick Sync', 'libsvtav1': 'processador (SVT-AV1)',
             'libx265': 'processador (x265)', 'libx264': 'processador (x264)'}


def enc_label(enc):
    for k, v in ENC_NAMES.items():
        if k in enc:
            return v
    return enc


def venc_args(v, enc):
    """Parâmetros do codificador de vídeo. A qualidade alvo vem do servidor (crf); para a placa de vídeo
    é convertida para a escala de cada fabricante."""
    crf = int(v['crf']); codec = v['codec']
    pix10 = v.get('tenbit') and codec != 'h264'
    if enc == 'libsvtav1':
        return ['-c:v', enc, '-crf', str(crf), '-preset', '7', '-pix_fmt', 'yuv420p10le' if pix10 else 'yuv420p']
    if enc == 'libx265':
        return ['-c:v', enc, '-crf', str(crf), '-preset', 'medium', '-tag:v', 'hvc1', '-x265-params', 'log-level=error',
                '-pix_fmt', 'yuv420p10le' if pix10 else 'yuv420p']
    if enc == 'libx264':
        return ['-c:v', enc, '-crf', str(crf), '-preset', 'medium', '-pix_fmt', 'yuv420p', '-profile:v', 'high']
    if enc.endswith('_nvenc'):
        cq = {'h264': crf, 'hevc': crf + 2, 'av1': crf + 2}[codec]
        out = ['-c:v', enc, '-preset', 'p6', '-rc', 'vbr', '-cq', str(cq), '-b:v', '0', '-pix_fmt', 'yuv420p']
    elif enc.endswith('_amf'):
        if codec == 'av1':
            q = min(255, int(crf * 4.2))  # AV1 na AMD usa escala 0–255
            out = ['-c:v', enc, '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp', '-qp_i', str(q), '-qp_p', str(min(255, q + 8))]
        else:
            out = ['-c:v', enc, '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp', '-qp_i', str(crf - 1), '-qp_p', str(crf + 1)]
        out += ['-pix_fmt', 'yuv420p']
    else:  # _qsv
        out = ['-c:v', enc, '-global_quality', str(crf), '-preset', 'slower', '-pix_fmt', 'nv12']
    if codec == 'hevc':
        out += ['-tag:v', 'hvc1']
    return out


class Compressor:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event or (lambda k, d: None)
        self.level = 'maximo'
        self.ff = None
        self.ok_enc = {}           # codificador → funciona neste PC?
        self.thread = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.proc = None
        self.current = None
        self.done = 0; self.saved = 0; self.failed = 0

    # --- controle
    @property
    def enabled(self):
        return bool(self.cfg.get('compress', True))

    @property
    def use_gpu(self):
        return bool(self.cfg.get('compress_gpu', True))

    def allowed(self):
        return self.enabled and self.level in ('medio', 'maximo')

    def set_level(self, level):
        self.level = level
        self._wake.set()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self._stop.clear()
        self.thread = threading.Thread(target=self._run, name='compressor', daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set(); self._wake.set()
        p = self.proc
        if p:
            try:
                if psutil: psutil.Process(p.pid).resume()
            except Exception:
                pass
            try: p.kill()
            except Exception: pass

    def emit(self, kind, data=None):
        try: self.on_event(kind, data)
        except Exception: pass

    def say(self, msg):
        self.emit('log', time.strftime('%H:%M:%S ') + msg)

    def _sleep(self, sec):
        self._wake.wait(sec); self._wake.clear()

    def _api(self, method, path, **kw):
        h = kw.pop('headers', {}); h['X-Worker-Compress'] = '1'
        return api(self.cfg, method, path, headers=h, **kw)

    # --- codificadores disponíveis neste PC (testados de verdade com um vídeo minúsculo)
    def _works(self, enc, codec):
        key = f'{enc}|{codec}'
        if key not in self.ok_enc:
            cmd = [self.ff, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=0.6', '-frames:v', '12']
            cmd += venc_args({'crf': 28, 'codec': codec}, enc) + ['-f', 'null', '-']
            try:
                ok = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=NOWINDOW).returncode == 0
            except Exception:
                ok = False
            self.ok_enc[key] = ok
        return self.ok_enc[key]

    def pick(self, codec):
        if self.use_gpu:
            for enc in GPU_ENC.get(codec, []):
                if self._works(enc, codec):
                    return enc
        cpu = CPU_ENC[codec]
        return cpu if self._works(cpu, codec) else None

    # --- laço
    def _run(self):
        self.ff = ffmpeg_path()
        while not self._stop.is_set():
            if not self.allowed():
                self._sleep(5); continue
            try:
                job = self._api('GET', '/api/worker/compress-job')
            except Exception:
                self._sleep(60); continue
            if job.get('none'):
                self._sleep(60); continue
            try:
                self._process(job)
            except Exception as e:  # nunca derruba o programa
                self.failed += 1
                msg = readable_error(e)
                self.say(f'✗ Compressão de {job.get("name")}: {msg}')
                try: self._api('POST', '/api/worker/compress-fail', json={'id': job['id'], 'error': msg})
                except Exception: pass
            finally:
                self.current = None; self.proc = None
                self.emit('compress', None)

    def _process(self, job, force_cpu=False):
        spec = job['spec']; v = spec['v']; codec = v['codec']
        enc = CPU_ENC[codec] if force_cpu else self.pick(codec)
        if not enc:
            raise RuntimeError(f'este PC não tem codificador para {codec.upper()}')
        self.current = {'name': job['name'], 'pct': 0, 'enc': enc_label(enc), 'stage': 'comprimindo', 'speed': ''}
        self.emit('compress', self.current)
        self.say(f'Comprimindo {job["name"]} ({codec.upper()} pela {enc_label(enc)})…')
        tmpdir = os.path.join(tempfile.gettempdir(), 'zima-comprimir'); os.makedirs(tmpdir, exist_ok=True)
        out = os.path.join(tmpdir, f'{job["id"]}{spec["outExt"]}')
        url = self.cfg['server'] + job['url']
        vf = []
        if v.get('scale'):
            vf = ['-vf', f'scale={v["scale"]}:-2' if v.get('portrait') else f'scale=-2:{v["scale"]}']
        cmd = [self.ff, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
               '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
               '-headers', f'Authorization: Bearer {self.cfg["token"]}\r\n', '-i', url,
               *spec['maps'], *vf, *venc_args(v, enc), *spec['post'], '-progress', 'pipe:1', '-nostats', out]
        flags = NOWINDOW | (PRIO_FLAGS['below'] if IS_WIN else 0)
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
        self.proc = p
        err = []
        threading.Thread(target=lambda: err.append(p.stderr.read().decode('utf-8', 'replace')), daemon=True).start()
        dur = max(1.0, float(job.get('duration') or 1))
        last_post = 0; paused = False; cancelled = False
        for raw in iter(p.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').strip()
            m = re.match(r'out_time_(?:us|ms)=(\d+)', line)
            if m:
                self.current['pct'] = min(99, int(int(m.group(1)) / 1e6 / dur * 100))
            m = re.match(r'speed=\s*([\d.]+)x', line)
            if m:
                self.current['speed'] = f'{float(m.group(1)):.1f}x'
            if time.time() - last_post > 5:
                last_post = time.time()
                self.emit('compress', self.current)
                try:
                    r = self._api('POST', '/api/worker/compress-progress', json={'id': job['id'], 'pct': self.current['pct'], 'speed': self.current['speed']})
                    if r.get('cancel'):
                        cancelled = True; p.kill(); break
                except Exception:
                    pass
            # você voltou a usar o PC: congela o ffmpeg até o nível permitir de novo
            while not self.allowed() and not self._stop.is_set() and psutil:
                if not paused:
                    try: psutil.Process(p.pid).suspend(); paused = True
                    except Exception: break
                    self.current['stage'] = 'pausada'; self.emit('compress', self.current)
                time.sleep(2)
            if paused and (self.allowed() or self._stop.is_set()):
                try: psutil.Process(p.pid).resume()
                except Exception: pass
                paused = False; self.current['stage'] = 'comprimindo'; self.emit('compress', self.current)
            if self._stop.is_set():
                p.kill(); break
        rc = p.wait()
        if self._stop.is_set():
            self._cleanup(out)
            try: self._api('POST', '/api/worker/compress-fail', json={'id': job['id'], 'error': 'ajudante fechado', 'retry': True})
            except Exception: pass
            return
        if cancelled:
            self._cleanup(out); self.say(f'Compressão de {job["name"]} cancelada no app.'); return
        if rc != 0:
            self._cleanup(out)
            msg = (''.join(err).strip().splitlines() or [f'código {rc}'])[-1][:200]
            if not enc.startswith('lib') and not force_cpu:
                # a placa recusou este vídeo: faz pelo processador
                self.say(f'A {enc_label(enc)} não conseguiu comprimir ({msg}); tentando pelo processador.')
                self.ok_enc[f'{enc}|{codec}'] = False
                return self._process(job, force_cpu=True)
            raise RuntimeError(f'ffmpeg: {msg}')
        # envia o arquivo pronto
        size = os.path.getsize(out)
        self.current.update(stage='enviando', pct=0); self.emit('compress', self.current)
        cur = self.current

        class Reader:  # envia em pedaços com tamanho conhecido (e mostra o progresso do envio)
            def __init__(self, f): self.f = f; self.len = size; self.sent = 0
            def __len__(self): return size
            def read(self, n=-1):
                b = self.f.read(1 << 20 if n is None or n < 0 else n)
                self.sent += len(b); cur['pct'] = int(self.sent * 100 / max(1, size))
                return b
        with open(out, 'rb') as f:
            r = SESSION.post(f'{self.cfg["server"]}/api/worker/compress-upload?id={job["id"]}', data=Reader(f),
                             headers={'Authorization': 'Bearer ' + self.cfg['token'], 'X-Out-Ext': spec['outExt'],
                                      'X-Worker-Compress': '1'}, timeout=3600)
        self._cleanup(out)
        try:
            res = r.json()
        except Exception:
            raise RuntimeError(f'servidor respondeu {r.status_code}')
        if r.status_code >= 400:
            raise RuntimeError(res.get('error') or f'servidor respondeu {r.status_code}')
        if res.get('status') == 'done':
            self.done += 1; self.saved += max(0, int(job.get('size') or 0) - int(res.get('newSize') or 0))
            self.say(f'✓ {job["name"]} comprimido: {fmt_size(job.get("size"))} → {fmt_size(res.get("newSize"))}')
        elif res.get('status') == 'skipped':
            self.say(f'• {job["name"]}: não ficou menor — o original foi mantido')
        else:
            self.failed += 1
            self.say(f'✗ {job["name"]}: {res.get("error")}')

    @staticmethod
    def _cleanup(path):
        try: os.remove(path)
        except Exception: pass


def fmt_size(b):
    b = float(b or 0)
    for u in ('B', 'KB', 'MB', 'GB', 'TB'):
        if b < 1024 or u == 'TB':
            return f'{b:.0f} {u}' if u in ('B', 'KB') else f'{b:.1f} {u}'
        b /= 1024
