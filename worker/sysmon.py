"""Uso do sistema para a janela do ajudante: processador, memória e placa de vídeo.

Processador e memória: psutil. Placa de vídeo (Windows): os mesmos contadores de desempenho que o
Gerenciador de Tarefas usa ("GPU Engine" e "GPU Adapter Memory"), lidos pela API PDH do Windows.
Mostra o total e a parte do ajudante (ele + os ffmpeg que ele abre). Se algo não estiver disponível,
aquele item simplesmente não aparece — nunca derruba o programa.
"""
import os
import re
import time

try:
    import psutil
except Exception:  # pragma: no cover
    psutil = None

IS_WIN = os.name == 'nt'
ENGINE_NAMES = {'3D': '3D', 'Compute': 'Análise (Compute)', 'VideoEncode': 'Codificação de vídeo',
                'VideoDecode': 'Decodificação de vídeo', 'Copy': 'Cópia'}


class _Pdh:
    """Contadores de GPU do Windows via pdh.dll (sem programas extras)."""
    PDH_MORE_DATA = 0x800007D2
    FMT = 0x00000200 | 0x00008000  # PDH_FMT_DOUBLE | PDH_FMT_NOCAP100

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ct = ctypes
        self.pdh = ctypes.WinDLL('pdh')

        class VAL(ctypes.Structure):
            _fields_ = [('CStatus', wintypes.DWORD), ('pad', wintypes.DWORD), ('doubleValue', ctypes.c_double)]

        class ITEM(ctypes.Structure):
            _fields_ = [('szName', wintypes.LPWSTR), ('FmtValue', VAL)]
        self.ITEM = ITEM
        self._open()

    def _open(self):
        ct = self.ct
        self.q = ct.c_void_p(); self.c_eng = ct.c_void_p(); self.c_mem = ct.c_void_p()
        if self.pdh.PdhOpenQueryW(None, 0, ct.byref(self.q)) != 0:
            raise OSError('PdhOpenQuery')
        add = self.pdh.PdhAddEnglishCounterW
        if add(self.q, '\\GPU Engine(*)\\Utilization Percentage', 0, ct.byref(self.c_eng)) != 0:
            raise OSError('sem contadores de GPU')
        if add(self.q, '\\GPU Adapter Memory(*)\\Dedicated Usage', 0, ct.byref(self.c_mem)) != 0:
            self.c_mem = None
        self.pdh.PdhCollectQueryData(self.q)
        self.opened = time.time()

    def close(self):
        try: self.pdh.PdhCloseQuery(self.q)
        except Exception: pass

    def _array(self, counter):
        ct = self.ct
        size = ct.c_ulong(0); count = ct.c_ulong(0)
        r = self.pdh.PdhGetFormattedCounterArrayW(counter, self.FMT, ct.byref(size), ct.byref(count), None)
        if (r & 0xFFFFFFFF) != self.PDH_MORE_DATA or not size.value:
            return []
        buf = (ct.c_byte * size.value)()
        r = self.pdh.PdhGetFormattedCounterArrayW(counter, self.FMT, ct.byref(size), ct.byref(count), buf)
        if r != 0:
            return []
        items = ct.cast(buf, ct.POINTER(self.ITEM))
        out = []
        for i in range(count.value):
            it = items[i]
            if it.FmtValue.CStatus in (0, 1):  # PDH_CSTATUS_VALID_DATA / NEW_DATA
                out.append((it.szName or '', float(it.FmtValue.doubleValue)))
        return out

    def read(self, pids):
        # processos vêm e vão: refaz a consulta de tempos em tempos para enxergar os novos
        if time.time() - self.opened > 60:
            self.close(); self._open(); time.sleep(0.05)
        self.pdh.PdhCollectQueryData(self.q)
        eng = {}; mine = {}
        for name, v in self._array(self.c_eng):
            m = re.match(r'pid_(\d+)_luid_(\w+)_phys_(\d+)_eng_(\d+)_engtype_(\w+)', name)
            if not m:
                continue
            pid, luid, phys, idx, typ = int(m.group(1)), m.group(2), m.group(3), m.group(4), m.group(5)
            key = (luid, phys, idx, typ)
            eng[key] = eng.get(key, 0.0) + v
            if pid in pids:
                mine[typ] = mine.get(typ, 0.0) + v
        by_type = {}
        for (_, _, _, typ), v in eng.items():
            by_type[typ] = max(by_type.get(typ, 0.0), min(100.0, v))
        mem = None
        if self.c_mem:
            vals = [v for _, v in self._array(self.c_mem)]
            mem = max(vals) if vals else None
        return {'total': max(by_type.values()) if by_type else 0.0, 'types': by_type,
                'mine': {k: min(100.0, v) for k, v in mine.items()}, 'mem': mem}


class SysMon:
    def __init__(self):
        self.proc = psutil.Process() if psutil else None
        self.gpu = None; self.gpu_err = None
        if IS_WIN:
            try:
                self.gpu = _Pdh()
            except Exception as e:  # sem contadores (Windows antigo/driver)
                self.gpu_err = str(e)
        if psutil:
            psutil.cpu_percent(None)
            try: self.proc.cpu_percent(None)
            except Exception: pass
        self._child_cpu = {}

    def _my_procs(self):
        if not self.proc:
            return []
        try:
            return [self.proc] + self.proc.children(recursive=True)
        except Exception:
            return [self.proc]

    def read(self):
        out = {}
        if psutil:
            ncpu = psutil.cpu_count() or 1
            out['cpu'] = psutil.cpu_percent(None)
            vm = psutil.virtual_memory()
            out['mem'] = vm.percent; out['mem_total'] = vm.total
            mine_cpu = 0.0; mine_mem = 0
            seen = {}
            for p in self._my_procs():
                try:
                    c = self._child_cpu.get(p.pid)
                    if c is None:
                        c = p; p.cpu_percent(None); self._child_cpu[p.pid] = p
                        v = 0.0
                    else:
                        v = c.cpu_percent(None)
                    mine_cpu += v; mine_mem += p.memory_info().rss
                    seen[p.pid] = c
                except Exception:
                    pass
            self._child_cpu = seen
            out['cpu_mine'] = min(100.0, mine_cpu / ncpu)
            out['mem_mine'] = mine_mem
            pids = set(seen)
        else:
            pids = {os.getpid()}
        if self.gpu:
            try:
                out['gpu'] = self.gpu.read(pids)
            except Exception as e:
                self.gpu_err = str(e); self.gpu = None
        return out


def fmt_bytes(b):
    b = float(b or 0)
    for u in ('B', 'KB', 'MB', 'GB', 'TB'):
        if b < 1024 or u == 'TB':
            return f'{b:.0f} {u}' if u in ('B', 'KB', 'MB') else f'{b:.1f} {u}'
        b /= 1024
