'use strict';
/* Zima Video — visualizador de fotos (galeria com deslizar, zoom por pinça/duplo toque, apresentação) */

const Gallery = (() => {
  const root = $('#gallery');
  const track = $('#g-track');
  const slides = [0, 1, 2].map(() => {
    const s = el('div', 'g-slide');
    s.innerHTML = '<div class="g-zoom"><img class="g-low" alt="" draggable="false"><img class="g-img" alt="" draggable="false"></div><div class="g-msg hidden"></div><div class="spinner g-spin hidden"></div>';
    track.appendChild(s);
    return s;
  });

  let list = []; let idx = 0; let open = false; let uiHidden = false;
  let z = { s: 1, x: 0, y: 0 }; // zoom da foto atual
  let slideTimer = null;

  const cur = () => slides[1];
  const zoomEl = () => $('.g-zoom', cur());

  function setSlide(s, item) {
    const low = $('.g-low', s); const img = $('.g-img', s); const msg = $('.g-msg', s); const spin = $('.g-spin', s);
    $('.g-zoom', s).style.transform = '';
    msg.classList.add('hidden');
    if (!item) { low.removeAttribute('src'); img.removeAttribute('src'); s.dataset.path = ''; spin.classList.add('hidden'); return; }
    if (s.dataset.path === item.path) return;
    s.dataset.path = item.path;
    img.classList.remove('ok'); low.classList.remove('ok');
    spin.classList.remove('hidden');
    low.onload = () => low.classList.add('ok');
    low.onerror = () => low.removeAttribute('src');
    low.src = thumbUrl(item.path, null, 640);
    img.onload = () => { if (s.dataset.path === item.path) { img.classList.add('ok'); spin.classList.add('hidden'); } };
    img.onerror = () => {
      if (s.dataset.path !== item.path) return;
      spin.classList.add('hidden');
      if (!low.classList.contains('ok')) { msg.textContent = 'O navegador não consegue exibir este formato. Use "Baixar".'; msg.classList.remove('hidden'); }
    };
    img.src = fileUrl(item.path);
  }

  function render() {
    setSlide(slides[0], list[idx - 1]);
    setSlide(slides[1], list[idx]);
    setSlide(slides[2], list[idx + 1]);
    track.style.transition = 'none';
    track.style.transform = 'translateX(-100%)';
    resetZoom(false);
    const it = list[idx];
    $('#g-title').textContent = it ? it.name : '';
    $('#g-count').textContent = list.length > 1 ? `${idx + 1} de ${list.length}` : '';
    $('#g-prev').classList.toggle('hidden', idx <= 0);
    $('#g-next').classList.toggle('hidden', idx >= list.length - 1);
  }

  function go(d) {
    const n = idx + d;
    if (n < 0 || n >= list.length) { bounce(); return false; }
    // gira os três slides: o vizinho vira o atual sem recarregar a imagem
    track.style.transition = 'transform .25s ease-out';
    track.style.transform = `translateX(${-100 - d * 100}%)`;
    setTimeout(() => {
      if (d > 0) slides.push(slides.shift()); else slides.unshift(slides.pop());
      track.append(...slides);
      idx = n;
      render();
    }, 250);
    return true;
  }
  function bounce() {
    track.style.transition = 'transform .2s ease-out';
    track.style.transform = 'translateX(-100%)';
  }

  // ---------------------------------------------------------------- zoom
  function applyZoom(anim) {
    const zEl = zoomEl();
    zEl.style.transition = anim ? 'transform .2s ease-out' : 'none';
    zEl.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    root.classList.toggle('zoomed', z.s > 1.01);
  }
  function clampPan() {
    const r = cur().getBoundingClientRect();
    const img = $('.g-img.ok', cur()) || $('.g-low', cur());
    // tamanho exibido da foto (object-fit: contain)
    let w = r.width; let h = r.height;
    if (img && img.naturalWidth) { const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight); w = img.naturalWidth * k; h = img.naturalHeight * k; }
    const mx = Math.max(0, (w * z.s - r.width) / 2); const my = Math.max(0, (h * z.s - r.height) / 2);
    z.x = clamp(z.x, -mx, mx); z.y = clamp(z.y, -my, my);
  }
  function zoomAt(s, cx, cy, anim = true) {
    const r = cur().getBoundingClientRect();
    s = clamp(s, 1, 6);
    // mantém o ponto (cx, cy) parado durante o zoom
    const px = cx - (r.left + r.width / 2); const py = cy - (r.top + r.height / 2);
    z.x = px - ((px - z.x) * s) / z.s; z.y = py - ((py - z.y) * s) / z.s; z.s = s;
    if (s === 1) { z.x = 0; z.y = 0; }
    clampPan(); applyZoom(anim);
  }
  function resetZoom(anim = true) { z = { s: 1, x: 0, y: 0 }; applyZoom(anim); }

  // ---------------------------------------------------------------- gestos
  const ptrs = new Map();
  let g = null; let lastTap = 0; let tapTimer = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stopShow();
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: z.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x0: z.x, y0: z.y };
      return;
    }
    g = { type: null, sx: e.clientX, sy: e.clientY, x0: z.x, y0: z.y, t: Date.now() };
  });
  root.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !g) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.type === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const s = clamp((g.s0 * d) / g.d0, 1, 6);
      const r = cur().getBoundingClientRect();
      const px = g.cx - (r.left + r.width / 2); const py = g.cy - (r.top + r.height / 2);
      const mx = (a.x + b.x) / 2 - g.cx; const my = (a.y + b.y) / 2 - g.cy;
      z.x = px - ((px - g.x0) * s) / g.s0 + mx; z.y = py - ((py - g.y0) * s) / g.s0 + my; z.s = s;
      clampPan(); applyZoom(false);
      return;
    }
    const dx = e.clientX - g.sx; const dy = e.clientY - g.sy;
    if (!g.type) {
      if (Math.hypot(dx, dy) < 8) return;
      g.type = z.s > 1.01 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'close' : 'none';
    }
    if (g.type === 'pan') { z.x = g.x0 + dx; z.y = g.y0 + dy; clampPan(); applyZoom(false); }
    else if (g.type === 'swipe') {
      const edge = (idx === 0 && dx > 0) || (idx === list.length - 1 && dx < 0) ? 0.35 : 1; // resistência nas pontas
      track.style.transition = 'none';
      track.style.transform = `translateX(calc(-100% + ${dx * edge}px))`;
    } else if (g.type === 'close') {
      cur().style.transform = `translateY(${Math.max(0, dy)}px) scale(${1 - Math.min(0.3, dy / 1500)})`;
      root.style.backgroundColor = `rgba(0,0,0,${clamp(1 - dy / 500, 0.2, 1)})`;
    }
  });
  const end = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (!g) return;
    if (g.type === 'pinch') { if (ptrs.size === 0) { if (z.s < 1.05) resetZoom(); g = null; } return; }
    const dx = e.clientX - g.sx; const dy = e.clientY - g.sy; const dt = Math.max(1, Date.now() - g.t);
    const type = g.type; g = null;
    if (type === 'swipe') {
      const fast = Math.abs(dx) / dt > 0.4;
      if ((Math.abs(dx) > innerWidth * 0.22 || fast) && go(dx < 0 ? 1 : -1)) return;
      bounce(); return;
    }
    if (type === 'close') {
      if (dy > 120 || dy / dt > 0.6) { close(); return; }
      cur().style.transition = 'transform .2s'; cur().style.transform = ''; root.style.backgroundColor = '';
      setTimeout(() => { cur().style.transition = ''; }, 220);
      return;
    }
    if (type) return;
    // toque: duplo = zoom; simples = mostra/oculta barra
    const now = Date.now();
    if (now - lastTap < 280) {
      clearTimeout(tapTimer); lastTap = 0;
      if (z.s > 1.01) resetZoom(); else zoomAt(2.5, e.clientX, e.clientY);
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => toggleUI(), 280);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(z.s * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX, e.clientY, false);
  }, { passive: false });

  function toggleUI(force) { uiHidden = force != null ? force : !uiHidden; root.classList.toggle('ui-hidden', uiHidden); }

  // ---------------------------------------------------------------- apresentação
  function startShow() {
    stopShow();
    $('#g-play').innerHTML = icon('pause');
    toggleUI(true);
    slideTimer = setInterval(() => { if (!go(1)) stopShow(); }, 4000);
  }
  function stopShow() { if (!slideTimer) return; clearInterval(slideTimer); slideTimer = null; $('#g-play').innerHTML = icon('play'); }

  // ---------------------------------------------------------------- abrir/fechar
  async function show(item, siblings) {
    list = siblings && siblings.length ? siblings : [item];
    idx = Math.max(0, list.findIndex((x) => x.path === item.path));
    open = true;
    root.classList.remove('hidden', 'ui-hidden'); uiHidden = false;
    root.style.backgroundColor = '';
    slides.forEach((s) => { s.dataset.path = ''; s.style.transform = ''; });
    document.body.classList.add('lock');
    pushLayer('gallery', hide);
    render();
    if (!siblings) {
      // aberta pela pesquisa/favoritos: carrega as outras fotos da mesma pasta
      try {
        const dir = dirname(item.path);
        const r = await api('list', { path: dir });
        if (!open) return;
        list = B.sorted(r.entries.filter((x) => x.type === 'image')).map((x) => ({ ...x, path: (dir ? dir + '/' : '') + x.name }));
        idx = Math.max(0, list.findIndex((x) => x.path === item.path));
        render();
      } catch { /* só a foto aberta */ }
    }
  }
  function hide() {
    open = false; stopShow();
    root.classList.add('hidden');
    document.body.classList.toggle('lock', P.state === 'max' || Search.open);
    slides.forEach((s) => setSlide(s, null));
  }
  function close() { closeLayer('gallery'); }

  $('#g-close').onclick = (e) => { e.stopPropagation(); close(); };
  $('#g-prev').onclick = (e) => { e.stopPropagation(); stopShow(); go(-1); };
  $('#g-next').onclick = (e) => { e.stopPropagation(); stopShow(); go(1); };
  $('#g-play').onclick = (e) => { e.stopPropagation(); slideTimer ? stopShow() : startShow(); };
  $('#g-download').onclick = (e) => { e.stopPropagation(); const it = list[idx]; if (it) location.href = fileUrl(it.path, { download: 1 }); };
  $('#g-more').onclick = (e) => { e.stopPropagation(); const it = list[idx]; if (it) itemMenu(it); };

  document.addEventListener('keydown', (e) => {
    if (!open || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const map = {
      ArrowRight: () => go(1), ArrowLeft: () => go(-1), ' ': () => (slideTimer ? stopShow() : startShow()),
      '+': () => zoomAt(z.s * 1.5, innerWidth / 2, innerHeight / 2), '=': () => zoomAt(z.s * 1.5, innerWidth / 2, innerHeight / 2),
      '-': () => zoomAt(z.s / 1.5, innerWidth / 2, innerHeight / 2), 0: () => resetZoom(),
      Escape: () => close(), Home: () => { idx = 0; render(); }, End: () => { idx = list.length - 1; render(); },
    };
    if (map[k]) { e.preventDefault(); e.stopImmediatePropagation(); if (k !== ' ') stopShow(); map[k](); }
  }, true);

  return { show, get open() { return open; } };
})();
