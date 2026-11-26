"""Zima Video — Ajudante: compressão de vídeos no PC.

O app (Zima Video → selecionar vídeos/pasta → Comprimir) coloca vídeos numa fila. Este módulo pega um por
vez, comprime aqui no PC e manda o arquivo pronto de volta; o servidor confere e coloca no lugar do original
(mesmo nome, pasta e data; o original vai para a Lixeira).

Como escolhe a compressão (ideia do "per-title encoding" da Netflix e do ab-av1):
  1. Copia alguns trechos curtos do vídeo (sem recomprimir).
  2. Comprime esses trechos com ajustes diferentes e mede a qualidade com VMAF (métrica da Netflix;
     95 ≈ visualmente igual ao original). Uma busca binária interpolada acha o ajuste MAIS ECONÔMICO
     que ainda atinge a nota alvo — cada vídeo recebe o ajuste que precisa (desenho animado e cena
     parada comprimem muito; filme granulado, menos).
  3. Se nem assim o vídeo ficaria pelo menos 15% menor, pula (não gasta horas à toa).
  4. Comprime o vídeo inteiro com o ajuste escolhido.

Codificadores: placa de vídeo quando dá (AMD AMF — AV1 nas RX 7000/9000 —, NVIDIA NVENC, Intel QSV),
com os ajustes de qualidade recomendados pelos fabricantes; ou o processador (SVT-AV1, x265, x264) com
os ajustes dos guias da comunidade de codificação. Sempre 10 bits em AV1/H.265 quando o codificador aceita.

Respeita o nível de uso do PC: comprime nos níveis Médio e Máximo; no Leve/Pausado congela.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

from faces import readable_error
from zima_worker import IS_WIN, NOWINDOW, PRIO_FLAGS, SESSION, api, ffmpeg_path

try:
    import psutil  # congelar/continuar o ffmpeg quando você volta a usar o PC
except Exception:  # pragma: no cover
    psutil = None

GPU_ENC = {'av1': ['av1_amf', 'av1_nvenc', 'av1_qsv'], 'hevc': ['hevc_amf', 'hevc_nvenc', 'hevc_qsv'], 'h264': ['h264_amf', 'h264_nvenc', 'h264_qsv']}
# pelo processador: primeiro o mais rápido/eficiente; os outros são reserva (alguns ffmpeg não têm todos)
CPU_ENC = {'av1': ['libsvtav1', 'libaom-av1', 'librav1e'], 'hevc': ['libx265'], 'h264': ['libx264']}
ENC_NAMES = {'amf': 'placa AMD', 'nvenc': 'placa NVIDIA', 'qsv': 'Intel Quick Sync', 'libsvtav1': 'processador (SVT-AV1)',
             'libaom-av1': 'processador (libaom)', 'librav1e': 'processador (rav1e)',
             'libx265': 'processador (x265)', 'libx264': 'processador (x264)'}
# faixa de busca do "q" (escala tipo CRF: maior = arquivo menor) e ponto de partida relativo ao alvo do servidor
Q_RANGE = {'av1': (14, 55), 'hevc': (12, 38), 'h264': (12, 36)}
MIN_SAVING = 0.15       # pula se ficaria menos de 15% menor
MAX_STEPS = 6           # medições na busca de qualidade
LOW_MARGIN = 3.0        # os 5% piores momentos podem ficar no máximo 3 pontos abaixo do alvo
MAX_ABOVE = 10          # o ajuste não passa de "típico do nível + 10" (o VMAF quase não pune perda de grão de filme)


def explain_ff_error(text, rc=None):
    """A linha do ffmpeg que realmente explica a falha (a última costuma ser genérica: "Nothing was written…")."""
    lines = [re.sub(r'^\[[^\]]*@ 0x[0-9a-f]+\]\s*', '', x).strip() for x in text.strip().splitlines() if x.strip()]
    generic = re.compile(r'Nothing was written|Error while opening encoder|Conversion failed|Could not open encoder before EOF|Terminating thread|Task finished', re.I)
    useful = re.compile(r'error|fail|unknown|not (supported|available|found|initiali)|invalid|unsupported|could not|cannot|no device|DLL|driver', re.I)
    best = [x for x in lines if useful.search(x) and not generic.search(x)]
    pick = best[0] if best else next((x for x in reversed(lines) if not generic.search(x)), lines[-1] if lines else f'código {rc}')
    return pick[:180]


def enc_label(enc):
    for k, v in ENC_NAMES.items():
        if k in enc:
            return v
    return enc


def venc_args(enc, codec, q, gop=240, variant=0, fast=False, best=False, src10=False):
    """Parâmetros do codificador. variant 0 = completo (10 bits e recursos de qualidade);
    1 = básico (para placas/drivers que recusam algum recurso).
    best = qualidade em primeiro lugar (padrão na compressão de verdade: mais lento, não estraga o vídeo);
    fast = trechos de teste da medição."""
    q = int(round(q)); g = str(int(gop or 240))
    # 10 bits no modo caprichado (menos faixas/degraus nas sombras) ou quando o vídeo já é 10 bits (HDR)
    pix = 'yuv420p10le' if (best or src10) else 'yuv420p'
    if enc == 'libsvtav1':
        out = ['-c:v', enc, '-crf', str(q), '-preset', '6' if best else '8', '-g', g, '-pix_fmt', pix]
        if variant == 0: out += ['-svtav1-params', 'tune=0' + (':enable-variance-boost=1:enable-overlays=1:scd=1' if best else '')]
        return out
    if enc == 'libaom-av1':
        return ['-c:v', enc, '-crf', str(q), '-b:v', '0', '-cpu-used', '4' if best else '6', '-row-mt', '1', '-tiles', '2x2', '-g', g, '-pix_fmt', pix]
    if enc == 'librav1e':
        return ['-c:v', enc, '-qp', str(min(255, q * 4)), '-speed', '6' if best else '8', '-g', g, '-pix_fmt', pix]
    if enc == 'libx265':
        return ['-c:v', enc, '-crf', str(q), '-preset', 'fast' if fast else ('slow' if best else 'medium'), '-tag:v', 'hvc1', '-pix_fmt', pix,
                '-x265-params', f'log-level=error:aq-mode=3:no-sao=1:keyint={g}']
    if enc == 'libx264':
        return ['-c:v', enc, '-crf', str(q), '-preset', 'slow' if best else 'medium', '-g', g, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-aq-mode', '3']
    tenbit = variant == 0 and codec != 'h264'
    if enc.endswith('_amf'):
        qp = min(255, q * 4) if codec == 'av1' else q   # AV1 na AMD usa escala 0–255
        qp_p = min(255, qp + 8) if codec == 'av1' else qp + 2
        out = ['-c:v', enc, '-usage', 'transcoding', '-rc', 'cqp', '-qp_i', str(qp), '-qp_p', str(qp_p), '-g', g]
        if variant == 0:
            out += ['-quality', 'high_quality' if (codec == 'av1' and best) else 'quality']
            if codec == 'av1': out += ['-aq_mode', 'caq']
            else: out += ['-high_motion_quality_boost_enable', '1']
        out += ['-pix_fmt', 'p010le' if tenbit else 'nv12']
        if tenbit and codec == 'hevc': out += ['-profile:v', 'main10']
    elif enc.endswith('_nvenc'):
        out = ['-c:v', enc, '-preset', 'p6' if best else 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', str(q), '-b:v', '0', '-g', g]
        if variant == 0: out += ['-spatial-aq', '1'] + (['-temporal-aq', '1', '-rc-lookahead', '32'] if best else [])
        out += ['-pix_fmt', 'p010le' if tenbit else 'yuv420p']
        if tenbit and codec == 'hevc': out += ['-profile:v', 'main10']
    else:  # _qsv
        out = ['-c:v', enc, '-global_quality', str(q), '-preset', 'slower' if best else 'medium', '-g', g]
        if variant == 0 and best: out += ['-look_ahead_depth', '40']
        out += ['-pix_fmt', 'p010le' if tenbit else 'nv12']
    if codec == 'hevc':
        out += ['-tag:v', 'hvc1']
    return out


def start_q(enc, codec, crf):
    """Ponto de partida da busca: o ajuste típico do nível; placas de vídeo precisam de um pouco mais de qualidade."""
    return crf - (2 if not enc.startswith('lib') else 0)


class Compressor:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self.on_event = on_event or (lambda k, d: None)
        self.level = 'maximo'
        self.ff = None
        self.ok_enc = {}           # (codificador, formato) → variante que funciona neste PC (ou None)
        self.enc_err = {}          # (codificador, formato) → por que falhou no teste
        self.has_vmaf = None
        self.thread = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.proc = None
        self.current = None
        self.done = 0; self.saved = 0; self.failed = 0; self.skipped = 0

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

    def _run_ff(self, cmd, cwd=None, timeout=3600):
        """ffmpeg curto (amostras/medições), com prioridade baixa e interrompível."""
        flags = NOWINDOW | (PRIO_FLAGS['below'] if IS_WIN else 0)
        p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=cwd, creationflags=flags)
        self.proc = p
        try:
            _, err = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill(); _, err = p.communicate()
        self.proc = None
        if self._stop.is_set():
            raise InterruptedError('ajudante fechado')
        return p.returncode, (err or b'').decode('utf-8', 'replace')

    def _wait_allowed(self):
        while not self.allowed() and not self._stop.is_set():
            if self.current and self.current.get('stage') != 'pausada':
                self.current['prev'] = self.current['stage']; self.current['stage'] = 'pausada'; self.emit('compress', self.current)
            time.sleep(2)
        if self.current and self.current.get('stage') == 'pausada':
            self.current['stage'] = self.current.get('prev', 'comprimindo'); self.emit('compress', self.current)
        if self._stop.is_set():
            raise InterruptedError('ajudante fechado')

    # --- codificadores disponíveis neste PC (testados de verdade com um vídeo minúsculo)
    def _variant(self, enc, codec):
        key = (enc, codec)
        if key not in self.ok_enc:
            self.ok_enc[key] = None
            for variant in (0, 1):
                # 1280x720: o AV1 das placas AMD recusa alturas que não são múltiplas de 16 (ex.: 360)
                cmd = [self.ff, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=0.5', '-frames:v', '10']
                cmd += venc_args(enc, codec, 30, 50, variant) + ['-f', 'null', '-']
                try:
                    r = subprocess.run(cmd, capture_output=True, timeout=90, creationflags=NOWINDOW)
                    ok = r.returncode == 0
                    if not ok:
                        self.enc_err[key] = explain_ff_error(r.stderr.decode('utf-8', 'replace'), r.returncode)
                except Exception as e:
                    ok = False; self.enc_err[key] = str(e)[:160]
                if ok:
                    self.ok_enc[key] = variant; self.enc_err.pop(key, None); break
        return self.ok_enc[key]

    def pick(self, codec, force_cpu=False):
        if self.use_gpu and not force_cpu:
            for enc in GPU_ENC.get(codec, []):
                v = self._variant(enc, codec)
                if v is not None:
                    return enc, v
        for cpu in CPU_ENC[codec]:
            v = self._variant(cpu, codec)
            if v is not None:
                return cpu, v
        return None, None

    def why_not(self, codec):
        """Por que nenhum codificador funcionou (para a mensagem de erro)."""
        encs = (GPU_ENC.get(codec, []) if self.use_gpu else []) + CPU_ENC[codec]
        return '; '.join(f'{e}: {self.enc_err[(e, codec)]}' for e in encs if (e, codec) in self.enc_err) or 'sem detalhes'

    def capabilities(self):
        """O que este PC consegue comprimir (o app mostra e o servidor não manda o que ele não consegue)."""
        caps = {}
        for codec in ('av1', 'hevc', 'h264'):
            enc, _ = self.pick(codec)
            caps[codec] = {'enc': enc, 'label': enc_label(enc) if enc else None, 'error': None if enc else self.why_not(codec)[:300]}
        return caps

    def _vmaf_ok(self):
        if self.has_vmaf is None:
            try:
                out = subprocess.run([self.ff, '-hide_banner', '-filters'], capture_output=True, timeout=30, creationflags=NOWINDOW).stdout.decode('utf-8', 'replace')
                self.has_vmaf = ' libvmaf ' in out
            except Exception:
                self.has_vmaf = False
        return self.has_vmaf

    # --- laço
    def _run(self):
        self.ff = ffmpeg_path()
        caps_sent = 0
        while not self._stop.is_set():
            if self.enabled and time.time() - caps_sent > 1800:
                try:
                    caps = self.capabilities()
                    self._api('POST', '/api/worker/compress-caps', json=caps)
                    caps_sent = time.time()
                    for c, x in caps.items():
                        self.say(f'Compressão {c.upper()}: ' + (f'pela {x["label"]}' if x['enc'] else f'indisponível ({x["error"]})'))
                except Exception:
                    pass
            if not self.allowed():
                self._sleep(5); continue
            try:
                job = self._api('GET', '/api/worker/compress-job', timeout=(10, 120))
            except Exception:
                self._sleep(60); continue
            if job.get('none'):
                self._sleep(60); continue
            tmpdir = tempfile.mkdtemp(prefix='zima-comprimir-')
            try:
                self._process(job, tmpdir)
            except InterruptedError:
                try: self._api('POST', '/api/worker/compress-fail', json={'id': job['id'], 'error': 'ajudante fechado', 'retry': True})
                except Exception: pass
            except Exception as e:  # nunca derruba o programa
                self.failed += 1
                msg = readable_error(e)
                self.say(f'✗ Compressão de {job.get("name")}: {msg}')
                self.emit('cdone', {'name': job.get('name'), 'status': 'failed', 'error': msg, 'before': job.get('size')})
                try: self._api('POST', '/api/worker/compress-fail', json={'id': job['id'], 'error': msg})
                except Exception: pass
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
                self.current = None; self.proc = None
                self.emit('compress', None)

    def _progress(self, job, **kw):
        """Avisa o servidor (e a janela). Devolve True se o vídeo foi cancelado no app."""
        if self.current: self.current.update(kw)
        self.emit('compress', self.current)
        try:
            r = self._api('POST', '/api/worker/compress-progress', json={'id': job['id'], 'pct': (self.current or {}).get('pct', 0),
                                                                         'speed': (self.current or {}).get('speed', ''), 'stage': (self.current or {}).get('stage')})
            return bool(r.get('cancel'))
        except Exception:
            return False

    def _input_args(self, url):
        return ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
                '-headers', f'Authorization: Bearer {self.cfg["token"]}\r\n', '-i', url]

    # --- busca de qualidade com VMAF
    def _samples(self, url, dur, tmpdir):
        """Trechos do vídeo copiados sem recomprimir (bem rápido): 1 trecho para vídeos curtos, 3–4 para longos."""
        if dur <= 30:
            points, length = [0.0], dur
        else:
            n = 3 if dur < 900 else 4
            length = 5 if dur < 900 else 6
            points = [dur * (i + 1) / (n + 1) for i in range(n)]
        out = []
        for i, t in enumerate(points):
            f = os.path.join(tmpdir, f'amostra{i}.mkv')
            cmd = [self.ff, '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{t:.2f}', *self._input_args(url),
                   '-t', f'{length:.2f}', '-map', '0:v:0', '-c', 'copy', '-an', '-sn', '-dn', f]
            rc, _ = self._run_ff(cmd, timeout=300)
            if rc == 0 and os.path.exists(f) and os.path.getsize(f) > 1000:
                out.append(f)
        return out

    def _measure(self, samples, enc, variant, codec, q, v, tmpdir):
        """Comprime as amostras com o ajuste q e mede: (nota VMAF média, tamanho novo ÷ tamanho original)."""
        scores = []; lows = []; new = 0; old = 0
        vf = []
        if v.get('scale'):
            vf = ['-vf', f'scale={v["scale"]}:-2' if v.get('portrait') else f'scale=-2:{v["scale"]}']
        threads = max(1, (os.cpu_count() or 4) - 1)
        for i, sm in enumerate(samples):
            self._wait_allowed()
            enc_f = os.path.join(tmpdir, f'teste{i}.mkv')
            rc, err = self._run_ff([self.ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', sm, *vf,
                                    *venc_args(enc, codec, q, v.get('gop'), variant, fast=True, src10=v.get('tenbit')), '-an', enc_f], timeout=1800)
            if rc != 0 or not os.path.exists(enc_f):
                raise RuntimeError(f'teste de compressão falhou: {(err.strip().splitlines() or ["?"])[-1][:150]}')
            # VMAF: o trecho comprimido é ampliado para o tamanho do original (padrão da métrica)
            lav = ('[0:v][1:v]scale=rw:rh:flags=bicubic[d0];[d0]format=yuv420p,setpts=PTS-STARTPTS[d];'
                   f'[1:v]format=yuv420p,setpts=PTS-STARTPTS[r];[d][r]libvmaf=n_subsample=4:n_threads={threads}:log_fmt=json:log_path=vmaf.json')
            log = os.path.join(tmpdir, 'vmaf.json')
            try: os.remove(log)
            except Exception: pass
            rc, err = self._run_ff([self.ff, '-hide_banner', '-loglevel', 'error', '-i', os.path.basename(enc_f), '-i', os.path.basename(sm),
                                    '-lavfi', lav, '-f', 'null', '-'], cwd=tmpdir, timeout=1800)
            try:
                with open(log, encoding='utf-8') as f:
                    j = json.load(f)
                scores.append(float(j['pooled_metrics']['vmaf']['mean']))
                fr = sorted(float(x['metrics']['vmaf']) for x in j.get('frames', []) if 'vmaf' in x.get('metrics', {}))
                lows.append(fr[len(fr) // 20] if fr else scores[-1])
            except Exception:
                raise RuntimeError(f'medição de qualidade falhou: {(err.strip().splitlines() or ["?"])[-1][:150]}')
            new += os.path.getsize(enc_f); old += os.path.getsize(sm)
        # a nota que vale é a do trecho mais difícil puxada pela média (um trecho ruim não pode passar despercebido)
        score = 0.6 * (sum(scores) / len(scores)) + 0.4 * min(scores)
        return score, min(lows), new / max(1, old)

    def _search(self, job, samples, enc, variant, codec, v, tmpdir):
        """Busca binária interpolada (como o ab-av1): acha o maior ajuste (arquivo menor) cuja nota média
        atinge o alvo E cujos 5% piores momentos não caem mais que LOW_MARGIN abaixo dele."""
        target = float(v.get('vmaf') or 95)
        lo, hi = Q_RANGE[codec]
        q0 = max(lo, min(hi, start_q(enc, codec, v['crf'])))
        hi = min(hi, q0 + MAX_ABOVE)
        q = q0
        seen = {}; good = None; bad = None; up = 3
        ok = lambda r: r[0] >= target and r[1] >= target - LOW_MARGIN  # noqa: E731
        for step in range(MAX_STEPS):
            if self._progress(job, stage='medindo qualidade', pct=int(step * 100 / MAX_STEPS), speed=''):
                raise RuntimeError('cancelado no app')
            seen[q] = self._measure(samples, enc, variant, codec, q, v, tmpdir)
            s_, low, r = seen[q]
            self.say(f'   teste: ajuste {q} → VMAF {s_:.1f} (piores momentos {low:.1f}), {r * 100:.0f}% do tamanho')
            if ok(seen[q]):
                good = q if good is None or q > good else good
            else:
                bad = q if bad is None or q < bad else bad
            if good is not None and bad is not None:
                if bad - good <= 1:
                    break
                # interpola pela folga até o alvo (média e piores momentos — o que for mais apertado)
                gs, gl, _ = seen[good]; bs, bl, _ = seen[bad]
                fm = (gs - target) / max(1e-6, gs - bs); fl = (gl - target + LOW_MARGIN) / max(1e-6, gl - bl)
                frac = max(0.0, min(fm, fl))
                nq = max(good + 1, min(bad - 1, int(round(good + frac * (bad - good)))))
            elif good is not None:   # ainda sobra qualidade: comprime mais (passos crescentes)
                nq = min(hi, good + up); up *= 2
                if nq == good: break
            else:                    # qualidade abaixo do alvo: comprime menos
                nq = max(lo, bad - up); up *= 2
                if nq == bad: break
            if nq in seen:
                break
            q = nq
        if good is not None:
            return good, seen[good][0], seen[good][2], True
        best = min(seen)  # nem no melhor ajuste testado chegou no alvo: usa o de mais qualidade
        return best, seen[best][0], seen[best][2], False

    def _process(self, job, tmpdir, force_cpu=False):
        spec = job['spec']; v = spec['v']; codec = v['codec']
        enc, variant = self.pick(codec, force_cpu)
        if not enc:
            raise RuntimeError(f'este PC não conseguiu usar nenhum codificador de {codec.upper()} ({self.why_not(codec)})')
        self.current = {'name': job['name'], 'pct': 0, 'enc': enc_label(enc), 'stage': 'preparando', 'speed': '', 'eta': None,
                        'codec': codec, 'size': job.get('size'), 'started': time.time(), 'vmaf': None, 'q': None}
        self.emit('compress', self.current)
        url = self.cfg['server'] + job['url']
        dur = max(1.0, float(job.get('duration') or 1))
        q = start_q(enc, codec, v['crf']); vmaf = None
        # 1) busca de qualidade nos trechos
        measure = bool(v.get('measure'))
        if measure and self._vmaf_ok():
            self.say(f'Medindo a qualidade de {job["name"]} ({codec.upper()} pela {enc_label(enc)}, alvo VMAF {v.get("vmaf", 95)})…')
            samples = self._samples(url, dur, tmpdir)
            if samples:
                try:
                    q, vmaf, ratio, reached = self._search(job, samples, enc, variant, codec, v, tmpdir)
                except RuntimeError as e:
                    if not enc.startswith('lib') and not force_cpu and 'cancelado' not in str(e):
                        self.say(f'A {enc_label(enc)} falhou no teste ({e}); tentando pelo processador.')
                        self.ok_enc[(enc, codec)] = None
                        return self._process(job, tmpdir, force_cpu=True)
                    raise
                for f in os.listdir(tmpdir):
                    if f.startswith(('amostra', 'teste')):
                        try: os.remove(os.path.join(tmpdir, f))
                        except Exception: pass
                self.current.update(vmaf=round(vmaf, 1), q=q)
                saving = 1 - ratio
                min_saving = float(v.get('minSave', MIN_SAVING))   # escolhida no app (slider)
                if v.get('force') and (saving < min_saving or not reached):
                    # "comprimir mesmo se não atingir o padrão": não pula. Se nenhum ajuste chegou no alvo, usa o
                    # ajuste típico do nível (como sem a medição); o servidor só troca se ficar menor que o original.
                    if not reached:
                        q = start_q(enc, codec, v['crf'])
                        vmaf = None; self.current.update(vmaf=None, q=q)  # a nota medida era de outro ajuste
                    self.say(f'   não atingiu o padrão, mas comprimindo mesmo assim (opção marcada no app): ajuste {q}')
                elif saving < min_saving:
                    note = (f'não compensa: para manter a qualidade (VMAF {vmaf:.0f}) ficaria só {max(0, saving) * 100:.0f}% menor (mínimo escolhido: {min_saving * 100:.0f}%)'
                            if reached else f'não compensa: nem com o ajuste de mais qualidade chegou no alvo (VMAF {vmaf:.0f})')
                    self.skipped += 1
                    self.say(f'• {job["name"]}: {note}')
                    self._api('POST', '/api/worker/compress-fail', json={'id': job['id'], 'skip': True, 'note': note, 'vmaf': round(vmaf, 1)})
                    self.emit('cdone', {'name': job['name'], 'codec': codec, 'enc': enc_label(enc), 'before': job.get('size'), 'after': job.get('size'),
                                        'secs': int(time.time() - self.current['started']), 'status': 'skipped', 'note': note, 'vmaf': round(vmaf, 1)})
                    return
                if vmaf is not None:
                    self.say(f'   escolhido: ajuste {q} (VMAF {vmaf:.1f}), deve ficar ~{saving * 100:.0f}% menor')
        elif measure:
            self.say('Este ffmpeg não mede VMAF; usando o ajuste típico do nível de qualidade.')
        # 2) compressão completa
        out = os.path.join(tmpdir, f'{job["id"]}{spec["outExt"]}')
        vf = []
        if v.get('scale'):
            vf = ['-vf', f'scale={v["scale"]}:-2' if v.get('portrait') else f'scale=-2:{v["scale"]}']
        hw = ['-hwaccel', 'auto'] if not enc.startswith('lib') else []   # decodifica na placa e libera o processador
        cmd = [self.ff, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', *hw, *self._input_args(url),
               *spec['maps'], *vf, *venc_args(enc, codec, q, v.get('gop'), variant, best=True, src10=v.get('tenbit')), *spec['post'], '-progress', 'pipe:1', '-nostats', out]
        self.say(f'Comprimindo {job["name"]} ({codec.upper()} pela {enc_label(enc)}, ajuste {q})…')
        self.current.update(stage='comprimindo', pct=0)
        flags = NOWINDOW | (PRIO_FLAGS['below'] if IS_WIN else 0)
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
        self.proc = p
        err = []
        threading.Thread(target=lambda: err.append(p.stderr.read().decode('utf-8', 'replace')), daemon=True).start()
        last_post = 0; paused = False; cancelled = False
        for raw in iter(p.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').strip()
            m = re.match(r'out_time_(?:us|ms)=(\d+)', line)
            if m:
                self.current['pct'] = min(99, int(int(m.group(1)) / 1e6 / dur * 100))
            m = re.match(r'speed=\s*([\d.]+)x', line)
            if m:
                sp = float(m.group(1))
                self.current['speed'] = f'{sp:.1f}x'
                if sp > 0:  # tempo que falta = parte do vídeo que falta ÷ velocidade
                    self.current['eta'] = int(dur * (100 - self.current['pct']) / 100 / sp)
            if time.time() - last_post > 5:
                last_post = time.time()
                if self._progress(job):
                    cancelled = True; p.kill(); break
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
        rc = p.wait(); self.proc = None
        if self._stop.is_set():
            raise InterruptedError('ajudante fechado')
        if cancelled:
            self.say(f'Compressão de {job["name"]} cancelada no app.'); return
        if rc != 0:
            msg = (''.join(err).strip().splitlines() or [f'código {rc}'])[-1][:200]
            if not enc.startswith('lib') and not force_cpu:
                # a placa recusou este vídeo: faz pelo processador
                self.say(f'A {enc_label(enc)} não conseguiu comprimir ({msg}); tentando pelo processador.')
                self.ok_enc[(enc, codec)] = None
                return self._process(job, tmpdir, force_cpu=True)
            raise RuntimeError(f'ffmpeg: {msg}')
        # 3) envia o arquivo pronto
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
        headers = {'Authorization': 'Bearer ' + self.cfg['token'], 'X-Out-Ext': spec['outExt'], 'X-Worker-Compress': '1',
                   'X-Enc': f'{enc_label(enc)} · ajuste {q}'}
        if vmaf is not None: headers['X-Vmaf'] = f'{vmaf:.2f}'
        with open(out, 'rb') as f:
            r = SESSION.post(f'{self.cfg["server"]}/api/worker/compress-upload?id={job["id"]}', data=Reader(f), headers=headers, timeout=3600)
        try:
            res = r.json()
        except Exception:
            raise RuntimeError(f'servidor respondeu {r.status_code}')
        if r.status_code >= 400:
            raise RuntimeError(res.get('error') or f'servidor respondeu {r.status_code}')
        rec = {'name': job['name'], 'codec': codec, 'enc': enc_label(enc), 'before': job.get('size'), 'after': res.get('newSize'),
               'secs': int(time.time() - self.current['started']), 'status': res.get('status'), 'error': res.get('error'),
               'vmaf': round(vmaf, 1) if vmaf is not None else None, 'q': q}
        if res.get('status') == 'done':
            self.done += 1; self.saved += max(0, int(job.get('size') or 0) - int(res.get('newSize') or 0))
            self.say(f'✓ {job["name"]} comprimido: {fmt_size(job.get("size"))} → {fmt_size(res.get("newSize"))}'
                     + (f' (VMAF {vmaf:.1f})' if vmaf is not None else ''))
        elif res.get('status') == 'skipped':
            self.skipped += 1
            self.say(f'• {job["name"]}: não ficou menor — o original foi mantido')
        else:
            self.failed += 1
            self.say(f'✗ {job["name"]}: {res.get("error")}')
        self.emit('cdone', rec)


def fmt_size(b):
    b = float(b or 0)
    for u in ('B', 'KB', 'MB', 'GB', 'TB'):
        if b < 1024 or u == 'TB':
            return f'{b:.0f} {u}' if u in ('B', 'KB') else f'{b:.1f} {u}'
        b /= 1024
