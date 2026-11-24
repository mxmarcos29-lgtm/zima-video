"""Zima Video — Ajudante (janela).

Analisa os rostos dos vídeos usando o seu PC e deixa você decidir quanto do PC ele pode usar:
  • Automático: pouco (ou nada) enquanto você usa o PC, e o máximo quando o PC fica parado;
    pausa sozinho em jogos/filmes em tela cheia e na bateria do notebook.
  • Fixo: um nível escolhido por você (Pausado, Leve, Médio ou Máximo).
Fica na bandeja do Windows (perto do relógio) quando a janela é fechada.

Abrir:  ajudante.pyw   (duplo clique, ou pelo atalho criado na instalação)
        ajudante.pyw --bandeja   (abre já escondido na bandeja — usado ao iniciar com o Windows)
"""
import os
import queue
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

# sem console (pythonw): os avisos vão para um arquivo
if sys.stdout is None or sys.stderr is None:
    _logf = open(os.path.join(HERE, 'ajudante.log'), 'a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = _logf

import zima_worker as zw  # noqa: E402
import compressor as zc  # noqa: E402
import sysmon  # noqa: E402
import json  # noqa: E402

IS_WIN = os.name == 'nt'
APP = 'Zima Video — Ajudante'
SINGLE_PORT = 47913          # só uma cópia aberta por vez (a segunda só traz a primeira para frente)
LEVEL_NAMES = {k: v['nome'] for k, v in zw.LEVELS.items()}
NAME_TO_LEVEL = {v: k for k, v in LEVEL_NAMES.items()}

DEFAULTS = {
    'mode': 'auto',            # auto | fixo
    'fixed_level': 'medio',
    'busy_level': 'leve',      # enquanto você usa o PC
    'idle_level': 'maximo',    # com o PC parado
    'idle_minutes': 5,
    'pause_fullscreen': True,
    'pause_battery': True,
    'close_to_tray': True,
    'compress': True,          # comprimir os vídeos pedidos no app (nos níveis Médio e Máximo)
    'compress_gpu': True,      # usar a placa de vídeo para comprimir (bem mais rápido)
}


# ---------------------------------------------------------------- o que o PC está fazendo (Windows)
def idle_seconds():
    """Há quanto tempo ninguém mexe no mouse/teclado."""
    if IS_WIN:
        try:
            import ctypes

            class LASTINPUTINFO(ctypes.Structure):
                _fields_ = [('cbSize', ctypes.c_uint), ('dwTime', ctypes.c_uint)]
            li = LASTINPUTINFO(); li.cbSize = ctypes.sizeof(li)
            if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(li)):
                return max(0, (ctypes.windll.kernel32.GetTickCount() - li.dwTime) & 0xFFFFFFFF) / 1000.0
        except Exception:
            pass
        return 0.0
    # outros sistemas (testes): variável de ambiente ou xprintidle
    if os.environ.get('ZV_IDLE'):
        return float(os.environ['ZV_IDLE'])
    try:
        return int(subprocess.check_output(['xprintidle'], stderr=subprocess.DEVNULL)) / 1000.0
    except Exception:
        return 0.0


def fullscreen_busy():
    """Jogo, filme ou apresentação em tela cheia (o Windows chama de 'não incomodar')."""
    if not IS_WIN:
        return os.environ.get('ZV_FULLSCREEN') == '1'
    try:
        import ctypes
        state = ctypes.c_int(0)
        if ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state)) == 0:
            return state.value in (2, 3, 4)  # ocupado em tela cheia / jogo Direct3D / modo apresentação
    except Exception:
        pass
    return False


def on_battery():
    if not IS_WIN:
        return os.environ.get('ZV_BATTERY') == '1'
    try:
        import ctypes

        class SPS(ctypes.Structure):
            _fields_ = [('ACLineStatus', ctypes.c_byte), ('BatteryFlag', ctypes.c_byte), ('BatteryLifePercent', ctypes.c_byte),
                        ('SystemStatusFlag', ctypes.c_byte), ('BatteryLifeTime', ctypes.c_ulong), ('BatteryFullLifeTime', ctypes.c_ulong)]
        s = SPS()
        if ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(s)):
            return s.ACLineStatus == 0 and s.BatteryFlag != -128  # 128 = sem bateria (desktop)
    except Exception:
        pass
    return False


# ---------------------------------------------------------------- iniciar com o Windows
def startup_link():
    return os.path.join(os.environ.get('APPDATA', ''), r'Microsoft\Windows\Start Menu\Programs\Startup\Zima Video Ajudante.lnk')


def pythonw():
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), 'pythonw.exe')
    return w if os.path.exists(w) else exe


def set_startup(on):
    if not IS_WIN:
        return False
    link = startup_link()
    if not on:
        try: os.remove(link)
        except FileNotFoundError: pass
        return True
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ZV_LINK); $s.TargetPath=$env:ZV_PY; "
          "$s.Arguments='\"' + $env:ZV_APP + '\" --bandeja'; $s.WorkingDirectory=$env:ZV_DIR; $s.Description='Zima Video Ajudante'; $s.Save()")
    env = dict(os.environ, ZV_LINK=link, ZV_PY=pythonw(), ZV_APP=os.path.join(HERE, 'ajudante.pyw'), ZV_DIR=HERE)
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], env=env, creationflags=zw.NOWINDOW, timeout=30)
    return os.path.exists(link)


# ---------------------------------------------------------------- ícone (desenhado, sem arquivo)
def make_icon(size=64, state='working'):
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None
    s = size
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = {'working': (124, 92, 255), 'paused': (120, 120, 130), 'offline': (229, 72, 77)}.get(state, (124, 92, 255))
    d.rounded_rectangle([2, 2, s - 3, s - 3], radius=s // 5, fill=color)
    d.polygon([(s * 0.38, s * 0.28), (s * 0.38, s * 0.72), (s * 0.74, s * 0.5)], fill=(255, 255, 255))
    if state == 'paused':
        d.rectangle([s * 0.62, s * 0.62, s * 0.7, s * 0.9], fill=(255, 255, 255))
        d.rectangle([s * 0.78, s * 0.62, s * 0.86, s * 0.9], fill=(255, 255, 255))
    return img


def fmt_dur(sec):
    sec = int(sec or 0)
    if sec < 60:
        return f'{sec} s'
    if sec < 3600:
        return f'{sec // 60} min' + (f' {sec % 60:02d} s' if sec < 600 else '')
    return f'{sec // 3600} h {sec % 3600 // 60:02d} min'


# ---------------------------------------------------------------- janela
class App:
    def __init__(self, root, start_hidden=False):
        self.root = root
        self.q = queue.Queue()
        self.cfg = zw.load_config()
        for k, v in DEFAULTS.items():
            self.cfg.setdefault(k, v)
        self.manual_pause = False
        self.state = {'state': 'starting'}
        self.server_progress = None
        self.tray = None
        self.helper = None
        self.last_level = None
        self.icon_state = None
        self._loading = True   # enquanto monta a janela, mudanças nos campos não são gravadas

        root.title(APP)
        root.minsize(500, 640)
        root.geometry('560x900')
        root.resizable(True, True)
        root.protocol('WM_DELETE_WINDOW', self.on_close)
        img = make_icon(64)
        if img is not None:
            try:
                from PIL import ImageTk
                self._icon = ImageTk.PhotoImage(img); root.iconphoto(True, self._icon)
            except Exception:
                pass
        self.build()
        self.load_form()
        self.load_history()
        self.root.after(800, self.tick_resources)
        self._loading = False
        self.start_tray()
        if start_hidden and self.tray:
            root.withdraw()
        self.root.after(200, self.poll)
        self.root.after(500, self.policy_tick)
        if not self.cfg.get('server') or not self.cfg.get('token'):
            if start_hidden:
                root.deiconify()
            self.root.after(300, lambda: self.connection_dialog(first=True))
        else:
            self.start_helper()

    # ---------------- layout
    def build(self):
        r = self.root
        st = ttk.Style()
        try:
            if IS_WIN: st.theme_use('vista')
        except Exception:
            pass
        st.configure('Big.TLabel', font=('Segoe UI', 13, 'bold'))
        st.configure('Muted.TLabel', foreground='#666')
        st.configure('Sec.TLabel', font=('Segoe UI', 10, 'bold'))
        st.configure('Small.TLabel', foreground='#666', font=('Segoe UI', 8))
        main = ttk.Frame(r, padding=(14, 10, 14, 10)); main.pack(fill='both', expand=True)

        # situação geral
        top = ttk.Frame(main); top.pack(fill='x')
        self.dot = tk.Canvas(top, width=14, height=14, highlightthickness=0); self.dot.pack(side='left', padx=(0, 8))
        self.dot_id = self.dot.create_oval(2, 2, 12, 12, fill='#999', outline='')
        self.lbl_state = ttk.Label(top, text='Iniciando…', style='Big.TLabel'); self.lbl_state.pack(side='left')

        # rostos
        fr = ttk.LabelFrame(main, text=' Rostos ', padding=(10, 4, 10, 8)); fr.pack(fill='x', pady=(8, 0))
        self.lbl_file = ttk.Label(fr, text='', style='Muted.TLabel'); self.lbl_file.pack(fill='x')
        self.pb = ttk.Progressbar(fr, mode='determinate', maximum=100); self.pb.pack(fill='x', pady=(2, 2))
        self.lbl_stats = ttk.Label(fr, text='', style='Muted.TLabel', justify='left', wraplength=500); self.lbl_stats.pack(fill='x')

        # compressão
        fc = ttk.LabelFrame(main, text=' Compressão ', padding=(10, 4, 10, 8)); fc.pack(fill='x', pady=(8, 0))
        self.lbl_cfile = ttk.Label(fc, text='', style='Muted.TLabel', wraplength=500); self.lbl_cfile.pack(fill='x')
        self.pbc = ttk.Progressbar(fc, mode='determinate', maximum=100); self.pbc.pack(fill='x', pady=(2, 2))
        self.lbl_cstats = ttk.Label(fc, text='', style='Muted.TLabel', justify='left', wraplength=500); self.lbl_cstats.pack(fill='x')

        # uso do sistema
        fs = ttk.LabelFrame(main, text=' Uso do sistema ', padding=(10, 4, 10, 8)); fs.pack(fill='x', pady=(8, 0))
        self.res = {}
        for i, (k, label) in enumerate((('cpu', 'Processador'), ('mem', 'Memória'), ('gpu', 'Placa de vídeo'), ('vram', 'Memória da placa'))):
            ttk.Label(fs, text=label).grid(row=i, column=0, sticky='w', pady=1)
            bar = ttk.Progressbar(fs, mode='determinate', maximum=100, length=150); bar.grid(row=i, column=1, sticky='we', padx=8)
            txt = ttk.Label(fs, text='—', style='Muted.TLabel'); txt.grid(row=i, column=2, sticky='w')
            self.res[k] = (bar, txt)
        fs.columnconfigure(1, weight=1)
        self.lbl_gpu_eng = ttk.Label(fs, text='', style='Small.TLabel'); self.lbl_gpu_eng.grid(row=4, column=0, columnspan=3, sticky='w', pady=(2, 0))

        # abas: configurações, atividade, histórico
        nb = ttk.Notebook(main); nb.pack(fill='both', expand=True, pady=(10, 0))
        self.nb = nb
        tab_cfg = ttk.Frame(nb, padding=8); tab_log = ttk.Frame(nb, padding=6); tab_hist = ttk.Frame(nb, padding=6)
        nb.add(tab_cfg, text='Uso do PC'); nb.add(tab_log, text='Atividade'); nb.add(tab_hist, text='Histórico')
        main = tab_cfg  # as configurações abaixo vão para a primeira aba
        # uso do PC
        box = ttk.LabelFrame(main, text=' Quanto do PC o ajudante pode usar ', padding=10); box.pack(fill='x')
        self.mode = tk.StringVar()
        mrow = ttk.Frame(box); mrow.pack(fill='x')
        ttk.Radiobutton(mrow, text='Automático (recomendado)', value='auto', variable=self.mode, command=self.on_form).pack(side='left')
        ttk.Radiobutton(mrow, text='Fixo', value='fixo', variable=self.mode, command=self.on_form).pack(side='left', padx=(16, 0))

        self.fr_auto = ttk.Frame(box); self.fr_auto.pack(fill='x', pady=(8, 0))
        g = self.fr_auto
        ttk.Label(g, text='Enquanto você usa o PC:').grid(row=0, column=0, sticky='w', pady=3)
        self.busy = ttk.Combobox(g, state='readonly', width=12, values=[LEVEL_NAMES[k] for k in ('pausado', 'leve', 'medio')])
        self.busy.grid(row=0, column=1, sticky='w', padx=6); self.busy.bind('<<ComboboxSelected>>', lambda e: self.on_form())
        ttk.Label(g, text='Quando o PC fica parado por').grid(row=1, column=0, sticky='w', pady=3)
        rowf = ttk.Frame(g); rowf.grid(row=1, column=1, sticky='w', padx=6)
        self.idle_min = tk.Spinbox(rowf, from_=1, to=120, width=4, command=self.on_form); self.idle_min.pack(side='left')
        self.idle_min.bind('<KeyRelease>', lambda e: self.on_form())
        ttk.Label(rowf, text='min:').pack(side='left', padx=(4, 6))
        self.idle = ttk.Combobox(rowf, state='readonly', width=10, values=[LEVEL_NAMES[k] for k in ('medio', 'maximo')])
        self.idle.pack(side='left'); self.idle.bind('<<ComboboxSelected>>', lambda e: self.on_form())
        self.v_full = tk.BooleanVar(); self.v_batt = tk.BooleanVar()
        ttk.Checkbutton(g, text='Pausar em jogos, filmes e apresentações em tela cheia', variable=self.v_full, command=self.on_form).grid(row=2, column=0, columnspan=2, sticky='w', pady=(6, 0))
        ttk.Checkbutton(g, text='Pausar quando o notebook estiver na bateria', variable=self.v_batt, command=self.on_form).grid(row=3, column=0, columnspan=2, sticky='w')

        self.fr_fixed = ttk.Frame(box)
        self.v_fixed = tk.IntVar()
        sc = ttk.Frame(self.fr_fixed); sc.pack(fill='x', pady=(8, 0))
        self.scale = ttk.Scale(sc, from_=0, to=3, orient='horizontal', command=self.on_scale); self.scale.pack(fill='x')
        lab = ttk.Frame(self.fr_fixed, height=20); lab.pack(fill='x', padx=6)
        for i, k in enumerate(zw.LEVEL_ORDER):  # cada nome embaixo da sua posição no controle
            ttk.Label(lab, text=LEVEL_NAMES[k], style='Muted.TLabel').place(relx=i / 3, y=0, anchor=('nw' if i == 0 else 'ne' if i == 3 else 'n'))

        self.lbl_now = ttk.Label(box, text='', font=('Segoe UI', 10, 'bold')); self.lbl_now.pack(fill='x', pady=(10, 0))
        self.lbl_help = ttk.Label(box, text='', style='Muted.TLabel', wraplength=420, justify='left'); self.lbl_help.pack(fill='x')

        # botões
        btns = ttk.Frame(main); btns.pack(fill='x', pady=(12, 0))
        self.btn_pause = ttk.Button(btns, text='Pausar', command=self.toggle_pause); self.btn_pause.pack(side='left')
        ttk.Button(btns, text='Conexão…', command=self.connection_dialog).pack(side='left', padx=6)
        ttk.Button(btns, text='Abrir o Zima Video', command=self.open_web).pack(side='left')

        opts = ttk.Frame(main); opts.pack(fill='x', pady=(10, 0))
        self.v_startup = tk.BooleanVar(value=IS_WIN and os.path.exists(startup_link()))
        cb = ttk.Checkbutton(opts, text='Abrir junto com o Windows (escondido na bandeja)', variable=self.v_startup, command=self.on_startup)
        cb.pack(anchor='w')
        if not IS_WIN: cb.state(['disabled'])
        self.v_tray = tk.BooleanVar()
        ttk.Checkbutton(opts, text='Ao fechar, continuar trabalhando na bandeja (perto do relógio)', variable=self.v_tray, command=self.on_form).pack(anchor='w')
        self.v_comp = tk.BooleanVar(); self.v_compgpu = tk.BooleanVar()
        ttk.Checkbutton(opts, text='Comprimir os vídeos pedidos no app (nos níveis Médio e Máximo)', variable=self.v_comp, command=self.on_form).pack(anchor='w')
        ttk.Checkbutton(opts, text='Comprimir usando a placa de vídeo (bem mais rápido)', variable=self.v_compgpu, command=self.on_form).pack(anchor='w', padx=(20, 0))

        # atividade (registro)
        self.log = tk.Text(tab_log, height=8, width=50, wrap='none', font=('Consolas', 9), relief='flat', background='#f6f6f8')
        self.log.pack(fill='both', expand=True); self.log.configure(state='disabled')

        # histórico (fica salvo entre uma abertura e outra)
        hh = ttk.Frame(tab_hist); hh.pack(fill='x')
        ttk.Button(hh, text='Limpar', command=self.clear_history).pack(side='right')
        self.lbl_hist = ttk.Label(hh, text='', style='Muted.TLabel', justify='left', wraplength=400); self.lbl_hist.pack(side='left', fill='x', expand=True)
        cols = ('quando', 'tipo', 'video', 'resultado', 'tempo')
        tv = ttk.Treeview(tab_hist, columns=cols, show='headings', height=8)
        for c, label, w, anchor in (('quando', 'Quando', 74, 'w'), ('tipo', 'Tipo', 80, 'w'), ('video', 'Vídeo', 130, 'w'),
                                    ('resultado', 'Resultado', 150, 'w'), ('tempo', 'Tempo', 58, 'e')):
            tv.heading(c, text=label); tv.column(c, width=w, minwidth=40, anchor=anchor, stretch=(c in ('video', 'resultado')))
        sb = ttk.Scrollbar(tab_hist, orient='vertical', command=tv.yview); tv.configure(yscrollcommand=sb.set)
        tv.pack(side='left', fill='both', expand=True, pady=(6, 0)); sb.pack(side='right', fill='y', pady=(6, 0))
        tv.tag_configure('erro', foreground='#c0392b')
        self.tv = tv
        # dois cliques numa linha: mostra tudo (nomes e erros longos ficam cortados na tabela)
        tv.bind('<Double-1>', lambda e: (lambda it: it and messagebox.showinfo(APP, '\n'.join(f'{h}: {v}' for h, v in zip(
            ('Quando', 'Tipo', 'Vídeo', 'Resultado', 'Tempo'), tv.item(it, 'values')))))(tv.focus()))

    def load_form(self):
        c = self.cfg
        self.mode.set(c['mode'])
        self.busy.set(LEVEL_NAMES.get(c['busy_level'], 'Leve'))
        self.idle.set(LEVEL_NAMES.get(c['idle_level'], 'Máximo'))
        self.idle_min.delete(0, 'end'); self.idle_min.insert(0, str(c['idle_minutes']))
        self.v_full.set(bool(c['pause_fullscreen'])); self.v_batt.set(bool(c['pause_battery']))
        self.scale.set(zw.LEVEL_ORDER.index(c.get('fixed_level', 'medio')))
        self.v_tray.set(bool(c['close_to_tray']))
        self.v_comp.set(bool(c['compress'])); self.v_compgpu.set(bool(c['compress_gpu']))
        self.show_mode()

    def show_mode(self):
        if self.mode.get() == 'auto':
            self.fr_fixed.pack_forget(); self.fr_auto.pack(fill='x', pady=(8, 0), before=self.lbl_now)
        else:
            self.fr_auto.pack_forget(); self.fr_fixed.pack(fill='x', before=self.lbl_now)

    def on_scale(self, v):
        if self._loading:
            return
        i = int(round(float(v)))
        if abs(float(v) - i) > 0.01:
            self.scale.set(i); return
        self.on_form()

    def on_form(self):
        if self._loading:
            return
        c = self.cfg
        c['mode'] = self.mode.get()
        c['busy_level'] = NAME_TO_LEVEL.get(self.busy.get(), 'leve')
        c['idle_level'] = NAME_TO_LEVEL.get(self.idle.get(), 'maximo')
        try: c['idle_minutes'] = max(1, min(120, int(self.idle_min.get())))
        except ValueError: pass
        c['pause_fullscreen'] = bool(self.v_full.get()); c['pause_battery'] = bool(self.v_batt.get())
        c['fixed_level'] = zw.LEVEL_ORDER[int(round(float(self.scale.get())))]
        c['close_to_tray'] = bool(self.v_tray.get())
        c['compress'] = bool(self.v_comp.get()); c['compress_gpu'] = bool(self.v_compgpu.get())
        self.show_mode()
        try: zw.save_config(c)
        except Exception: pass
        self.policy_tick(once=True)

    def on_startup(self):
        on = bool(self.v_startup.get())
        ok = set_startup(on)
        if on and not ok:
            self.v_startup.set(False)
            messagebox.showwarning(APP, 'Não consegui criar o atalho na pasta Inicializar do Windows.')

    # ---------------- decide o nível conforme o uso do PC
    def decide(self):
        c = self.cfg
        if self.manual_pause:
            return 'pausado', 'pausado por você'
        if c['mode'] == 'fixo':
            return c['fixed_level'], 'nível fixo'
        if c['pause_fullscreen'] and fullscreen_busy():
            return 'pausado', 'jogo, filme ou apresentação em tela cheia'
        if c['pause_battery'] and on_battery():
            return 'pausado', 'notebook na bateria'
        idle = idle_seconds()
        if idle >= c['idle_minutes'] * 60:
            return c['idle_level'], f'PC parado há {int(idle // 60)} min'
        return c['busy_level'], 'você está usando o PC'

    def policy_tick(self, once=False):
        if self.cfg.get('mode') not in ('auto', 'fixo'):
            self.cfg['mode'] = 'auto'
        level, why = self.decide()
        if self.helper:
            self.helper.set_level(level)
        if getattr(self, 'comp', None):
            self.comp.set_level(level)
        info = zw.LEVELS[level]
        self.lbl_now.configure(text=f'Agora: {info["nome"]} — {why}')
        helps = {
            'pausado': 'Não usa o PC agora.',
            'leve': 'Usa pouco: um quadro por vez, descansando a maior parte do tempo e com prioridade mínima.',
            'medio': 'Uso moderado: trabalha cerca de 60% do tempo, com prioridade baixa.',
            'maximo': 'Usa o que puder para terminar mais rápido (ainda com prioridade abaixo dos seus programas).',
        }
        self.lbl_help.configure(text=helps[level])
        if level != self.last_level:
            self.last_level = level
            self.update_tray()
        self.btn_pause.configure(text='Continuar' if self.manual_pause else 'Pausar')
        if not once:
            self.root.after(2000, self.policy_tick)

    def toggle_pause(self):
        self.manual_pause = not self.manual_pause
        self.policy_tick(once=True)

    # ---------------- ajudante
    def start_helper(self):
        if self.helper:
            self.helper.stop()
        self.helper = zw.Helper(self.cfg, on_event=lambda k, d: self.q.put((k, d)))
        level, _ = self.decide()
        self.helper.level = level
        self.helper.start()
        if getattr(self, 'comp', None):
            self.comp.stop()
        self.comp = zc.Compressor(self.cfg, on_event=lambda k, d: self.q.put((k, d)))
        self.comp.set_level(level)
        self.comp.start()

    def poll(self):
        try:
            while True:
                kind, data = self.q.get_nowait()
                self.handle(kind, data)
        except queue.Empty:
            pass
        self.root.after(200, self.poll)

    def handle(self, kind, data):
        if kind == 'log':
            self.add_log(data)
        elif kind == 'state':
            self.state = data; self.render_state()
        elif kind == 'progress':
            self.pb.configure(value=100 * data['frames'] / max(1, data['total']))
            if data.get('fps') is not None:
                self.speed = data; self.render_state()
        elif kind == 'done':
            self.pb.configure(value=0); self.render_state()
            self.add_history({'kind': 'faces', 'name': os.path.basename(data.get('path', '')), 'people': data.get('people'), 'ms': data.get('ms'), 'status': 'done'})
        elif kind == 'failed':
            self.add_history({'kind': 'faces', 'name': os.path.basename(data.get('path', '')), 'error': data.get('error'), 'status': 'failed'})
        elif kind == 'cdone':
            self.add_history(dict(data, kind='compress')); self.render_state()
        elif kind == 'server':
            self.server_progress = data; self.render_state()
        elif kind == 'compress':
            self.render_state()
        elif kind == 'device':
            self.render_state()
        elif kind == 'level':  # o ajudante mudou de nível
            self.render_state()
        elif kind == 'cmd' and data in ('show', 'toggle_pause', 'quit'):
            getattr(self, data)()
        elif kind == 'pick':  # escolhido no menu da bandeja
            self.choose_level(data)

    def render_state(self):
        s = self.state.get('state'); h = self.helper
        paused = h and h.level == 'pausado'
        texts = {'starting': ('Iniciando…', '#999'), 'working': ('Analisando', '#2bb673'), 'idle': ('Tudo analisado — aguardando vídeos novos', '#3ea6ff'),
                 'offline': ('Sem conexão com o Zima Video', '#e5484d'), 'error': ('Erro', '#e5484d'), 'paused': ('Pausado', '#999'), 'stopped': ('Parado', '#999')}
        t, col = texts.get(s, ('…', '#999'))
        if paused and s not in ('offline', 'error'):
            t, col = 'Pausado', '#999'
        self.lbl_state.configure(text=t); self.dot.itemconfigure(self.dot_id, fill=col)
        if s == 'working' and not paused:
            self.lbl_file.configure(text=os.path.basename(self.state.get('path', '')))
        elif s in ('offline', 'error'):
            self.lbl_file.configure(text=self.state.get('msg', '')[:120])
        else:
            self.lbl_file.configure(text='')
        parts = []
        if h:
            parts.append(f'Nesta sessão: {h.done} vídeo(s)' + (f', {h.failed} com erro' if h.failed else '') + (f' · usando {h.device}' if h.device else ''))
            sp = getattr(self, 'speed', None)
            if sp and self.state.get('state') == 'working':
                parts.append(f'Velocidade: {sp["fps"]:.0f} quadros/s · análise ocupando {sp["busy"] * 100:.0f}% do tempo'
                             + (' (o resto é leitura dos vídeos pela rede)' if sp['busy'] < 0.6 and h.level == 'maximo' else ''))
        if self.server_progress:
            p = self.server_progress
            parts.append(f'Biblioteca: {p.get("done", 0)} de {p.get("total", 0)} vídeos analisados')
        self.lbl_stats.configure(text='\n'.join(parts))
        self.render_compress()
        self.update_tray()

    def render_compress(self):
        cp = getattr(self, 'comp', None)
        if not cp:
            return
        cur = cp.current
        if not self.cfg.get('compress', True):
            self.lbl_cfile.configure(text='Desligada (marque “Comprimir os vídeos pedidos no app” na aba Uso do PC)')
            self.pbc.configure(value=0); self.lbl_cstats.configure(text=''); return
        if cur:
            stage = {'comprimindo': 'Comprimindo', 'pausada': 'Pausada (você está usando o PC)', 'enviando': 'Enviando para o NAS',
                     'medindo qualidade': 'Medindo a qualidade em trechos', 'preparando': 'Preparando'}.get(cur['stage'], cur['stage'])
            self.lbl_cfile.configure(text=f'{stage}: {cur["name"]}')
            self.pbc.configure(value=cur.get('pct') or 0)
            bits = [f'{cur.get("pct") or 0}%']
            if cur['stage'] == 'comprimindo':
                if cur.get('speed'): bits.append(f'{cur["speed"]} a velocidade normal do vídeo')
                if cur.get('eta') is not None: bits.append(f'falta ~{fmt_dur(cur["eta"])}')
            bits.append(f'{(cur.get("codec") or "").upper()} pela {cur["enc"]}')
            if cur.get('vmaf') is not None: bits.append(f'ajuste {cur.get("q")} → VMAF {cur["vmaf"]:.1f}')
            line = ' · '.join(bits)
        else:
            self.pbc.configure(value=0)
            self.lbl_cfile.configure(text='Aguardando vídeos para comprimir' if self.last_level in ('medio', 'maximo') else 'Espera o nível Médio ou Máximo (PC parado, no modo Automático)')
            line = ''
        tot = (f'Nesta sessão: {cp.done} comprimido(s) · economia {zc.fmt_size(cp.saved)}' + (f' · {cp.skipped} pulado(s) por não compensar' if getattr(cp, 'skipped', 0) else '')
               + (f' · {cp.failed} com erro' if cp.failed else ''))
        self.lbl_cstats.configure(text='\n'.join(x for x in (line, tot) if x))

    # ---------------- uso do sistema
    def tick_resources(self):
        try:
            if not hasattr(self, 'mon'):
                self.mon = sysmon.SysMon()
            r = self.mon.read()
            def setbar(k, pct, txt):
                bar, lab = self.res[k]; bar.configure(value=max(0, min(100, pct or 0))); lab.configure(text=txt)
            if 'cpu' in r:
                setbar('cpu', r['cpu'], f'{r["cpu"]:.0f}%  (ajudante {r.get("cpu_mine", 0):.0f}%)')
                setbar('mem', r['mem'], f'{r["mem"]:.0f}%  (ajudante {sysmon.fmt_bytes(r.get("mem_mine"))})')
            else:
                setbar('cpu', 0, 'instale o componente psutil'); setbar('mem', 0, '—')
            g = r.get('gpu')
            if g:
                mine = sum(g['mine'].values())
                setbar('gpu', g['total'], f'{g["total"]:.0f}%  (ajudante {min(100, mine):.0f}%)')
                eng = [f'{sysmon.ENGINE_NAMES.get(k, k)} {v:.0f}%' for k, v in sorted(g['types'].items(), key=lambda x: -x[1]) if v >= 1 and k in sysmon.ENGINE_NAMES]
                self.lbl_gpu_eng.configure(text=('Placa por função: ' + ' · '.join(eng[:4])) if eng else 'Placa por função: tudo parado')
                if g.get('mem') is not None:
                    setbar('vram', 0, sysmon.fmt_bytes(g['mem']) + ' em uso')
                    self.res['vram'][0].configure(mode='indeterminate'); self.res['vram'][0].stop()
            else:
                setbar('gpu', 0, 'disponível só no Windows' if not sysmon.IS_WIN else 'sem contadores da placa neste Windows')
                setbar('vram', 0, '—'); self.lbl_gpu_eng.configure(text='')
        except Exception as e:
            self.lbl_gpu_eng.configure(text=f'Uso do sistema indisponível: {e}')
        self.root.after(2000, self.tick_resources)

    # ---------------- histórico
    HIST_FILE = os.path.join(HERE, 'historico.json')

    def load_history(self):
        try:
            with open(self.HIST_FILE, encoding='utf-8') as f:
                self.history = json.load(f)
        except Exception:
            self.history = []
        self.draw_history()

    def add_history(self, rec):
        rec['at'] = time.time()
        self.history.append(rec); self.history = self.history[-1500:]
        try:
            with open(self.HIST_FILE + '.tmp', 'w', encoding='utf-8') as f:
                json.dump(self.history, f, ensure_ascii=False)
            os.replace(self.HIST_FILE + '.tmp', self.HIST_FILE)
        except Exception:
            pass
        self.draw_history()

    def clear_history(self):
        if messagebox.askyesno(APP, 'Apagar o histórico deste PC?'):
            self.history = []
            try: os.remove(self.HIST_FILE)
            except Exception: pass
            self.draw_history()

    def draw_history(self):
        tv = self.tv
        tv.delete(*tv.get_children())
        for h in reversed(self.history[-400:]):
            when = time.strftime('%d/%m %H:%M', time.localtime(h.get('at', 0)))
            if h.get('kind') == 'faces':
                res = h['error'] if h.get('status') == 'failed' else f'{h.get("people", 0)} pessoa(s)'
                tv.insert('', 'end', values=(when, 'Rostos', h.get('name', ''), res, fmt_dur((h.get('ms') or 0) / 1000)),
                          tags=('erro',) if h.get('status') == 'failed' else ())
            else:
                st = h.get('status')
                if st == 'done':
                    res = f'{zc.fmt_size(h.get("before"))} → {zc.fmt_size(h.get("after"))} ({(h.get("codec") or "").upper()}' + (f', VMAF {h["vmaf"]:.1f})' if h.get('vmaf') else ')')
                elif st == 'skipped':
                    res = h.get('note') or 'não ficou menor (mantido)'
                else:
                    res = h.get('error') or 'erro'
                tv.insert('', 'end', values=(when, 'Compressão', h.get('name', ''), res, fmt_dur(h.get('secs') or 0)),
                          tags=('erro',) if st == 'failed' else ())
        faces = [h for h in self.history if h.get('kind') == 'faces' and h.get('status') != 'failed']
        comp = [h for h in self.history if h.get('kind') == 'compress' and h.get('status') == 'done']
        saved = sum(max(0, (h.get('before') or 0) - (h.get('after') or 0)) for h in comp)
        self.lbl_hist.configure(text=f'Rostos: {len(faces)} vídeo(s) analisado(s) · Compressão: {len(comp)} vídeo(s), economia de {zc.fmt_size(saved)}')

    def add_log(self, line):
        self.log.configure(state='normal')
        self.log.insert('end', line + '\n')
        n = int(self.log.index('end-1c').split('.')[0])
        if n > 300: self.log.delete('1.0', f'{n - 300}.0')
        self.log.see('end'); self.log.configure(state='disabled')

    def open_web(self):
        if self.cfg.get('server'): webbrowser.open(self.cfg['server'])

    # ---------------- conexão
    def connection_dialog(self, first=False):
        d = tk.Toplevel(self.root); d.title('Conectar ao Zima Video'); d.transient(self.root); d.resizable(False, False)
        f = ttk.Frame(d, padding=14); f.pack()
        ttk.Label(f, text='No app Zima Video: menu ⋮ → Pessoas → “Conectar ajudante”\nmostra o endereço e gera o código.', justify='left').grid(row=0, column=0, columnspan=2, sticky='w', pady=(0, 10))
        ttk.Label(f, text='Endereço:').grid(row=1, column=0, sticky='w')
        e1 = ttk.Entry(f, width=40); e1.grid(row=1, column=1, pady=3); e1.insert(0, self.cfg.get('server', 'http://'))
        ttk.Label(f, text='Código:').grid(row=2, column=0, sticky='w')
        e2 = ttk.Entry(f, width=40, show='•'); e2.grid(row=2, column=1, pady=3); e2.insert(0, self.cfg.get('token', ''))
        msg = ttk.Label(f, text='', foreground='#c0392b', wraplength=360, justify='left'); msg.grid(row=3, column=0, columnspan=2, sticky='w', pady=(6, 0))

        def ok():
            msg.configure(text='Testando…', foreground='#666'); d.update_idletasks()
            try:
                name = zw.check_connection(self.cfg, e1.get(), e2.get())
            except Exception as ex:
                msg.configure(text=f'Não consegui conectar: {ex}', foreground='#c0392b'); return
            d.destroy()
            self.add_log(time.strftime('%H:%M:%S ') + f'Conectado. Este PC aparece no app como “{name}”.')
            self.start_helper()

        b = ttk.Frame(f); b.grid(row=4, column=0, columnspan=2, sticky='e', pady=(10, 0))
        ttk.Button(b, text='Conectar', command=ok).pack(side='right')
        ttk.Button(b, text='Cancelar', command=d.destroy).pack(side='right', padx=6)
        d.bind('<Return>', lambda e: ok())
        e1.focus_set() if first else e2.focus_set()
        d.grab_set()

    # ---------------- bandeja (perto do relógio)
    def start_tray(self):
        try:
            import pystray
        except Exception:
            return
        if make_icon() is None:
            return

        def level_item(k):
            def act(icon, item):
                self.q.put(('pick', k))
            return pystray.MenuItem(LEVEL_NAMES[k] if k != 'auto' else 'Automático', act,
                                    checked=lambda item, k=k: (self.cfg['mode'] == 'auto') if k == 'auto' else (self.cfg['mode'] == 'fixo' and self.cfg['fixed_level'] == k),
                                    radio=True)

        menu = pystray.Menu(
            pystray.MenuItem('Abrir', lambda i, it: self.q.put(('cmd', 'show')), default=True),
            pystray.MenuItem(lambda it: 'Continuar' if self.manual_pause else 'Pausar', lambda i, it: self.q.put(('cmd', 'toggle_pause'))),
            pystray.MenuItem('Uso do PC', pystray.Menu(*[level_item(k) for k in ('auto', 'leve', 'medio', 'maximo')])),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Sair', lambda i, it: self.q.put(('cmd', 'quit'))),
        )
        try:
            self.tray = pystray.Icon('zima_ajudante', make_icon(64), APP, menu)
            self.tray.run_detached()
        except Exception:
            self.tray = None

    def update_tray(self):
        if not self.tray:
            return
        s = self.state.get('state')
        st = 'offline' if s in ('offline', 'error') else 'paused' if (self.helper and self.helper.level == 'pausado') else 'working'
        lvl = LEVEL_NAMES.get(self.last_level or '', '')
        title = f'{APP}\n{self.lbl_state.cget("text")} · {lvl}'
        try:
            if st != self.icon_state:
                self.icon_state = st; self.tray.icon = make_icon(64, st)
            self.tray.title = title[:120]
        except Exception:
            pass

    def choose_level(self, k):
        if k == 'auto': self.mode.set('auto')
        else: self.mode.set('fixo'); self.scale.set(zw.LEVEL_ORDER.index(k))
        self.manual_pause = False
        self.on_form()

    def show(self):
        self.root.deiconify(); self.root.lift(); self.root.focus_force()

    def on_close(self):
        if self.tray and self.cfg.get('close_to_tray'):
            self.root.withdraw()
            if not self.cfg.get('_told_tray'):
                self.cfg['_told_tray'] = True
                try: self.tray.notify('Continuo trabalhando aqui na bandeja. Clique no ícone para abrir.', APP)
                except Exception: pass
            return
        self.quit()

    def quit(self):
        if self.helper: self.helper.stop()
        if getattr(self, 'comp', None): self.comp.stop()
        if self.tray:
            try: self.tray.stop()
            except Exception: pass
        self.root.destroy()


def single_instance(app_queue_holder):
    """Só uma cópia por vez: se já houver uma aberta, pede para ela aparecer e sai."""
    try:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(('127.0.0.1', SINGLE_PORT)); srv.listen(2)
    except OSError:
        try:
            with socket.create_connection(('127.0.0.1', SINGLE_PORT), timeout=2) as c:
                c.sendall(b'show')
        except Exception:
            pass
        return None

    def loop():
        while True:
            try:
                c, _ = srv.accept(); data = c.recv(16); c.close()
                if data == b'show' and app_queue_holder:
                    app_queue_holder[0].q.put(('cmd', 'show'))
            except Exception:
                time.sleep(1)
    threading.Thread(target=loop, daemon=True).start()
    return srv


def main():
    holder = []
    if single_instance(holder) is None:
        return
    root = tk.Tk()
    app = App(root, start_hidden='--bandeja' in sys.argv)
    holder.append(app)
    root.mainloop()


if __name__ == '__main__':
    main()
