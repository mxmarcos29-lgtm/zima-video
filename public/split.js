'use strict';
/* Zima Video — tela dividida: até 4 vídeos ao mesmo tempo, cada um com seus controles */

// Carrega um arquivo num <video> escolhendo o modo mais leve (direto → remux → conversão HLS),
// com troca automática se um modo falhar. Usado pelos quadros da tela dividida.
class SourceCtl {
  constructor(v) { this.v = v; this.mode = null; this.offset = 0; this.hls = null; this.tried = []; this.seq = 0; }
  time() { return (this.mode === 'remux' ? this.offset : 0) + (this.v.currentTime || 0); }
  duration() { return (this.info && this.info.duration) || (isFinite(this.v.duration) ? this.v.duration : 0); }
  async open(item, start = 0) {
    this.item = item;
    this.info = await api('info', { path: item.path });
    this.mode = this.pick();
    await this.load(start);
  }
  pick() {
    const order = [];
    if (canDirect(this.item, this.info, 0)) order.push('direct');
    if (!IS_APPLE && videoPlayable(this.info, 'video/mp4')) order.push('remux');
    order.push('hls');
    return order.find((m) => !this.tried.includes(m)) || null;
  }
  destroySource() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.v.removeAttribute('src');
    try { this.v.load(); } catch { /* ignore */ }
  }
  async load(t = 0) {
    const seq = ++this.seq; const v = this.v; const item = this.item;
    const playing = !v.paused || this.autoplay;
    this.destroySource();
    if (!this.tried.includes(this.mode)) this.tried.push(this.mode);
    if (this.mode === 'direct') {
      v.src = fileUrl(item.path); this.offset = 0;
      if (t > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
    } else if (this.mode === 'remux') {
      let plan = { s: t, l: t };
      if (this.info.video) { try { plan = await api('remux-plan', { path: item.path, t: t.toFixed(3) }); } catch { /* usa t */ } }
      if (seq !== this.seq) return;
      this.offset = plan.l;
      v.src = `/api/stream?${qs({ path: item.path, t: plan.s.toFixed(3), audio: 0, mode: 'remux' })}`;
    } else {
      this.offset = 0;
      const src = `/api/hls/index.m3u8?${qs({ path: item.path, h: 0, audio: 0 })}`;
      const native = v.canPlayType('application/vnd.apple.mpegurl') !== '';
      let Hls = null;
      if (!(IS_APPLE && native)) { try { Hls = await loadHls(); } catch { /* nativo */ } }
      if (seq !== this.seq) return;
      if (Hls && Hls.isSupported()) {
        const hls = new Hls({ startPosition: t, maxBufferLength: 20, backBufferLength: 30 });
        this.hls = hls;
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError(); else this.fail(); } });
        hls.loadSource(src); hls.attachMedia(v);
      } else if (native) {
        v.src = src;
        if (t > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
      } else return this.fail();
    }
    if (playing) v.play().catch(() => {});
  }
  fail() {
    const t = this.time();
    const next = this.pick();
    if (!next) { this.onfatal && this.onfatal(); return; }
    this.mode = next; this.load(t);
  }
  seek(t) {
    const d = this.duration(); t = clamp(t, 0, d ? d - 0.25 : Infinity);
    if (this.mode === 'remux') {
      const rel = t - this.offset; const b = this.v.buffered; let inBuf = false;
      for (let i = 0; i < b.length; i++) if (rel >= b.start(i) && rel <= b.end(i) - 0.5) inBuf = true;
      if (rel >= 0 && inBuf) this.v.currentTime = rel; else this.load(t);
    } else this.v.currentTime = t;
  }
  destroy() { this.seq++; this.destroySource(); }
}

const Split = (() => {
  const MAX = 4;
  const root = $('#split'); const grid = $('#split-grid');
  let tiles = []; let focus = null; let open = false;

  function layout() {
    grid.dataset.n = String(Math.max(1, tiles.length + (tiles.length < MAX ? 1 : 0)));
    grid.classList.toggle('full', tiles.length >= MAX);
    $('#split-add').classList.toggle('hidden', tiles.length >= MAX);
    $('#split-count').textContent = `${tiles.length} de ${MAX}`;
  }

  function setFocus(t) {
    focus = t;
    for (const x of tiles) {
      x.el.classList.toggle('focus', x === t);
      x.v.muted = x !== t; // som só no quadro selecionado
    }
  }

  function makeTile(item, start) {
    const el0 = el('div', 's-tile');
    el0.innerHTML = `<video playsinline preload="auto"></video><div class="spinner s-spin"></div>
      <div class="s-ui">
        <div class="s-top"><span class="s-name"></span>
          <button class="icon-btn s-open" title="Abrir no player">${icon('fs')}</button>
          <button class="icon-btn s-close" title="Fechar este vídeo">${icon('close')}</button></div>
        <div class="s-bottom">
          <button class="icon-btn s-rw" title="−10s">${icon('rw')}</button>
          <button class="icon-btn s-play" title="Reproduzir/pausar">${icon('pause')}</button>
          <button class="icon-btn s-ff" title="+10s">${icon('ff')}</button>
          <span class="s-time">0:00</span>
          <div class="s-seek"><div class="s-buf"></div><div class="s-prog"></div></div>
          <span class="s-mute" title="Som">${icon('mute')}</span>
        </div>
      </div>`;
    const v = $('video', el0);
    const t = { el: el0, v, item, ctl: new SourceCtl(v) };
    $('.s-name', el0).textContent = stripExt(item.name);
    v.muted = true; t.ctl.autoplay = true;
    const spin = $('.s-spin', el0);
    v.addEventListener('waiting', () => spin.classList.remove('hidden'));
    v.addEventListener('playing', () => spin.classList.add('hidden'));
    v.addEventListener('canplay', () => spin.classList.add('hidden'));
    v.addEventListener('play', () => { $('.s-play', el0).innerHTML = icon('pause'); });
    v.addEventListener('pause', () => { $('.s-play', el0).innerHTML = icon('play'); });
    v.addEventListener('volumechange', () => { $('.s-mute', el0).innerHTML = icon(v.muted ? 'mute' : 'vol'); });
    v.addEventListener('timeupdate', () => {
      const d = t.ctl.duration(); const cur = t.ctl.time();
      $('.s-time', el0).textContent = `${fmtTime(cur)} / ${fmtTime(d)}`;
      $('.s-prog', el0).style.width = d ? (cur / d) * 100 + '%' : '0';
    });
    v.addEventListener('error', () => { if (v.getAttribute('src') || t.ctl.hls) t.ctl.fail(); });
    t.ctl.onfatal = () => { spin.classList.add('hidden'); toast(`Não foi possível reproduzir ${item.name}`); };
    const on = (sel, fn) => $(sel, el0).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    on('.s-play', () => (v.paused ? v.play() : v.pause()));
    on('.s-rw', () => t.ctl.seek(t.ctl.time() - 10));
    on('.s-ff', () => t.ctl.seek(t.ctl.time() + 10));
    on('.s-close', () => remove(t));
    on('.s-open', () => {
      const at = t.ctl.time(); const it = t.item;
      close(); whenHistoryIdle(() => P.open(it, { from: at }));
    });
    on('.s-mute', () => setFocus(t));
    $('.s-seek', el0).addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      t.ctl.seek(((e.clientX - r.left) / r.width) * t.ctl.duration());
    });
    // clique seleciona (som); duplo clique: só este quadro em tela cheia
    el0.addEventListener('click', () => setFocus(t));
    el0.addEventListener('dblclick', (e) => {
      if (IS_TOUCH) return; el0.classList.toggle('solo'); grid.classList.toggle('has-solo', el0.classList.contains('solo'));
    });
    t.ctl.open(item, start).catch((e) => { spin.classList.add('hidden'); toast(e.message); });
    return t;
  }

  function add(item, start = 0) {
    if (tiles.some((t) => t.item.path === item.path)) { toast('Este vídeo já está na tela dividida'); show(); return; }
    if (tiles.length >= MAX) { toast(`Máximo de ${MAX} vídeos`); show(); return; }
    show(() => addTile(item, start));
  }
  function addTile(item, start) {
    const t = makeTile(item, start);
    tiles.push(t);
    grid.insertBefore(t.el, $('#split-add'));
    layout();
    setFocus(focus && tiles.includes(focus) ? focus : t);
    if (tiles.length === 1) setFocus(t);
  }

  function remove(t) {
    t.ctl.destroy(); t.el.remove();
    tiles = tiles.filter((x) => x !== t);
    grid.classList.remove('has-solo');
    if (!tiles.length) { close(); return; }
    if (focus === t) setFocus(tiles[0]);
    layout();
  }

  function show(then) {
    if (open) { if (then) then(); return; }
    open = true;
    if (P.item && !video.paused) { P.wantPlay = false; video.pause(); }
    Preview.stop();
    const go = () => {
      root.classList.remove('hidden');
      document.body.classList.add('lock');
      pushLayer('split', hide);
      layout();
      if (then) then();
    };
    if (P.state === 'max') { P.minimize(); whenHistoryIdle(go); } else go();
  }
  function hide() {
    open = false;
    for (const t of tiles) t.ctl.destroy();
    tiles.forEach((t) => t.el.remove()); tiles = []; focus = null;
    grid.classList.remove('has-solo');
    root.classList.add('hidden');
    document.body.classList.toggle('lock', P.state === 'max' || Search.open);
  }
  function close() { if (open) closeLayer('split'); }

  // escolher vídeo para adicionar: pasta atual + pesquisa
  function picker() {
    Sheet.open((b) => {
      Sheet.header(b, 'Adicionar vídeo');
      const box = el('div', 'search-bar'); box.style.position = 'static';
      const input = el('input'); input.type = 'search'; input.placeholder = 'Pesquisar vídeos'; box.appendChild(input);
      b.appendChild(box);
      const ul = el('ul', 'list compact'); b.appendChild(ul);
      const fill = (items, note) => {
        ul.innerHTML = '';
        if (note) ul.appendChild(el('div', 'sheet-note', esc(note)));
        for (const e of items) {
          const li = renderItem(e, { showPath: true });
          li.onclick = (ev) => { ev.stopPropagation(); Sheet.close(); whenHistoryIdle(() => add(e)); };
          ul.appendChild(li);
        }
      };
      const inFolder = B.visible().filter((x) => x.type === 'video').map((x) => ({ ...x, path: (B.path ? B.path + '/' : '') + x.name }));
      fill(inFolder, inFolder.length ? 'Nesta pasta' : 'Digite para pesquisar');
      let tm;
      input.addEventListener('input', () => {
        clearTimeout(tm);
        tm = setTimeout(async () => {
          const q = input.value.trim();
          if (q.length < 2) { fill(inFolder, 'Nesta pasta'); return; }
          try { const r = await api('search', { q, media: 1 }); fill(r.results.filter((x) => x.type === 'video'), `${r.total} resultado(s)`); } catch (e) { fill([], e.message); }
        }, 250);
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  if (IS_TOUCH) $('.split-hint').textContent = 'Toque num vídeo para ouvir o som dele · toque duplo amplia';
  let lastTap = 0;
  grid.addEventListener('pointerup', (e) => {
    // toque duplo no celular (o dblclick nem sempre dispara em toque)
    if (e.pointerType === 'mouse') return;
    const tile = e.target.closest('.s-tile'); if (!tile || e.target.closest('button, .s-seek')) return;
    const now = Date.now();
    if (now - lastTap < 300) { tile.classList.toggle('solo'); grid.classList.toggle('has-solo', tile.classList.contains('solo')); lastTap = 0; }
    else lastTap = now;
  });
  $('#split-add').onclick = (e) => { e.stopPropagation(); picker(); };
  $('#split-close').onclick = () => close();
  $('#split-playall').onclick = () => {
    const anyPlaying = tiles.some((t) => !t.v.paused);
    tiles.forEach((t) => (anyPlaying ? t.v.pause() : t.v.play().catch(() => {})));
    $('#split-playall').innerHTML = `${icon(anyPlaying ? 'play' : 'pause')}<span>${anyPlaying ? 'Reproduzir todos' : 'Pausar todos'}</span>`;
  };
  document.addEventListener('keydown', (e) => {
    if (!open || e.ctrlKey || e.metaKey || e.altKey || e.target.matches('input')) return;
    const k = e.key; let handled = true;
    if (/^[1-4]$/.test(k) && tiles[+k - 1]) setFocus(tiles[+k - 1]);
    else if ((k === ' ' || k === 'k') && focus) (focus.v.paused ? focus.v.play() : focus.v.pause());
    else if ((k === 'ArrowRight' || k === 'l') && focus) focus.ctl.seek(focus.ctl.time() + (k === 'l' ? 10 : 5));
    else if ((k === 'ArrowLeft' || k === 'j') && focus) focus.ctl.seek(focus.ctl.time() - (k === 'j' ? 10 : 5));
    else if (k === 'Escape') close();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  return { add, close, get open() { return open; }, get count() { return tiles.length; } };
})();
