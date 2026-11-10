'use strict';
/* Zima Video — frontend (JS puro, sem build) */

// ===================================================================== utilidades
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const basename = (p) => p.split('/').pop();
const dirname = (p) => p.split('/').slice(0, -1).join('/');
const extname = (p) => { const m = /\.([^./]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const stripExt = (n) => n.replace(/\.[^.]+$/, '');
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days < 1 && d.getDate() === now.getDate()) return 'hoje';
  if (days < 2) return 'ontem';
  if (days < 7) return `há ${days} dias`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
async function api(path, params = {}) {
  const r = await fetch(`/api/${path}?${qs(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}
const fileUrl = (p, extra = {}) => `/api/file?${qs({ path: p, ...extra })}`;
const thumbUrl = (p, t, w) => `/api/thumb?${qs({ path: p, t, w })}`;

const store = {
  get(k, d) { try { const v = localStorage.getItem('zv:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('zv:' + k, JSON.stringify(v)); } catch { /* cheio/privado */ } },
};
const prefs = Object.assign({
  view: 'list', sort: 'name', mediaOnly: true, autoplay: true, loop: false,
  subLang: '', audioLang: '', rate: 1, volume: 1, muted: false, quality: 0, previews: true,
}, store.get('prefs', {}));
const savePrefs = () => store.set('prefs', prefs);

// progresso de reprodução (retomar)
const progress = store.get('progress', {});
let progressDirty = false;
function setProgress(p, t, d) {
  if (!d || !isFinite(d)) return;
  const watched = t > d - Math.min(30, d * 0.05);
  progress[p] = { t: watched ? 0 : Math.round(t), d: Math.round(d), at: Date.now(), w: watched || (progress[p] && progress[p].w) || false };
  progressDirty = true;
}
function flushProgress() {
  if (!progressDirty) return;
  const keys = Object.keys(progress);
  if (keys.length > 500) keys.sort((a, b) => progress[a].at - progress[b].at).slice(0, keys.length - 500).forEach((k) => delete progress[k]);
  store.set('progress', progress); progressDirty = false;
}
setInterval(flushProgress, 5000);
addEventListener('pagehide', () => { P.saveProgress(); flushProgress(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { P.saveProgress(); flushProgress(); } });

let toastTimer;
function toast(msg, action, fn, ms = 3000) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = el('button', '', esc(action)); b.onclick = () => { t.classList.remove('on'); fn(); }; t.appendChild(b); }
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copiado'); }
  catch {
    const ta = el('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Link copiado'); } catch { toast('Não foi possível copiar'); }
    ta.remove();
  }
}

const UA = navigator.userAgent;
const IS_APPLE = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  (/Safari/.test(UA) && !/Chrome|Chromium|Android|Edg/.test(UA));
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

// ===================================================================== camadas + histórico (botão voltar do Android)
// Cada camada (player maximizado, pesquisa, menu) cria uma entrada no histórico. O botão
// "voltar" fecha a camada do topo em vez de sair da página.
const layers = [];
function pushLayer(name, close) {
  layers.push({ name, close });
  history.pushState({ dir: B.path, layer: name }, '', location.href);
}
function closeLayer(name) {
  const top = layers[layers.length - 1];
  if (top && (!name || top.name === name)) history.back();
}
function dropLayer(name) {
  // remove sem mexer no histórico (ex.: camada fechada por outra ação)
  const i = layers.findIndex((l) => l.name === name);
  if (i >= 0) layers.splice(i, 1);
}
addEventListener('popstate', (e) => {
  if (layers.length) { const l = layers.pop(); l.close(); return; }
  const st = e.state || {};
  B.load(st.dir != null ? st.dir : pathFromHash(), false);
});
function pathFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  try { return decodeURIComponent(h); } catch { return h; }
}

// ===================================================================== bottom sheet
const Sheet = {
  open(render) {
    const body = $('#sheet-body');
    const isOpen = !$('#sheet').classList.contains('hidden');
    body.innerHTML = '';
    render(body);
    if (!isOpen) {
      $('#sheet').classList.remove('hidden'); $('#sheet-backdrop').classList.remove('hidden');
      pushLayer('sheet', () => Sheet.hide());
    }
  },
  hide() { $('#sheet').classList.add('hidden'); $('#sheet-backdrop').classList.add('hidden'); },
  close() { if (!$('#sheet').classList.contains('hidden')) closeLayer('sheet'); },
  row(parent, { ico, label, value, sel, toggle, on, chevron, onClick }) {
    const r = el('button', 'row' + (sel ? ' sel' : '') + (on ? ' on' : ''));
    r.innerHTML = (ico ? icon(ico) : (sel !== undefined ? `<span class="chk">${icon('check')}</span>` : '')) +
      `<span class="lbl">${esc(label)}</span>` + (value != null ? `<span class="val">${esc(value)}</span>` : '') +
      (toggle ? '<span class="sw"></span>' : '') + (chevron ? icon('right') : '');
    r.onclick = onClick;
    parent.appendChild(r);
    return r;
  },
  header(parent, title, back) {
    const h = el('h3');
    if (back) { const b = el('button', 'icon-btn', icon('back')); b.onclick = back; h.appendChild(b); }
    h.appendChild(document.createTextNode(title));
    parent.appendChild(h);
  },
};
$('#sheet-backdrop').onclick = () => Sheet.close();

// ===================================================================== favoritos (guardados no servidor)
const Fav = {
  items: [], set: new Set(),
  apply(r) { this.items = r.items || []; this.set = new Set(this.items.map((i) => i.path)); },
  async load() { try { this.apply(await api('favorites')); } catch { /* sem favoritos */ } },
  has(p) { return this.set.has(p); },
  async toggle(p, name) {
    const on = !this.has(p);
    try {
      const r = await fetch(`/api/favorites?${qs({ path: p, on: on ? 1 : 0 })}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Erro');
      this.apply(j);
      toast(on ? `★ ${name || basename(p) || 'Início'} adicionado aos favoritos` : 'Removido dos favoritos');
    } catch (e) { toast('Favoritos: ' + e.message); }
    B.render(); if (Search.open) Search.run(); P.updateFav();
  },
};

// ===================================================================== navegador de arquivos
const B = {
  path: '', entries: [], loadSeq: 0,

  async load(p, push = true) {
    p = (p || '').replace(/^\/+|\/+$/g, '');
    const seq = ++this.loadSeq;
    if (push && p !== this.path) history.pushState({ dir: p }, '', '#/' + encodeURIComponent(p).replace(/%2F/g, '/'));
    this.path = p;
    this.renderChrome();
    const list = $('#list');
    const loadT = setTimeout(() => $('#loading').classList.remove('hidden'), 200);
    $('#empty').classList.add('hidden');
    try {
      const r = await api('list', { path: p });
      if (seq !== this.loadSeq) return;
      this.entries = r.entries;
      this.render();
      window.scrollTo(0, store.get('scroll:' + p, 0));
    } catch (e) {
      if (seq !== this.loadSeq) return;
      list.innerHTML = '';
      $('#empty').innerHTML = `${icon('info')}${esc(e.message)}<br><br><button class="btn" onclick="B.load('')">Ir para o início</button>`;
      $('#empty').classList.remove('hidden');
    } finally {
      clearTimeout(loadT);
      if (seq === this.loadSeq) $('#loading').classList.add('hidden');
    }
  },

  renderChrome() {
    const p = this.path;
    $('#btn-up').classList.toggle('hidden', !p);
    $('#title').textContent = p ? basename(p) : 'Zima Video';
    $('#btn-view').innerHTML = icon(prefs.view === 'grid' ? 'list' : 'grid');
    const crumbs = $('#crumbs');
    crumbs.innerHTML = '';
    const parts = p ? p.split('/') : [];
    const home = el('button', 'crumb' + (parts.length ? '' : ' current'), `${icon('home')}Início`);
    home.onclick = () => this.load('');
    crumbs.appendChild(home);
    parts.forEach((name, i) => {
      const c = el('button', 'crumb' + (i === parts.length - 1 ? ' current' : ''));
      c.textContent = name;
      c.onclick = () => this.load(parts.slice(0, i + 1).join('/'));
      crumbs.appendChild(c);
    });
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    document.title = p ? `${basename(p)} — Zima Video` : 'Zima Video';
  },

  sorted(entries) {
    const by = {
      name: (a, b) => collator.compare(a.name, b.name),
      'name-desc': (a, b) => collator.compare(b.name, a.name),
      date: (a, b) => b.mtime - a.mtime,
      size: (a, b) => b.size - a.size,
    }[prefs.sort] || ((a, b) => collator.compare(a.name, b.name));
    return entries.slice().sort((a, b) => ((b.type === 'dir') - (a.type === 'dir')) || by(a, b));
  },

  visible() {
    const media = new Set(['dir', 'video', 'audio', 'image']);
    return this.sorted(this.entries.filter((e) => !prefs.mediaOnly || media.has(e.type)));
  },

  render() {
    const list = $('#list');
    list.className = 'list' + (prefs.view === 'grid' ? ' grid' : '');
    list.innerHTML = '';
    const items = this.visible();
    const frag = document.createDocumentFragment();
    for (const e of items) frag.appendChild(renderItem({ ...e, path: (this.path ? this.path + '/' : '') + e.name }));
    list.appendChild(frag);
    if (!items.length) {
      const hidden = this.entries.length - items.length;
      $('#empty').innerHTML = `${icon('folder')}Pasta vazia` + (hidden ? `<br><small>${hidden} arquivo(s) oculto(s) pelo filtro "Somente mídia"</small>` : '');
      $('#empty').classList.remove('hidden');
    }
    $('#favorites .list-h') && $('#favorites .list-h').remove();
    this.renderFavorites();
    this.renderContinue();
    if (P.item) markPlaying(P.item.path);
    Preview.refresh();
  },

  renderFavorites() {
    const sec = $('#favorites');
    const items = this.path ? [] : Fav.items;
    sec.classList.toggle('hidden', !items.length);
    const ul = $('#fav-list');
    ul.className = 'list' + (prefs.view === 'grid' ? ' grid' : '');
    ul.innerHTML = '';
    if (!items.length) return;
    const frag = document.createDocumentFragment();
    for (const e of items) {
      const li = renderItem(e, { showPath: true });
      if (e.missing) {
        li.classList.add('missing');
        $('.item-meta', li).textContent = 'não encontrado (movido ou apagado)';
        li.onclick = () => Sheet.open((b) => {
          b.appendChild(el('div', 'sheet-title', esc(e.name)));
          b.appendChild(el('div', 'sheet-note', 'Este item não existe mais no servidor.'));
          Sheet.row(b, { ico: 'close', label: 'Remover dos favoritos', onClick: () => { Sheet.close(); Fav.toggle(e.path, e.name); } });
        });
      }
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    if (this.entries.length) { const h = el('div', 'list-h', 'Pastas e arquivos'); sec.appendChild(h); }
  },

  renderContinue() {
    const sec = $('#continue');
    if (this.path) { sec.classList.add('hidden'); return; }
    const recent = Object.entries(progress).filter(([, v]) => v.t > 5 && !v.w).sort((a, b) => b[1].at - a[1].at).slice(0, 12);
    sec.classList.toggle('hidden', !recent.length);
    const box = $('#continue-list');
    box.innerHTML = '';
    for (const [p, v] of recent) {
      const c = el('div', 'card');
      c.innerHTML = `<div class="thumb" data-pv="${esc(p)}">${icon('video')}<img alt="" loading="lazy"><div class="prog" style="width:${(v.t / v.d) * 100}%"></div>
        <span class="badge">${fmtTime(v.d - v.t)} restantes</span></div><div class="item-name">${esc(stripExt(basename(p)))}</div>`;
      loadThumb($('img', c), p);
      c.onclick = () => P.open({ path: p, name: basename(p), type: 'video' });
      bindLongPress(c, () => itemMenu({ path: p, name: basename(p), type: 'video' }));
      box.appendChild(c);
    }
  },
};

function loadThumb(img, p) {
  img.onload = () => img.classList.add('ok');
  img.onerror = () => img.remove();
  img.src = thumbUrl(p);
}

function typeIcon(t) { return { dir: 'folder', video: 'video', audio: 'audio', image: 'image', subtitle: 'subtitle' }[t] || 'file'; }

function renderItem(e, { showPath = false, highlight = null } = {}) {
  const li = el('li', `item ${e.type}`);
  li.dataset.path = e.path;
  const pr = progress[e.path];
  const ext = e.type !== 'dir' ? extname(e.name) : '';
  let thumb = `<div class="thumb"${e.type === 'video' ? ` data-pv="${esc(e.path)}"` : ''}>${icon(typeIcon(e.type))}`;
  if (e.type === 'video' || e.type === 'audio' || e.type === 'image') thumb += '<img alt="" loading="lazy" decoding="async">';
  if (e.type === 'video' && ext) thumb += `<span class="ext">${esc(ext)}</span>`;
  if (pr && pr.d) thumb += pr.w ? '<div class="prog" style="width:100%;opacity:.6"></div>' : `<div class="prog" style="width:${(pr.t / pr.d) * 100}%"></div>`;
  if (pr && pr.d && e.type === 'video') thumb += `<span class="badge">${fmtTime(pr.d)}</span>`;
  thumb += '</div>';
  const meta = [];
  if (e.type !== 'dir' && e.size) meta.push(fmtSize(e.size));
  if (e.mtime) meta.push(fmtDate(e.mtime));
  if (pr && pr.w) meta.push('assistido');
  else if (pr && pr.t > 5) meta.push(`parou em ${fmtTime(pr.t)}`);
  let name = esc(e.type === 'video' ? stripExt(e.name) : e.name);
  if (highlight) name = highlightTerms(name, highlight);
  if (Fav.has(e.path)) name = `<svg class="fav-star"><use href="#i-star"/></svg>` + name;
  li.innerHTML = `${thumb}<div class="item-body"><div class="item-name">${name}</div>` +
    (showPath ? `<div class="item-path">&lrm;${esc(dirname(e.path) || 'Início')}&lrm;</div>` : '') +
    `<div class="item-meta">${esc(meta.join(' · '))}</div></div>` +
    `<button class="icon-btn item-more" aria-label="Mais opções">${icon('more')}</button>`;
  const img = $('img', li);
  if (img) {
    if (e.type === 'image') { img.onload = () => img.classList.add('ok'); img.onerror = () => img.remove(); img.src = thumbUrl(e.path, null, 240); }
    else loadThumb(img, e.path);
  }
  li.onclick = (ev) => {
    if (ev.target.closest('.item-more')) { ev.stopPropagation(); return itemMenu(e); }
    openEntry(e);
  };
  bindLongPress(li, () => itemMenu(e));
  return li;
}

function highlightTerms(html, terms) {
  // destaca termos ignorando acentos (o html já está escapado e é texto simples)
  const plain = norm(html);
  const marks = new Array(html.length).fill(false);
  for (const t of terms) { let i = -1; while ((i = plain.indexOf(t, i + 1)) >= 0) for (let k = i; k < i + t.length; k++) marks[k] = true; }
  if (plain.length !== html.length) return html;
  let out = ''; let open = false;
  for (let i = 0; i < html.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += html[i];
  }
  return out + (open ? '</mark>' : '');
}

function bindLongPress(node, fn) {
  let timer = null; let sx = 0; let sy = 0; let fired = false;
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fired = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; navigator.vibrate && navigator.vibrate(15); fn(); }, 550);
  });
  const cancel = () => clearTimeout(timer);
  node.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!fired) { cancel(); fn(); } });
}

function markPlaying(p) {
  document.querySelectorAll('.item.playing').forEach((n) => n.classList.remove('playing'));
  document.querySelectorAll('.item').forEach((n) => { if (n.dataset.path === p) n.classList.add('playing'); });
}

function openEntry(e) {
  if (e.type === 'dir') { if (Search.open) Search.close(true); return B.load(e.path); }
  if (e.type === 'video' || e.type === 'audio') {
    const siblings = Search.open || dirname(e.path) !== B.path ? null : B.visible().filter((x) => x.type === 'video' || x.type === 'audio')
      .map((x) => ({ ...x, path: (B.path ? B.path + '/' : '') + x.name }));
    return P.open(e, { siblings });
  }
  if (e.type === 'image') return Viewer.show(e.path);
  itemMenu(e);
}

function itemMenu(e) {
  Sheet.open((b) => {
    b.appendChild(el('div', 'sheet-title', esc(e.name)));
    if (e.type === 'video' || e.type === 'audio') {
      Sheet.row(b, { ico: 'play', label: 'Reproduzir', onClick: () => { Sheet.close(); openEntry(e); } });
      if (progress[e.path] && progress[e.path].t > 5) {
        Sheet.row(b, { ico: 'replay', label: 'Reproduzir do início', onClick: () => { Sheet.close(); P.open(e, { from: 0 }); } });
      }
      if (progress[e.path]) {
        Sheet.row(b, { ico: 'close', label: 'Limpar progresso', onClick: () => { delete progress[e.path]; progressDirty = true; flushProgress(); Sheet.close(); B.render(); } });
      } else {
        Sheet.row(b, { ico: 'check', label: 'Marcar como assistido', onClick: () => { progress[e.path] = { t: 0, d: 1, at: Date.now(), w: true }; progressDirty = true; flushProgress(); Sheet.close(); B.render(); } });
      }
    }
    if (e.type === 'dir') Sheet.row(b, { ico: 'folder', label: 'Abrir pasta', onClick: () => { Sheet.close(); if (Search.open) Search.close(true); B.load(e.path); } });
    else if (dirname(e.path) !== B.path || Search.open) {
      Sheet.row(b, { ico: 'folder', label: 'Abrir pasta', onClick: () => { Sheet.close(); if (Search.open) Search.close(true); B.load(dirname(e.path)); } });
    }
    const fav = Fav.has(e.path);
    Sheet.row(b, { ico: fav ? 'star' : 'star-o', label: fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos', onClick: () => { Sheet.close(); Fav.toggle(e.path, e.name); } });
    if (e.type === 'dir') {
      Sheet.row(b, { ico: 'link', label: 'Copiar link da pasta', onClick: () => { Sheet.close(); copyText(`${location.origin}/#/${encodeURIComponent(e.path).replace(/%2F/g, '/')}`); } });
      return;
    }
    Sheet.row(b, { ico: 'download', label: 'Baixar', onClick: () => { Sheet.close(); location.href = fileUrl(e.path, { download: 1 }); } });
    Sheet.row(b, { ico: 'link', label: 'Copiar link do arquivo', onClick: () => { Sheet.close(); copyText(location.origin + fileUrl(e.path)); } });
    if (e.size) b.appendChild(el('div', 'sheet-note', esc([fmtSize(e.size), e.mtime ? new Date(e.mtime).toLocaleString('pt-BR') : ''].filter(Boolean).join(' · '))));
  });
}

function browserMenu() {
  Sheet.open((b) => {
    if (B.path) {
      const fav = Fav.has(B.path);
      Sheet.row(b, { ico: fav ? 'star' : 'star-o', label: fav ? 'Remover pasta dos favoritos' : 'Favoritar esta pasta', onClick: () => { Sheet.close(); Fav.toggle(B.path); } });
    }
    const sorts = [['name', 'Nome (A–Z)'], ['name-desc', 'Nome (Z–A)'], ['date', 'Mais recentes'], ['size', 'Maior tamanho']];
    Sheet.header(b, 'Ordenar por');
    for (const [k, label] of sorts) Sheet.row(b, { label, sel: prefs.sort === k, onClick: () => { prefs.sort = k; savePrefs(); Sheet.close(); B.render(); } });
    Sheet.header(b, 'Exibição');
    Sheet.row(b, { ico: 'video', label: 'Somente mídia e pastas', toggle: true, on: prefs.mediaOnly, onClick: (ev) => { prefs.mediaOnly = !prefs.mediaOnly; savePrefs(); ev.currentTarget.classList.toggle('on', prefs.mediaOnly); B.render(); } });
    Sheet.row(b, { ico: 'autoplay', label: 'Prévia em vídeo nas miniaturas', toggle: true, on: prefs.previews, onClick: (ev) => { prefs.previews = !prefs.previews; savePrefs(); ev.currentTarget.classList.toggle('on', prefs.previews); if (!prefs.previews) Preview.stop(); else Preview.refresh(); } });
    Sheet.row(b, { ico: prefs.view === 'grid' ? 'list' : 'grid', label: prefs.view === 'grid' ? 'Ver em lista' : 'Ver em grade', onClick: () => { toggleView(); Sheet.close(); } });
    Sheet.row(b, { ico: 'refresh', label: 'Atualizar pasta', onClick: () => { Sheet.close(); B.load(B.path, false); } });
    Sheet.row(b, { ico: 'search', label: 'Reindexar pesquisa', onClick: async () => { Sheet.close(); toast('Reindexando…'); try { const r = await api('reindex'); toast(`${r.count.toLocaleString('pt-BR')} itens indexados`); } catch (e) { toast(e.message); } } });
  });
}
function toggleView() { prefs.view = prefs.view === 'grid' ? 'list' : 'grid'; savePrefs(); B.renderChrome(); B.render(); }

addEventListener('scroll', () => { if (!Search.open) store.set('scroll:' + B.path, Math.round(scrollY)); }, { passive: true });
$('#btn-up').onclick = () => B.load(dirname(B.path));
$('#brand').onclick = () => B.load('');
$('#btn-view').onclick = toggleView;
$('#btn-menu').onclick = browserMenu;

// ===================================================================== pesquisa
const Search = {
  open: false, scope: 'here', seq: 0, timer: null,
  show() {
    if (this.open) return;
    this.open = true;
    $('#search').classList.remove('hidden');
    $('#scope-here').classList.toggle('hidden', !B.path);
    if (!B.path) this.setScope('all');
    $('#chip-media').classList.toggle('active', prefs.mediaOnly);
    document.body.classList.add('lock');
    pushLayer('search', () => this.hide());
    setTimeout(() => $('#search-input').focus(), 50);
    if ($('#search-input').value) this.run();
  },
  hide() { Preview.stop(); Preview.schedule(500); this.open = false; $('#search').classList.add('hidden'); document.body.classList.remove('lock'); $('#search-input').blur(); },
  close(silent) { if (silent) { dropLayer('search'); this.hide(); history.replaceState({ dir: B.path }, '', location.href); } else closeLayer('search'); },
  setScope(s) {
    this.scope = s;
    document.querySelectorAll('.chip[data-scope]').forEach((c) => c.classList.toggle('active', c.dataset.scope === s));
  },
  async run() {
    const q = $('#search-input').value.trim();
    $('#search-clear').classList.toggle('hidden', !q);
    const res = $('#search-results');
    const seq = ++this.seq;
    if (q.length < 2) { res.innerHTML = ''; $('#search-status').textContent = q ? 'Digite ao menos 2 letras' : ''; return; }
    $('#search-status').textContent = 'Pesquisando…';
    try {
      const r = await api('search', { q, scope: this.scope === 'here' ? B.path : '', media: prefs.mediaOnly ? 1 : 0 });
      if (seq !== this.seq) return;
      const terms = norm(q).split(/\s+/).filter(Boolean);
      res.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const e of r.results) frag.appendChild(renderItem(e, { showPath: true, highlight: terms }));
      res.appendChild(frag);
      Preview.schedule(600);
      $('#search-status').textContent = r.total ? `${r.total.toLocaleString('pt-BR')} resultado(s)` + (r.total > r.results.length ? ` — mostrando ${r.results.length}` : '') : 'Nada encontrado';
    } catch (e) {
      if (seq === this.seq) $('#search-status').textContent = e.message;
    }
  },
};
$('#btn-search').onclick = () => Search.show();
$('#search-close').onclick = () => Search.close();
$('#search-input').addEventListener('input', () => { clearTimeout(Search.timer); Search.timer = setTimeout(() => Search.run(), 250); });
$('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(Search.timer); Search.run(); e.target.blur(); } });
$('#search-clear').onclick = () => { $('#search-input').value = ''; Search.run(); $('#search-input').focus(); };
document.querySelectorAll('.chip[data-scope]').forEach((c) => { c.onclick = () => { Search.setScope(c.dataset.scope); Search.run(); }; });
$('#chip-media').onclick = (e) => { prefs.mediaOnly = !prefs.mediaOnly; savePrefs(); e.currentTarget.classList.toggle('active', prefs.mediaOnly); Search.run(); B.render(); };

// ===================================================================== visualizador de imagem
const Viewer = {
  show(p) {
    $('#viewer-img').src = fileUrl(p);
    $('#viewer').classList.remove('hidden');
    pushLayer('viewer', () => { $('#viewer').classList.add('hidden'); $('#viewer-img').removeAttribute('src'); });
  },
};
$('#viewer').onclick = () => closeLayer('viewer');

// ===================================================================== legendas (renderização própria)
function parseVTT(text) {
  const cues = [];
  const toSec = (t) => { const p = t.trim().replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = toSec(a); const end = toSec(b.trim().split(/\s+/)[0]);
    if (!isFinite(start) || !isFinite(end)) continue;
    let html = esc(lines.slice(i + 1).join('\n').replace(/\{\\[^}]*\}/g, ''))
      .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
      .replace(/&lt;[^&]*?&gt;/g, '');
    if (html.trim()) cues.push({ start, end, html });
  }
  cues.sort((x, y) => x.start - y.start);
  return cues;
}

// ===================================================================== prévia em vídeo nas miniaturas (estilo YouTube)
// Celular: a miniatura mais centralizada toca sozinha quando a rolagem para.
// Desktop: toca ao passar o mouse.
const Preview = {
  el: null, cur: null, timer: null, hoverTimer: null, failed: new Set(),
  get enabled() {
    const c = navigator.connection;
    return prefs.previews && !(c && c.saveData) && P.state !== 'max' && !document.hidden;
  },
  video() {
    if (!this.el) {
      const v = document.createElement('video');
      v.className = 'pv'; v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true;
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.preload = 'auto'; v.disablePictureInPicture = true;
      v.addEventListener('playing', () => v.classList.add('on'));
      v.addEventListener('timeupdate', () => { const bar = v.parentNode && v.parentNode.querySelector('.pv-bar'); if (bar && v.duration) bar.style.width = (v.currentTime / v.duration) * 100 + '%'; });
      v.addEventListener('error', () => { if (this.cur) this.failed.add(this.cur.dataset.pv); this.stop(); });
      this.el = v;
    }
    return this.el;
  },
  start(thumb) {
    if (!thumb || this.cur === thumb || !this.enabled || this.failed.has(thumb.dataset.pv)) return;
    this.stop();
    this.cur = thumb;
    const v = this.video();
    v.classList.remove('on');
    thumb.appendChild(v);
    if (!thumb.querySelector('.pv-bar')) thumb.appendChild(el('div', 'pv-bar'));
    thumb.classList.add('previewing');
    v.src = `/api/preview?${qs({ path: thumb.dataset.pv })}`;
    v.play().catch(() => {});
  },
  stop() {
    if (!this.cur) return;
    const v = this.el;
    v.pause(); v.classList.remove('on'); v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    v.remove();
    this.cur.classList.remove('previewing');
    const bar = this.cur.querySelector('.pv-bar'); if (bar) bar.remove();
    this.cur = null;
  },
  // escolhe a miniatura mais próxima do centro da tela, totalmente visível
  pick() {
    if (!IS_TOUCH || !this.enabled) { if (!this.enabled) this.stop(); return; }
    const scope = Search.open ? $('#search') : document;
    const top = Search.open ? $('.search-bar').getBoundingClientRect().bottom : $('#crumbs').getBoundingClientRect().bottom;
    const bottom = innerHeight - (P.state === 'mini' ? 80 : 0);
    const target = top + (bottom - top) * 0.42;
    let best = null; let bestD = Infinity;
    for (const t of scope.querySelectorAll('.thumb[data-pv]')) {
      if (this.failed.has(t.dataset.pv)) continue;
      const r = t.getBoundingClientRect();
      if (!r.width || r.top < top - 1 || r.bottom > bottom + 1 || r.left < -1 || r.right > innerWidth + 1) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - target);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) this.start(best); else this.stop();
  },
  schedule(delay = 450) { clearTimeout(this.timer); this.timer = setTimeout(() => this.pick(), delay); },
  refresh() { if (this.cur && !document.contains(this.cur)) { this.cur = null; } this.schedule(600); },
};
const onScrollPv = () => {
  // rolando: a prévia atual some se sair da tela; a nova começa quando a rolagem para
  if (Preview.cur) { const r = Preview.cur.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) Preview.stop(); }
  Preview.schedule();
};
addEventListener('scroll', onScrollPv, { passive: true });
$('#search').addEventListener('scroll', onScrollPv, { passive: true });
$('#continue-list').addEventListener('scroll', onScrollPv, { passive: true });
addEventListener('resize', () => Preview.schedule());
document.addEventListener('visibilitychange', () => { if (document.hidden) Preview.stop(); else Preview.schedule(); });
// desktop: passar o mouse
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const t = e.target.closest && e.target.closest('.thumb[data-pv]');
  if (!t || t === Preview.cur) return;
  clearTimeout(Preview.hoverTimer);
  Preview.hoverTimer = setTimeout(() => Preview.start(t), 350);
});
document.addEventListener('pointerout', (e) => {
  if (e.pointerType !== 'mouse') return;
  const t = e.target.closest && e.target.closest('.thumb[data-pv]');
  if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
  clearTimeout(Preview.hoverTimer);
  if (Preview.cur === t) Preview.stop();
});

// ===================================================================== player
const video = $('#video');
const stage = $('#stage');
const player = $('#player');

const VCODEC = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', vp9: 'vp09.00.40.08', vp8: 'vp8', av1: 'av01.0.08M.08', theora: 'theora' };
const ACODEC = { aac: 'mp4a.40.2', mp3: 'mp4a.6B', opus: 'opus', vorbis: 'vorbis', flac: 'flac', ac3: 'ac-3', eac3: 'ec-3', alac: 'alac' };
const CONTAINER = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg' };
const AUDIO_DIRECT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs="opus"', webm: 'audio/webm' };
const LANG = { por: 'Português', pt: 'Português', 'pt-br': 'Português (BR)', eng: 'Inglês', en: 'Inglês', spa: 'Espanhol', es: 'Espanhol', jpn: 'Japonês', ja: 'Japonês', fre: 'Francês', fra: 'Francês', fr: 'Francês', ger: 'Alemão', deu: 'Alemão', de: 'Alemão', ita: 'Italiano', it: 'Italiano', kor: 'Coreano', ko: 'Coreano', chi: 'Chinês', zho: 'Chinês', rus: 'Russo', und: '' };
const langName = (l) => (l && (LANG[l.toLowerCase()] ?? l.toUpperCase())) || '';
const isPt = (s) => /(^|[^a-z])(pt|por|pt-br|ptbr|portugu)/i.test(s || '');

function videoPlayable(info, container) {
  const v = info.video;
  if (!v) return true;
  if (v.codec === 'h264' && /10|12|422|444/.test(v.pix_fmt || '')) return false; // High10 etc. não decodificam em navegadores
  const c = VCODEC[v.codec];
  return !!c && video.canPlayType(`${container}; codecs="${c}"`) !== '';
}
function canDirect(item, info, audioIdx) {
  const ext = extname(item.path);
  if (audioIdx > 0 && info.audio.length > 1) return false;
  if (!info.video) {
    const m = AUDIO_DIRECT[ext];
    return !!m && video.canPlayType(m) !== '';
  }
  const container = CONTAINER[ext];
  if (!container) return false;
  if (!videoPlayable(info, container)) return false;
  const a = info.audio[0];
  if (a) {
    const ac = ACODEC[a.codec];
    if (!ac || video.canPlayType(`${container}; codecs="${VCODEC[info.video.codec]},${ac}"`) === '') return false;
  }
  return true;
}

let hlsLib = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLib) return hlsLib;
  hlsLib = new Promise((res, rej) => {
    const s = el('script'); s.src = 'vendor/hls.light.min.js';
    s.onload = () => res(window.Hls); s.onerror = () => rej(new Error('Falha ao carregar hls.js'));
    document.head.appendChild(s);
  });
  return hlsLib;
}

const P = {
  item: null, info: null, mode: null, offset: 0, audio: 0, quality: 0, hls: null,
  cues: null, subSel: null, siblings: [], state: 'hidden', fs: false, triedModes: [],
  lastSave: 0, loadSeq: 0, wantPlay: true, upnextTimer: null,

  // tempo absoluto (no modo remux o <video> começa do zero a cada seek no servidor)
  time() { return (this.mode === 'remux' ? this.offset : 0) + (video.currentTime || 0); },
  duration() { return (this.info && this.info.duration) || (isFinite(video.duration) ? video.duration : 0); },

  async open(item, { siblings = null, from = null } = {}) {
    this.saveProgress();
    const seq = ++this.loadSeq;
    this.cancelUpnext();
    if (siblings) this.siblings = siblings;
    else if (!this.siblings.some((s) => s.path === item.path)) { this.siblings = []; this.loadSiblings(item); }
    this.item = item;
    this.info = null; this.cues = null; this.subSel = null; this.triedModes = [];
    $('#subs').innerHTML = '';
    clearPreview($('#seek-img')); clearPreview($('#scrub-hint img'));
    this.showState('max');
    const title = item.type === 'video' ? stripExt(item.name) : item.name;
    $('#ctrl-title').textContent = title; $('#mini-title').textContent = title; $('#d-title').textContent = title;
    $('#mini-sub').textContent = dirname(item.path) || 'Início';
    $('#d-meta').textContent = 'Carregando…';
    $('#mode-badge').textContent = '';
    this.destroySource();
    spinner(true);
    this.renderDetails();
    this.updateFav();
    markPlaying(item.path);
    try {
      const info = await api('info', { path: item.path });
      if (seq !== this.loadSeq) return;
      this.info = info;
    } catch (e) {
      if (seq !== this.loadSeq) return;
      spinner(false);
      toast('Não foi possível ler o arquivo: ' + e.message, null, null, 5000);
      $('#d-meta').textContent = e.message;
      return;
    }
    const info = this.info;
    player.classList.toggle('portrait-video', !!(info.video && info.video.height > info.video.width));
    $('#audio-art').classList.toggle('hidden', !!info.video);
    if (!info.video) {
      const art = $('#audio-art'); art.innerHTML = icon('audio');
      const img = new Image(); img.onload = () => { art.innerHTML = ''; art.appendChild(img); }; img.src = thumbUrl(item.path, null, 640);
    }
    // faixa de áudio preferida
    this.audio = 0;
    const prefA = prefs.audioLang && info.audio.findIndex((a) => a.lang === prefs.audioLang);
    if (prefA > 0) this.audio = prefA;
    else { const d = info.audio.findIndex((a) => a.default); if (d > 0) this.audio = d; }
    this.quality = 0;
    this.renderMeta();
    // retomar
    const pr = progress[item.path];
    let start = 0;
    if (from != null) start = from;
    else if (pr && pr.t > 10 && !pr.w && pr.t < this.duration() - 10) {
      start = pr.t;
      toast(`Continuando de ${fmtTime(start)}`, 'Do início', () => this.seek(0), 4000);
    }
    this.mode = this.pickMode();
    this.wantPlay = true;
    this.load(start);
    this.autoSubtitle();
    this.setupMediaSession();
    this.updateCC();
  },

  pickMode(skip = []) {
    const order = [];
    if (this.quality === 0 && canDirect(this.item, this.info, this.audio)) order.push('direct');
    if (this.quality === 0 && !IS_APPLE && videoPlayable(this.info, 'video/mp4')) order.push('remux');
    order.push('hls');
    return order.find((m) => !skip.includes(m)) || null;
  },

  destroySource() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
  },

  async load(t = 0) {
    const seq = ++this.loadSeq;
    const item = this.item;
    const wasPlaying = this.wantPlay;
    this.destroySource();
    spinner(true);
    const mode = this.mode;
    this.triedModes.includes(mode) || this.triedModes.push(mode);
    $('#mode-badge').textContent = { direct: '', remux: 'REMUX', hls: this.quality ? `${this.quality}p` : 'CONV' }[mode] || '';
    video.playbackRate = prefs.rate;
    if (mode === 'direct') {
      video.src = fileUrl(item.path);
      this.offset = 0;
      if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
    } else if (mode === 'remux') {
      // o servidor diz onde buscar (s) e onde o vídeo realmente começa (l = deslocamento da linha do tempo)
      let plan = { s: t, l: t };
      if (this.info.video) {
        try { plan = await api('remux-plan', { path: item.path, t: t.toFixed(3) }); } catch { /* usa t */ }
        if (seq !== this.loadSeq) return;
      }
      this.offset = plan.l;
      video.src = `/api/stream?${qs({ path: item.path, t: plan.s.toFixed(3), audio: this.audio, mode: 'remux' })}`;
    } else {
      this.offset = 0;
      const src = `/api/hls/index.m3u8?${qs({ path: item.path, h: this.quality, audio: this.audio })}`;
      const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';
      let Hls = null;
      if (!(IS_APPLE && nativeHls)) { try { Hls = await loadHls(); } catch { /* fallback nativo */ } }
      if (seq !== this.loadSeq) return;
      if (Hls && Hls.isSupported()) {
        const pol = { maxTimeToFirstByteMs: 90000, maxLoadTimeMs: 180000, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 } };
        const hls = new Hls({ startPosition: t, maxBufferLength: 40, maxMaxBufferLength: 90, backBufferLength: 60, fragLoadPolicy: { default: pol }, enableWorker: true });
        this.hls = hls;
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
          this.fail('Erro na conversão: ' + (d.details || ''));
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (nativeHls) {
        video.src = src;
        if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
      } else return this.fail('Este navegador não suporta HLS');
    }
    if (wasPlaying) video.play().catch(() => { /* autoplay bloqueado → usuário toca no play */ updatePlayBtn(); showControls(); });
  },

  fail(msg) {
    if (!this.item || !this.info) return;
    const t = this.time();
    const next = this.pickMode(this.triedModes);
    if (next) {
      console.warn(`[player] modo ${this.mode} falhou (${msg}), tentando ${next}`);
      this.mode = next;
      this.load(t);
      return;
    }
    spinner(false);
    toast(msg || 'Não foi possível reproduzir este arquivo', null, null, 6000);
  },

  seek(t) {
    const d = this.duration();
    t = clamp(t, 0, d ? d - 0.25 : Infinity);
    if (this.mode === 'remux') {
      const rel = t - this.offset;
      if (rel >= 0 && inBuffered(rel)) { video.currentTime = rel; }
      else { this.wantPlay = !video.paused || this.wantPlay; this.load(t); }
    } else video.currentTime = t;
    this.cancelUpnext();
    updateTime();
  },
  seekBy(dt) { this.seek(this.time() + dt); },

  togglePlay() {
    if (!this.item) return;
    if (video.paused || video.ended) { if (video.ended) this.seek(0); this.wantPlay = true; video.play().catch(() => {}); }
    else { this.wantPlay = false; video.pause(); }
  },

  saveProgress() {
    if (!this.item || !this.info) return;
    const d = this.duration();
    if (d > 30) setProgress(this.item.path, this.time(), d);
  },

  // ---------- estados da janela: max | mini | hidden
  showState(s) {
    const prev = this.state;
    this.state = s;
    player.classList.remove('hidden', 'max', 'mini', 'dragging', 'leaving');
    player.style.transform = ''; player.style.opacity = '';
    if (s === 'hidden') { player.classList.add('hidden'); document.body.classList.remove('lock'); Preview.schedule(500); return; }
    player.classList.add(s);
    document.body.classList.toggle('lock', s === 'max');
    if (s === 'max') Preview.stop(); else Preview.schedule(500);
    if (s === 'max' && prev !== 'max') pushLayer('player', () => this.minimize(true));
    if (s === 'max') { player.scrollTop = 0; showControls(); }
  },
  minimize(fromHistory = false) {
    if (this.state !== 'max') return;
    if (this.fs) this.exitFullscreen();
    if (!fromHistory) { closeLayer('player'); return; }
    this.showState('mini');
  },
  maximize() { if (this.state === 'mini') this.showState('max'); },
  close() {
    this.saveProgress(); flushProgress();
    this.loadSeq++;
    this.cancelUpnext();
    if (this.state === 'max') { dropLayer('player'); history.back(); }
    if (this.fs) this.exitFullscreen();
    this.destroySource();
    this.item = null; this.info = null;
    this.showState('hidden');
    markPlaying(null);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    B.render();
  },

  // ---------- tela cheia
  async enterFullscreen() {
    this.fs = true;
    player.classList.add('fs');
    const fsEl = document.documentElement;
    try {
      this.nativeFs = false;
      if (fsEl.requestFullscreen) { await fsEl.requestFullscreen({ navigationUI: 'hide' }); this.nativeFs = true; }
      else if (fsEl.webkitRequestFullscreen) { fsEl.webkitRequestFullscreen(); this.nativeFs = true; }
    } catch { /* pseudo-fullscreen (iPhone) */ }
    const v = this.info && this.info.video;
    if (v && v.width > v.height && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    $('#btn-fs').innerHTML = icon('fs-exit');
    showControls();
  },
  exitFullscreen() {
    this.fs = false;
    player.classList.remove('fs');
    stage.classList.remove('zoom');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch { /* ignore */ }
    $('#btn-fs').innerHTML = icon('fs');
  },
  toggleFullscreen() { this.fs ? this.exitFullscreen() : this.enterFullscreen(); },

  // ---------- lista "nesta pasta"
  renderDetails() {
    const ul = $('#d-list');
    ul.innerHTML = '';
    const list = this.siblings;
    $('.d-next-h').classList.toggle('hidden', list.length < 2);
    if (list.length >= 2) {
      const frag = document.createDocumentFragment();
      for (const s of list) {
        const li = renderItem(s);
        li.onclick = (ev) => { if (ev.target.closest('.item-more')) return itemMenu(s); this.open(s); };
        frag.appendChild(li);
      }
      ul.appendChild(frag);
    }
    markPlaying(this.item && this.item.path);
    const i = this.index();
        $('#btn-next').disabled = i < 0 || i >= list.length - 1;
  },
  // aberto pela pesquisa/favoritos: carrega a pasta real do arquivo para "Nesta pasta" e próximo/anterior
  async loadSiblings(item) {
    try {
      const dir = dirname(item.path);
      const r = await api('list', { path: dir });
      if (this.item !== item) return;
      this.siblings = B.sorted(r.entries.filter((x) => x.type === 'video' || x.type === 'audio'))
        .map((x) => ({ ...x, path: (dir ? dir + '/' : '') + x.name }));
      this.renderDetails();
    } catch { /* sem lista */ }
  },
  updateFav() {
    const b = $('#d-fav'); if (!this.item) return;
    const on = Fav.has(this.item.path);
    b.classList.toggle('on', on);
    b.innerHTML = `${icon(on ? 'star' : 'star-o')}${on ? 'Favorito' : 'Favoritar'}`;
  },
  renderMeta() {
    const i = this.info; const parts = [];
    if (this.duration()) parts.push(fmtTime(this.duration()));
    if (i.video) parts.push(`${i.video.width}×${i.video.height}`, i.video.codec.toUpperCase());
    if (i.audio[this.audio]) parts.push(i.audio[this.audio].codec.toUpperCase() + (i.audio[this.audio].channels > 2 ? ` ${i.audio[this.audio].channels}ch` : ''));
    if (this.item.size) parts.push(fmtSize(this.item.size));
    $('#d-meta').textContent = parts.join(' · ');
    $('#t-dur').textContent = fmtTime(this.duration());
  },
  index() { return this.item ? this.siblings.findIndex((s) => s.path === this.item.path) : -1; },
  next() { const i = this.index(); if (i >= 0 && i < this.siblings.length - 1) this.open(this.siblings[i + 1]); },
  prev() {
    if (this.time() > 5) return this.seek(0);
    const i = this.index(); if (i > 0) this.open(this.siblings[i - 1]); else this.seek(0);
  },

  // ---------- a seguir (reprodução automática)
  onEnded() {
    this.saveProgress(); flushProgress();
    if (prefs.loop) { this.seek(0); video.play(); return; }
    const i = this.index();
    if (!prefs.autoplay || i < 0 || i >= this.siblings.length - 1) { showControls(true); return; }
    const nx = this.siblings[i + 1];
    let n = 5;
    $('#upnext-title').textContent = stripExt(nx.name);
    $('#upnext-count').textContent = n;
    $('#upnext').classList.remove('hidden');
    this.upnextTimer = setInterval(() => {
      n--; $('#upnext-count').textContent = n;
      if (n <= 0) { this.cancelUpnext(); this.open(nx); }
    }, 1000);
  },
  cancelUpnext() { clearInterval(this.upnextTimer); this.upnextTimer = null; $('#upnext').classList.add('hidden'); },

  // ---------- legendas
  subTracks() {
    if (!this.info) return [];
    const side = (this.info.sidecar || []).map((s) => ({ key: 'f:' + s.path, label: (LANG[(s.label || '').toLowerCase()] ? langName(s.label) : s.label) || s.name, file: s.path, lang: s.label }));
    const emb = this.info.subs.filter((s) => s.text).map((s) => ({
      key: 'e:' + s.index, track: s.index, lang: s.lang,
      label: [langName(s.lang), s.title, s.forced ? 'forçada' : ''].filter(Boolean).join(' — ') || `Faixa ${s.index + 1}`,
    }));
    return side.concat(emb);
  },
  async setSubtitle(tr, remember = true) {
    this.subSel = tr ? tr.key : null;
    this.cues = null;
    $('#subs').innerHTML = '';
    if (remember) { prefs.subLang = tr ? (tr.lang || tr.label || '') : ''; savePrefs(); }
    this.updateCC();
    if (!tr) return;
    const item = this.item;
    const slow = setTimeout(() => toast('Extraindo legenda…', null, null, 8000), 600);
    try {
      const url = tr.file ? `/api/subtitle?${qs({ file: tr.file })}` : `/api/subtitle?${qs({ path: item.path, track: tr.track })}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('falha ao carregar legenda');
      const cues = parseVTT(await r.text());
      if (this.item !== item || this.subSel !== tr.key) return;
      this.cues = cues;
      clearTimeout(slow); $('#toast').classList.remove('on');
      if (!cues.length) toast('Legenda vazia ou em formato de imagem');
      renderSubs();
    } catch (e) { clearTimeout(slow); toast('Legenda: ' + e.message); }
  },
  autoSubtitle() {
    const tracks = this.subTracks();
    if (!tracks.length) return;
    let tr = null;
    if (prefs.subLang) tr = tracks.find((t) => (t.lang || t.label) === prefs.subLang) || (isPt(prefs.subLang) && tracks.find((t) => isPt(t.lang) || isPt(t.label)));
    if (!tr) { const f = this.info.subs.find((s) => s.text && s.forced && (isPt(s.lang) || !s.lang)); if (f) tr = tracks.find((t) => t.key === 'e:' + f.index); }
    if (tr) this.setSubtitle(tr, false);
  },
  updateCC() {
    const has = this.subTracks().length > 0;
    $('#btn-cc').classList.toggle('hidden', !has);
    $('#btn-cc').style.color = this.subSel ? 'var(--accent-2)' : '';
  },
  toggleCC() {
    const tr = this.subTracks();
    if (!tr.length) return toast('Sem legendas disponíveis');
    if (this.subSel) { this.setSubtitle(null); flash('Legendas desativadas'); }
    else {
      const pick = tr.find((t) => (t.lang || t.label) === prefs.subLang) || tr.find((t) => isPt(t.lang) || isPt(t.label)) || tr[0];
      this.setSubtitle(pick); flash(`Legendas: ${pick.label}`);
    }
  },

  setupMediaSession() {
    if (!('mediaSession' in navigator) || !this.item) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title: stripExt(this.item.name), artist: basename(dirname(this.item.path)) || 'Zima Video', album: 'Zima Video',
        artwork: [{ src: thumbUrl(this.item.path, null, 512), sizes: '512x288', type: 'image/jpeg' }],
      });
      const h = {
        play: () => { this.wantPlay = true; video.play(); }, pause: () => { this.wantPlay = false; video.pause(); },
        seekbackward: (d) => this.seekBy(-(d.seekOffset || 10)), seekforward: (d) => this.seekBy(d.seekOffset || 10),
        seekto: (d) => this.seek(d.seekTime), previoustrack: () => this.prev(), nexttrack: () => this.next(),
      };
      for (const [k, fn] of Object.entries(h)) { try { ms.setActionHandler(k, fn); } catch { /* não suportado */ } }
    } catch { /* ignore */ }
  },
};
window.P = P; window.B = B;

function inBuffered(t) {
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i) - 0.5) return true;
  return false;
}
function spinner(on) { $('#spinner').classList.toggle('hidden', !on); }

let flashTimer;
function flash(text) {
  const p = $('#info-pill'); p.textContent = text; p.classList.add('on');
  clearTimeout(flashTimer); flashTimer = setTimeout(() => p.classList.remove('on'), 900);
}

// ---------- eventos do <video>
video.addEventListener('waiting', () => spinner(true));
video.addEventListener('seeking', () => spinner(true));
video.addEventListener('playing', () => { spinner(false); updatePlayBtn(); scheduleHide(); });
video.addEventListener('canplay', () => spinner(false));
video.addEventListener('seeked', () => { if (video.readyState >= 3) spinner(false); renderSubs(); });
video.addEventListener('pause', () => { updatePlayBtn(); P.saveProgress(); showControls(true); });
video.addEventListener('play', updatePlayBtn);
video.addEventListener('ended', () => P.onEnded());
video.addEventListener('ratechange', () => { if (!boost.active) { prefs.rate = video.playbackRate; savePrefs(); } });
video.addEventListener('volumechange', () => {
  prefs.volume = video.volume; prefs.muted = video.muted; savePrefs();
  $('#btn-mute').innerHTML = icon(video.muted || video.volume === 0 ? 'mute' : 'vol');
  $('#vol').value = video.muted ? 0 : video.volume;
});
video.addEventListener('loadedmetadata', () => {
  if (P.info && P.info.video && P.mode === 'direct' && video.videoWidth === 0) P.fail('vídeo sem imagem');
  $('#t-dur').textContent = fmtTime(P.duration());
});
video.addEventListener('error', () => {
  if (!P.item || !video.getAttribute('src') && !P.hls) return;
  const err = video.error;
  P.fail(err ? `Erro de mídia (${err.code})` : 'Erro de mídia');
});
video.addEventListener('timeupdate', () => {
  updateTime(); renderSubs();
  if (Date.now() - P.lastSave > 5000) { P.lastSave = Date.now(); P.saveProgress(); }
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && P.duration()) {
    try { navigator.mediaSession.setPositionState({ duration: P.duration(), position: clamp(P.time(), 0, P.duration()), playbackRate: video.playbackRate || 1 }); } catch { /* ignore */ }
  }
});
video.addEventListener('progress', updateBuffer);
video.volume = prefs.volume; video.muted = prefs.muted;

function updatePlayBtn() {
  const paused = video.paused;
  $('#btn-play').innerHTML = icon(paused ? 'play' : 'pause');
  $('#mini-play').innerHTML = icon(paused ? 'play' : 'pause');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
}
let scrubbing = false;
function updateTime() {
  const d = P.duration(); const t = P.time();
  if (!scrubbing) {
    const pct = d ? (t / d) * 100 : 0;
    $('#seek-prog').style.width = pct + '%'; $('#seek-knob').style.left = pct + '%';
    $('#mini-prog').style.width = pct + '%';
    $('#t-cur').textContent = fmtTime(t);
  }
}
function updateBuffer() {
  const d = P.duration(); if (!d) return;
  const b = video.buffered; const cur = video.currentTime; let end = 0;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= cur + 1 && b.end(i) > end) end = b.end(i);
  const off = P.mode === 'remux' ? P.offset : 0;
  $('#seek-buf').style.width = clamp(((end + off) / d) * 100, 0, 100) + '%';
}
function renderSubs() {
  const box = $('#subs');
  if (!P.cues) { if (box.innerHTML) box.innerHTML = ''; return; }
  const t = P.time();
  const active = P.cues.filter((c) => c.start <= t && c.end > t);
  const html = active.map((c) => `<span>${c.html}</span>`).join('<br>');
  if (box.innerHTML !== html) box.innerHTML = html;
}

// ---------- visibilidade dos controles
let hideTimer;
function showControls(sticky = false) {
  stage.classList.add('show-ctrl');
  clearTimeout(hideTimer);
  if (!sticky) scheduleHide();
}
function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!video.paused && !scrubbing && !$('#sheet').offsetParent) stage.classList.remove('show-ctrl'); }, 3000);
}
function hideControls() { clearTimeout(hideTimer); stage.classList.remove('show-ctrl'); }

// ---------- botões
const onBtn = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); fn(e); if (P.state === 'max') showControls(); });
onBtn('#btn-play', () => P.togglePlay());
onBtn('#btn-next', () => P.next());
onBtn('#btn-prev', () => P.prev());
onBtn('#btn-min', () => P.minimize());
onBtn('#btn-fs', () => P.toggleFullscreen());
onBtn('#btn-settings', () => settingsMenu());
onBtn('#btn-cc', () => P.toggleCC());
onBtn('#btn-mute', () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 1; });
onBtn('#btn-pip', () => togglePiP());
$('#vol').addEventListener('input', (e) => { video.volume = +e.target.value; video.muted = video.volume === 0; });
$('#vol').addEventListener('pointerdown', (e) => e.stopPropagation());
$('#mini-play').onclick = (e) => { e.stopPropagation(); P.togglePlay(); };
$('#mini-close').onclick = (e) => { e.stopPropagation(); P.close(); };
$('#upnext-cancel').onclick = (e) => { e.stopPropagation(); P.cancelUpnext(); showControls(true); };
$('#upnext-go').onclick = (e) => { e.stopPropagation(); const i = P.index(); P.cancelUpnext(); if (i >= 0) P.open(P.siblings[i + 1]); };
$('#d-download').onclick = () => P.item && (location.href = fileUrl(P.item.path, { download: 1 }));
$('#d-fav').onclick = () => P.item && Fav.toggle(P.item.path, P.item.name);
$('#d-link').onclick = () => P.item && copyText(location.origin + fileUrl(P.item.path));
$('#d-folder').onclick = () => { if (!P.item) return; const d = dirname(P.item.path); P.minimize(); setTimeout(() => B.load(d), 50); };
if (!(document.pictureInPictureEnabled || video.webkitSupportsPresentationMode)) $('#btn-pip').classList.add('hidden');

async function togglePiP() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (video.requestPictureInPicture) await video.requestPictureInPicture();
    else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  } catch (e) { toast('Picture-in-picture indisponível'); }
}

document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && P.fs && P.nativeFs) P.exitFullscreen(); });
document.addEventListener('webkitfullscreenchange', () => { if (!document.webkitFullscreenElement && P.fs && P.nativeFs) P.exitFullscreen(); });

// ---------- menu de configurações do player
function settingsMenu() {
  if (!P.item || !P.info) return;
  const info = P.info;
  const main = () => Sheet.open((b) => {
    const qLabel = P.quality ? `${P.quality}p` : (info.video ? `Original (${info.video.height}p)` : 'Original');
    const tr = P.subTracks().find((t) => t.key === P.subSel);
    if (info.video) Sheet.row(b, { ico: 'hq', label: 'Qualidade', value: qLabel, chevron: true, onClick: quality });
    Sheet.row(b, { ico: 'speed', label: 'Velocidade', value: video.playbackRate === 1 ? 'Normal' : `${video.playbackRate}x`, chevron: true, onClick: speed });
    if (P.subTracks().length) Sheet.row(b, { ico: 'subtitle', label: 'Legendas', value: tr ? tr.label : 'Desativadas', chevron: true, onClick: subs });
    if (info.audio.length > 1) {
      const a = info.audio[P.audio];
      Sheet.row(b, { ico: 'audio', label: 'Faixa de áudio', value: audioLabel(a), chevron: true, onClick: audio });
    }
    Sheet.row(b, { ico: 'autoplay', label: 'Reprodução automática', toggle: true, on: prefs.autoplay, onClick: (e) => { prefs.autoplay = !prefs.autoplay; savePrefs(); e.currentTarget.classList.toggle('on', prefs.autoplay); } });
    Sheet.row(b, { ico: 'repeat', label: 'Repetir', toggle: true, on: prefs.loop, onClick: (e) => { prefs.loop = !prefs.loop; savePrefs(); e.currentTarget.classList.toggle('on', prefs.loop); } });
    if (!$('#btn-pip').classList.contains('hidden')) Sheet.row(b, { ico: 'pip', label: 'Picture-in-picture', onClick: () => { Sheet.close(); togglePiP(); } });
    const modeTxt = { direct: 'Reprodução direta (arquivo original)', remux: 'Remux: vídeo original, áudio convertido', hls: 'Convertendo no servidor (ffmpeg)' }[P.mode];
    b.appendChild(el('div', 'sheet-note', `${esc(modeTxt || '')}<br>${esc(info.format)} · ${info.video ? esc(info.video.codec) + ' ' + info.video.width + '×' + info.video.height : 'áudio'}${info.audio[P.audio] ? ' · ' + esc(info.audio[P.audio].codec) : ''}${info.bitrate ? ' · ' + Math.round(info.bitrate / 1000) + ' kb/s' : ''}`));
    if (P.mode !== 'hls') Sheet.row(b, { ico: 'refresh', label: 'Problemas? Forçar conversão', onClick: () => { Sheet.close(); const t = P.time(); P.mode = 'hls'; P.load(t); } });
  });
  const audioLabel = (a) => a ? ([langName(a.lang), a.title].filter(Boolean).join(' — ') || `Faixa ${a.index + 1}`) + ` (${a.codec}${a.channels ? ' ' + a.channels + 'ch' : ''})` : '';
  const quality = () => Sheet.open((b) => {
    Sheet.header(b, 'Qualidade', main);
    const h = info.video.height;
    Sheet.row(b, { label: `Original (${h}p)`, sel: P.quality === 0, onClick: () => setQ(0) });
    for (const q of [1080, 720, 480, 360]) if (q < h - 20 || (q <= h && P.mode !== 'direct')) Sheet.row(b, { label: `${q}p`, value: 'convertido', sel: P.quality === q, onClick: () => setQ(q) });
    b.appendChild(el('div', 'sheet-note', 'Qualidades menores convertem o vídeo no servidor — útil para assistir pela internet móvel.'));
  });
  const setQ = (q) => {
    Sheet.close();
    if (q === P.quality) return;
    const t = P.time(); P.quality = q; P.triedModes = []; P.mode = P.pickMode(); P.load(t);
    flash(q ? `${q}p` : 'Qualidade original');
  };
  const speed = () => Sheet.open((b) => {
    Sheet.header(b, 'Velocidade', main);
    for (const r of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      Sheet.row(b, { label: r === 1 ? 'Normal' : `${r}x`, sel: video.playbackRate === r, onClick: () => { video.playbackRate = r; Sheet.close(); flash(`${r}x`); } });
    }
  });
  const subs = () => Sheet.open((b) => {
    Sheet.header(b, 'Legendas', main);
    Sheet.row(b, { label: 'Desativadas', sel: !P.subSel, onClick: () => { Sheet.close(); P.setSubtitle(null); } });
    for (const t of P.subTracks()) Sheet.row(b, { label: t.label, value: t.file ? 'arquivo' : 'embutida', sel: P.subSel === t.key, onClick: () => { Sheet.close(); P.setSubtitle(t); } });
    const img = info.subs.filter((s) => !s.text).length;
    if (img) b.appendChild(el('div', 'sheet-note', `${img} legenda(s) em imagem (PGS/VobSub) não suportada(s).`));
  });
  const audio = () => Sheet.open((b) => {
    Sheet.header(b, 'Faixa de áudio', main);
    info.audio.forEach((a, i) => Sheet.row(b, {
      label: audioLabel(a), sel: P.audio === i,
      onClick: () => {
        Sheet.close();
        if (i === P.audio) return;
        prefs.audioLang = a.lang || ''; savePrefs();
        const t = P.time(); P.audio = i; P.triedModes = []; P.mode = P.pickMode(); P.load(t); P.renderMeta();
        flash(audioLabel(a));
      },
    }));
  });
  main();
}

// ===================================================================== gestos estilo YouTube
//  • toque: mostra/oculta controles          • 2 toques nas laterais: ±10s (toques extras acumulam)
//  • segurar: 2x enquanto segurar             • arrastar na horizontal: busca com prévia
//  • arrastar p/ baixo: minimiza (ou sai da tela cheia)    • arrastar p/ cima: tela cheia
//  • pinça (tela cheia): zoom para preencher  • mini player: arrastar p/ cima maximiza, p/ o lado fecha
const SKIP = 10;
const boost = { active: false, prevRate: 1 };
const g = { id: null, sx: 0, sy: 0, st: 0, axis: null, longTimer: null, pointers: new Map(), pinch0: 0, scrubT: 0 };
let tapTimer = null; let lastTap = { t: 0, x: 0, side: null }; let chain = { side: null, until: 0, total: 0 };
let rippleTimer;

function sideOf(x) {
  const r = stage.getBoundingClientRect(); const f = (x - r.left) / r.width;
  return f < 0.38 ? 'L' : f > 0.62 ? 'R' : 'C';
}
function doSkip(side) {
  const dir = side === 'L' ? -1 : 1;
  if (chain.side !== side || Date.now() > chain.until) chain.total = 0;
  chain.side = side; chain.total += SKIP; chain.until = Date.now() + 800;
  P.seekBy(dir * SKIP);
  const rp = side === 'L' ? $('#ripple-l') : $('#ripple-r');
  const other = side === 'L' ? $('#ripple-r') : $('#ripple-l');
  other.classList.remove('on');
  $('span', rp).textContent = `${chain.total} segundos`;
  rp.classList.remove('on'); void rp.offsetWidth; rp.classList.add('on');
  clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => { rp.classList.remove('on'); }, 750);
  hideControls();
}

function handleTap(x) {
  const now = Date.now();
  const side = sideOf(x);
  // corrente de toques: depois de um duplo toque, cada toque extra no mesmo lado soma mais 10s
  if (side !== 'C' && chain.side === side && now < chain.until) { clearTimeout(tapTimer); doSkip(side); lastTap = { t: now, side }; return; }
  if (now - lastTap.t < 300 && lastTap.side === side) {
    clearTimeout(tapTimer);
    lastTap = { t: 0, side: null };
    if (side === 'C') { P.toggleFullscreen(); return; }
    doSkip(side);
    return;
  }
  lastTap = { t: now, side };
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {
    if (stage.classList.contains('show-ctrl')) hideControls(); else showControls();
  }, 260);
}

function startBoost() {
  if (video.paused || boost.active) return;
  boost.active = true; boost.prevRate = video.playbackRate;
  video.playbackRate = Math.max(2, boost.prevRate * 2 > 3 ? 3 : 2);
  $('#speed-pill').innerHTML = `${video.playbackRate}x ${icon('ff')}`;
  $('#speed-pill').classList.add('on');
  hideControls();
  navigator.vibrate && navigator.vibrate(10);
}
function stopBoost() {
  if (!boost.active) return;
  video.playbackRate = boost.prevRate; boost.active = false;
  $('#speed-pill').classList.remove('on');
}

function scrubSecondsPerPx() {
  const w = stage.getBoundingClientRect().width; const d = P.duration() || 600;
  return clamp(d / (w * 3), 0.1, 6);
}
function setPreview(img, t) {
  // miniatura do frame na posição (arredondada a 5s, com throttle). A chave inclui o arquivo,
  // então nunca sobra imagem do vídeo anterior; cada <img> tem seu próprio estado.
  if (!P.item || !P.info || !P.info.video) { clearPreview(img); return; }
  const r = Math.round(t / 5) * 5;
  const key = `${P.item.path}|${r}`;
  if (img.dataset.want === key) return;
  img.dataset.want = key;
  clearTimeout(img._pvTimer);
  img._pvTimer = setTimeout(() => {
    const url = thumbUrl(P.item.path, r, 240);
    const pre = new Image();
    pre.onload = () => { if (img.dataset.want === key) img.src = url; };
    pre.src = url;
  }, 90);
}
function clearPreview(img) { clearTimeout(img._pvTimer); delete img.dataset.want; img.removeAttribute('src'); }

stage.addEventListener('pointerdown', (e) => {
  if (P.state !== 'max' || !P.item) return;
  if (e.target.closest('button, input, .seek, .upnext')) return;
  g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.pointers.size === 2) { // pinça
    clearTimeout(g.longTimer); stopBoost();
    const [a, b] = [...g.pointers.values()]; g.pinch0 = Math.hypot(a.x - b.x, a.y - b.y); g.axis = 'pinch';
    return;
  }
  if (e.pointerType === 'mouse') {
    if (e.button !== 0) return;
    g.id = e.pointerId; g.axis = 'mouse'; return;
  }
  g.id = e.pointerId; g.sx = e.clientX; g.sy = e.clientY; g.st = Date.now(); g.axis = null;
  try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  clearTimeout(g.longTimer);
  g.longTimer = setTimeout(() => { if (!g.axis) { g.axis = 'boost'; startBoost(); } }, 450);
});

stage.addEventListener('pointermove', (e) => {
  if (P.state !== 'max') return;
  if (e.pointerType === 'mouse' && !e.buttons) { showControls(); return; }
  if (g.pointers.has(e.pointerId)) g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.axis === 'pinch' && g.pointers.size === 2) {
    const [a, b] = [...g.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (P.fs && Math.abs(d - g.pinch0) > 50) {
      const zoom = d > g.pinch0; stage.classList.toggle('zoom', zoom); flash(zoom ? 'Zoom para preencher' : 'Tamanho original'); g.axis = 'pinch-done';
    }
    return;
  }
  if (e.pointerId !== g.id || g.axis === 'mouse') return;
  const dx = e.clientX - g.sx; const dy = e.clientY - g.sy;
  if (!g.axis) {
    if (Math.hypot(dx, dy) < 12) return;
    clearTimeout(g.longTimer);
    g.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    if (g.axis === 'h') {
      scrubbing = true; g.scrubT = P.time(); stage.classList.add('scrubbing'); hideControls();
      $('#scrub-hint').classList.remove('hidden');
    } else if (!P.fs && dy > 0) player.classList.add('dragging');
  }
  if (g.axis === 'h') {
    const t = clamp(g.scrubT + dx * scrubSecondsPerPx(), 0, P.duration());
    g.scrubTo = t;
    const pct = P.duration() ? (t / P.duration()) * 100 : 0;
    $('#seek-prog').style.width = pct + '%'; $('#seek-knob').style.left = pct + '%';
    const diff = t - g.scrubT;
    $('#scrub-hint span').textContent = `${fmtTime(t)}  (${diff >= 0 ? '+' : '−'}${fmtTime(Math.abs(diff))})`;
    setPreview($('#scrub-hint img'), t);
  } else if (g.axis === 'v' && !P.fs && dy > 0) {
    player.style.transform = `translateY(${dy}px)`;
    player.style.opacity = String(clamp(1 - dy / 900, 0.5, 1));
  }
});

function endGesture(e, cancelled) {
  if (g.pointers.has(e.pointerId)) g.pointers.delete(e.pointerId);
  if (g.axis && g.axis.startsWith('pinch')) { if (!g.pointers.size) g.axis = null; return; }
  if (e.pointerId !== g.id) return;
  clearTimeout(g.longTimer);
  const dx = e.clientX - g.sx; const dy = e.clientY - g.sy; const dt = Math.max(1, Date.now() - g.st);
  const axis = g.axis; g.id = null; g.axis = null;
  if (axis === 'mouse') return;
  if (axis === 'boost') { stopBoost(); return; }
  if (axis === 'h') {
    scrubbing = false; stage.classList.remove('scrubbing'); $('#scrub-hint').classList.add('hidden');
    if (!cancelled && g.scrubTo != null) P.seek(g.scrubTo);
    g.scrubTo = null;
    return;
  }
  if (axis === 'v') {
    const vy = dy / dt; // px/ms
    if (P.fs) { if (dy > 60 || vy > 0.5) P.exitFullscreen(); return; }
    if (dy < -50 || vy < -0.5) { P.enterFullscreen(); return; }
    if (dy > 0) {
      if (!cancelled && (dy > 110 || vy > 0.6)) {
        player.classList.remove('dragging'); player.classList.add('leaving');
        player.style.transform = `translateY(${innerHeight}px)`; player.style.opacity = '0.3';
        setTimeout(() => P.minimize(), 180);
      } else {
        player.classList.remove('dragging'); player.classList.add('leaving');
        player.style.transform = ''; player.style.opacity = '';
        setTimeout(() => player.classList.remove('leaving'), 220);
      }
    }
    return;
  }
  if (!cancelled && !axis) handleTap(e.clientX);
}
stage.addEventListener('pointerup', (e) => endGesture(e, false));
stage.addEventListener('pointercancel', (e) => endGesture(e, true));
stage.addEventListener('contextmenu', (e) => e.preventDefault());

// mouse (desktop): clique = play/pause, duplo clique = tela cheia (laterais = pular)
stage.addEventListener('click', (e) => {
  if (!IS_TOUCH && P.state === 'max' && !e.target.closest('button, input, .seek, .upnext') && e.pointerType !== 'touch') {
    const side = sideOf(e.clientX);
    if (e.detail === 1) { clearTimeout(tapTimer); tapTimer = setTimeout(() => { P.togglePlay(); flash(video.paused ? 'Pausado' : 'Reproduzindo'); }, 220); }
    else if (e.detail === 2) { clearTimeout(tapTimer); side === 'C' ? P.toggleFullscreen() : doSkip(side); }
    else if (e.detail > 2 && side !== 'C') doSkip(side);
  }
});
stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !video.paused) hideControls(); });

// ---------- barra de progresso (arrastar com prévia do frame)
const seekEl = $('#seek');
let seekDrag = false;
function seekAt(clientX) {
  const r = $('.seek-track').getBoundingClientRect();
  const f = clamp((clientX - r.left) / r.width, 0, 1);
  const t = f * P.duration();
  $('#seek-prog').style.width = f * 100 + '%'; $('#seek-knob').style.left = f * 100 + '%';
  const tip = $('#seek-tip');
  const half = (P.fs ? 84 : 64);
  tip.style.left = clamp(clientX - r.left, half, r.width - half) + 'px';
  $('#seek-time').textContent = fmtTime(t);
  $('#t-cur').textContent = fmtTime(t);
  setPreview($('#seek-img'), t);
  return t;
}
seekEl.addEventListener('pointerdown', (e) => {
  if (!P.duration()) return;
  e.stopPropagation(); seekDrag = true; scrubbing = true;
  try { seekEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  stage.classList.add('scrubbing', 'bar-drag'); showControls(true);
  seekAt(e.clientX);
});
seekEl.addEventListener('pointermove', (e) => { if (seekDrag) seekAt(e.clientX); });
const seekEnd = (e, apply) => {
  if (!seekDrag) return;
  seekDrag = false; scrubbing = false;
  stage.classList.remove('scrubbing', 'bar-drag');
  if (apply) P.seek(seekAt(e.clientX));
  scheduleHide();
};
seekEl.addEventListener('pointerup', (e) => seekEnd(e, true));
seekEl.addEventListener('pointercancel', (e) => seekEnd(e, false));

// ---------- mini player: tocar = maximizar; arrastar p/ cima = maximizar; p/ o lado = fechar
(() => {
  let sx = 0, sy = 0, id = null, axis = null, st = 0;
  player.addEventListener('pointerdown', (e) => {
    if (P.state !== 'mini' || e.target.closest('button')) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; axis = null; st = Date.now();
    try { player.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  player.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!axis && Math.hypot(dx, dy) > 8) { axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'; player.classList.add('dragging'); }
    if (axis === 'h') { player.style.transform = `translateX(${dx}px)`; player.style.opacity = String(clamp(1 - Math.abs(dx) / 300, 0.2, 1)); }
    if (axis === 'v') player.style.transform = `translateY(${Math.min(0, dy)}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    const dx = e.clientX - sx, dy = e.clientY - sy, v = Math.abs(dx) / Math.max(1, Date.now() - st);
    player.classList.remove('dragging');
    if (!axis) { P.maximize(); return; }
    if (axis === 'h' && (Math.abs(dx) > 120 || v > 0.6)) {
      player.classList.add('leaving'); player.style.transform = `translateX(${Math.sign(dx) * innerWidth}px)`; player.style.opacity = '0';
      setTimeout(() => P.close(), 180); return;
    }
    if (axis === 'v' && dy < -40) { P.maximize(); return; }
    player.classList.add('leaving'); player.style.transform = ''; player.style.opacity = '';
    setTimeout(() => player.classList.remove('leaving'), 220);
  };
  player.addEventListener('pointerup', end);
  player.addEventListener('pointercancel', end);
})();

// ---------- teclado (estilo YouTube)
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=search], input[type=text], textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/' && !P.item) { e.preventDefault(); Search.show(); return; }
  if (!P.item) return;
  const k = e.key;
  const handled = {
    ' ': () => P.togglePlay(), k: () => P.togglePlay(), K: () => P.togglePlay(),
    j: () => doSkip('L'), l: () => doSkip('R'), J: () => doSkip('L'), L: () => doSkip('R'),
    ArrowLeft: () => { P.seekBy(-5); flash('−5s'); }, ArrowRight: () => { P.seekBy(5); flash('+5s'); },
    ArrowUp: () => { video.muted = false; video.volume = clamp(video.volume + 0.05, 0, 1); flash(`Volume ${Math.round(video.volume * 100)}%`); },
    ArrowDown: () => { video.volume = clamp(video.volume - 0.05, 0, 1); flash(`Volume ${Math.round(video.volume * 100)}%`); },
    f: () => P.toggleFullscreen(), F: () => P.toggleFullscreen(),
    m: () => { video.muted = !video.muted; flash(video.muted ? 'Sem som' : 'Som ativado'); }, M: () => { video.muted = !video.muted; },
    c: () => P.toggleCC(), C: () => P.toggleCC(),
    i: () => (P.state === 'max' ? P.minimize() : P.maximize()), I: () => (P.state === 'max' ? P.minimize() : P.maximize()),
    N: () => P.next(), P: () => P.prev(),
    '>': () => { video.playbackRate = Math.min(3, video.playbackRate + 0.25); flash(`${video.playbackRate}x`); },
    '<': () => { video.playbackRate = Math.max(0.25, video.playbackRate - 0.25); flash(`${video.playbackRate}x`); },
    Home: () => P.seek(0), End: () => P.seek(P.duration() - 1),
    ',': () => { if (video.paused) P.seek(P.time() - 1 / 30); }, '.': () => { if (video.paused) P.seek(P.time() + 1 / 30); },
    Escape: () => { if (P.fs) P.exitFullscreen(); },
  }[k];
  if (handled) { e.preventDefault(); handled(); if (P.state === 'max' && !'jlJL'.includes(k)) showControls(); return; }
  if (/^[0-9]$/.test(k)) { P.seek((P.duration() * +k) / 10); showControls(); }
});

// ===================================================================== início
const favLoaded = Fav.load();
B.load(pathFromHash(), false).then(async () => {
  history.replaceState({ dir: B.path }, '', location.href);
  await favLoaded; B.render();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.getRegistrations().then(() => {});
