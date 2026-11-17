'use strict';
/* Zima Video — modo administrador (gerenciar arquivos) e tags */

async function apiPost(path, params, body) {
  const r = await fetch(`/api/${path}${params ? '?' + qs(params) : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ZV': '1' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'admin/login') { Admin.logged = false; Admin.exitSelect(); }
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}

// ===================================================================== tags
const Tags = {
  list: [], colors: {}, filter: new Set(),
  async load() {
    try { const r = await api('tags'); this.apply(r); } catch { /* sem tags */ }
  },
  apply(r) {
    this.list = r.tags || [];
    this.colors = Object.fromEntries(this.list.map((t) => [t.name, t.color]));
    for (const f of [...this.filter]) if (!this.colors[f]) this.filter.delete(f);
    Side.render();
  },
  chip(name, extra = '') { return `<span class="tag ${extra}" style="--c:${this.colors[name] || '#888'}">${esc(name)}</span>`; },
  chips(tags) { return tags && tags.length ? `<div class="item-tags">${tags.map((t) => this.chip(t)).join('')}</div>` : ''; },

  // filtro na pasta atual: mostra só itens com alguma das tags marcadas
  applyFilter(entries) {
    if (!this.filter.size) return entries;
    return entries.filter((e) => e.tags && e.tags.some((t) => this.filter.has(t)));
  },
  renderFilterBar() {
    const bar = $('#tag-filter');
    const present = new Set();
    for (const e of B.entries) for (const t of e.tags || []) present.add(t);
    if (B.tagView || !present.size) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    bar.innerHTML = '';
    const lbl = el('span', 'tf-label', `${icon('tag')}Tags`); bar.appendChild(lbl);
    for (const name of [...present].sort((a, b) => collator.compare(a, b))) {
      const b = el('button', 'tag tag-btn' + (this.filter.has(name) ? ' on' : ''), esc(name));
      b.style.setProperty('--c', this.colors[name] || '#888');
      b.onclick = () => { this.filter.has(name) ? this.filter.delete(name) : this.filter.add(name); B.render(); };
      bar.appendChild(b);
    }
    if (this.filter.size) { const c = el('button', 'tf-clear', 'Limpar'); c.onclick = () => { this.filter.clear(); B.render(); }; bar.appendChild(c); }
  },

  // visão global: todos os itens com uma tag, de qualquer pasta
  async openView(tag, push = true) {
    if (Search.open) Search.close(true);
    if (push) history.pushState({ tag }, '', '#tag=' + encodeURIComponent(tag));
    B.tagView = tag; B.entries = []; B.loadSeq++;
    this.renderView([]);
    try {
      const r = await api('tags', { tag });
      if (B.tagView !== tag) return;
      this.viewItems = r.items;
      this.renderView(r.items);
    } catch (e) { toast(e.message); }
  },
  renderView(items = this.viewItems || []) {
    const tag = B.tagView;
    $('#btn-up').classList.remove('hidden');
    $('#title').textContent = tag;
    const crumbs = $('#crumbs'); crumbs.innerHTML = '';
    const home = el('button', 'crumb', `${icon('home')}Início`); home.onclick = () => B.load(''); crumbs.appendChild(home);
    const c = el('span', 'crumb current', `${icon('tag')}${esc(tag)}`); crumbs.appendChild(c);
    ['#favorites', '#continue', '#tag-home', '#tag-filter'].forEach((s) => $(s).classList.add('hidden'));
    const list = $('#list');
    list.className = 'list' + (prefs.view === 'grid' ? ' grid' : '');
    list.innerHTML = '';
    for (const e of items) list.appendChild(renderItem(e, { showPath: true }));
    $('#empty').classList.toggle('hidden', !!items.length);
    if (!items.length) $('#empty').innerHTML = `${icon('tag')}Nenhum item com a tag “${esc(tag)}”`;
    document.title = `${tag} — Zima Video`;
    Side.render(); Admin.afterRender();
  },
  renderHome() {
    const box = $('#tag-home');
    if (B.path || B.tagView || !this.list.some((t) => t.count)) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const row = $('#tag-home-list'); row.innerHTML = '';
    for (const t of this.list.filter((x) => x.count)) {
      const b = el('button', 'tag tag-btn', `${esc(t.name)}<small>${t.count}</small>`);
      b.style.setProperty('--c', t.color);
      b.onclick = () => this.openView(t.name);
      row.appendChild(b);
    }
  },
  sideSection(box) {
    const used = this.list.filter((t) => t.count);
    if (!used.length) return;
    box.appendChild(el('div', 'side-h', 'Tags'));
    for (const t of used) {
      const b = el('button', 'side-link' + (B.tagView === t.name ? ' active' : ''));
      b.innerHTML = `<i class="tag-dot" style="background:${t.color}"></i><span>${esc(t.name)}</span><small>${t.count}</small>`;
      b.onclick = () => this.openView(t.name);
      box.appendChild(b);
    }
  },

  // marcar tags em vários itens de uma vez (estado misto quando só parte dos itens tem a tag)
  editFor(items, done) {
    const paths = items.map((i) => i.path);
    const state = () => {
      const m = {};
      for (const t of this.list) {
        const n = items.filter((i) => (i.tags || []).includes(t.name)).length;
        m[t.name] = n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
      }
      return m;
    };
    const apply = async (add, remove) => {
      try {
        const r = await apiPost('tags', null, { paths, add, remove });
        this.apply(r);
        for (const i of items) {
          const set = new Set(i.tags || []); add.forEach((t) => set.add(t)); remove.forEach((t) => set.delete(t));
          i.tags = [...set].sort();
        }
        draw();
      } catch (e) { toast(e.message); }
    };
    const draw = () => Sheet.open((b) => {
      Sheet.header(b, items.length > 1 ? `Tags de ${items.length} itens` : 'Tags');
      const st = state();
      for (const t of this.list) {
        const r = el('button', 'row tag-row ' + st[t.name]);
        r.innerHTML = `<span class="tri"></span><i class="tag-dot" style="background:${t.color}"></i><span class="lbl">${esc(t.name)}</span><span class="val">${t.count}</span>`;
        r.onclick = () => (st[t.name] === 'on' ? apply([], [t.name]) : apply([t.name], []));
        const more = el('span', 'icon-btn tag-more', icon('more'));
        more.onclick = (ev) => { ev.stopPropagation(); this.manage(t, draw); };
        r.appendChild(more);
        b.appendChild(r);
      }
      const add = el('div', 'tag-new');
      add.innerHTML = '<input type="text" maxlength="40" placeholder="Nova tag…" enterkeyhint="done"><button class="btn primary">Adicionar</button>';
      const inp = $('input', add);
      const go = () => { const v = inp.value.trim(); if (v) apply([v], []); };
      $('button', add).onclick = go;
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      b.appendChild(add);
      b.appendChild(el('div', 'sheet-note', 'Toque numa tag para marcar ou desmarcar em todos os itens selecionados.'));
      const ok = el('button', 'btn sheet-done', 'Concluído'); ok.onclick = () => { Sheet.close(); if (done) done(); };
      b.appendChild(ok);
    });
    draw();
  },
  manage(t, back) {
    Sheet.open((b) => {
      Sheet.header(b, t.name, back);
      const colors = ['#7c5cff', '#ff5c7a', '#2bb673', '#ffb020', '#3ea6ff', '#ff7a2f', '#c05cff', '#14b8a6', '#e5484d', '#8d9eff'];
      const pal = el('div', 'tag-palette');
      for (const c of colors) {
        const sw = el('button', 'swatch' + (c === t.color ? ' on' : '')); sw.style.background = c;
        sw.onclick = async () => { try { this.apply(await apiPost('tags', { action: 'edit' }, { name: t.name, color: c })); t.color = c; B.render(); this.manage(t, back); } catch (e) { toast(e.message); } };
        pal.appendChild(sw);
      }
      b.appendChild(pal);
      Sheet.row(b, { ico: 'edit', label: 'Renomear tag', onClick: () => Admin.prompt('Renomear tag', t.name, async (v) => {
        try { this.apply(await apiPost('tags', { action: 'edit' }, { name: t.name, newName: v })); B.load(B.path, false); if (back) back(); } catch (e) { toast(e.message); }
      }) });
      Sheet.row(b, { ico: 'delete', label: 'Excluir tag (os arquivos não são apagados)', onClick: async () => {
        try { this.apply(await apiPost('tags', { action: 'edit' }, { name: t.name, remove: true })); B.load(B.path, false); if (back) back(); else Sheet.close(); } catch (e) { toast(e.message); }
      } });
    });
  },
};

// ===================================================================== modo administrador
const Admin = {
  enabled: false, logged: false, selecting: false, sel: new Map(),
  async status() {
    try { const r = await api('admin/status'); this.enabled = r.enabled; this.logged = r.logged; } catch { /* ignore */ }
  },

  // ---------- login
  login(then) {
    Sheet.open((b) => {
      Sheet.header(b, 'Modo administrador');
      if (!this.enabled) {
        b.appendChild(el('div', 'sheet-note', 'O modo administrador está desativado no servidor. Para ativar, defina a variável <b>ADMIN_PASSWORD</b> no app (docker-compose) e monte as pastas sem “:ro”. Veja “Gerenciar arquivos” no README.'));
        return;
      }
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="password" autocomplete="current-password" placeholder="Senha de administrador" required><button class="btn primary">Entrar</button><div class="login-err"></div>';
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const err = $('.login-err', f); err.textContent = '';
        try {
          await apiPost('admin/login', null, { password: $('input', f).value });
          this.logged = true; Sheet.close(); toast('Modo administrador ativado');
          B.render(); if (then) whenHistoryIdle(then);
        } catch (e) { err.textContent = e.message; }
      };
      b.appendChild(f);
      b.appendChild(el('div', 'sheet-note', 'Permite criar pastas, renomear, mover, excluir (vai para a lixeira) e editar tags. A sessão dura 30 dias neste aparelho.'));
      setTimeout(() => $('input', f).focus(), 60);
    });
  },
  async logout() {
    try { await apiPost('admin/logout'); } catch { /* ignore */ }
    this.logged = false; this.exitSelect(); B.render(); toast('Saiu do modo administrador');
  },
  need(fn) { if (this.logged) fn(); else this.login(fn); },

  // ---------- seleção
  startSelect(e, li) {
    if (!this.logged) return itemMenu(e);
    if (!this.selecting) { this.selecting = true; document.body.classList.add('selecting'); }
    navigator.vibrate && navigator.vibrate(15);
    this.toggle(e, li, true);
  },
  toggle(e, li, force) {
    const on = force != null ? force : !this.sel.has(e.path);
    if (on) this.sel.set(e.path, e); else this.sel.delete(e.path);
    if (li) li.classList.toggle('selected', on);
    this.updateBar();
  },
  exitSelect() {
    this.selecting = false; this.sel.clear();
    document.body.classList.remove('selecting');
    document.querySelectorAll('.item.selected').forEach((n) => n.classList.remove('selected'));
    this.updateBar();
  },
  selectAll() {
    document.querySelectorAll('#list .item').forEach((li) => {
      const e = li._entry; if (e) { this.sel.set(e.path, e); li.classList.add('selected'); }
    });
    this.updateBar();
  },
  afterRender() {
    if (!this.selecting) return;
    document.querySelectorAll('.item').forEach((li) => li.classList.toggle('selected', !!(li._entry && this.sel.has(li._entry.path))));
    this.updateBar();
  },
  updateBar() {
    const bar = $('#selbar');
    bar.classList.toggle('hidden', !this.selecting);
    if (!this.selecting) return;
    const n = this.sel.size;
    $('#sel-count').textContent = n ? `${n} ${n > 1 ? 'itens' : 'item'}` : 'Selecione';
    $('#sel-rename').disabled = n !== 1;
    for (const id of ['#sel-move', '#sel-delete', '#sel-tags']) $(id).disabled = !n;
  },

  // ---------- ações
  async run(action, body, okMsg) {
    try {
      const r = await apiPost('fs', { action }, body);
      if (r.moved) this.migrate(r.moved);
      if (r.errors && r.errors.length) toast(r.errors.slice(0, 2).join(' · '), null, null, 6000);
      else if (okMsg) toast(okMsg);
      await Promise.all([Fav.load(), Tags.load()]);
      Side.init();
      if (B.tagView) Tags.openView(B.tagView, false); else B.load(B.path, false);
      return r;
    } catch (e) { toast(e.message, null, null, 5000); throw e; }
  },
  // progresso de reprodução fica neste aparelho: acompanha arquivos renomeados/movidos
  migrate(pairs) {
    for (const k of Object.keys(progress)) {
      for (const [a, b] of pairs) {
        if (k === a || k.startsWith(a + '/')) { progress[b + k.slice(a.length)] = progress[k]; delete progress[k]; progressDirty = true; break; }
      }
    }
    flushProgress();
    if (P.item) for (const [a, b] of pairs) if (P.item.path === a || P.item.path.startsWith(a + '/')) P.item.path = b + P.item.path.slice(a.length);
  },
  prompt(title, value, fn, selectBase = false) {
    Sheet.open((b) => {
      Sheet.header(b, title);
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="text" required maxlength="255"><button class="btn primary">Salvar</button>';
      const inp = $('input', f); inp.value = value || '';
      f.onsubmit = (ev) => { ev.preventDefault(); const v = inp.value.trim(); if (!v) return; Sheet.close(); whenHistoryIdle(() => fn(v)); };
      b.appendChild(f);
      setTimeout(() => {
        inp.focus();
        const dot = value ? value.lastIndexOf('.') : -1;
        if (selectBase && dot > 0) inp.setSelectionRange(0, dot); else inp.select();
      }, 60);
    });
  },
  newFolder(dir = B.path) {
    this.need(() => this.prompt('Nova pasta', 'Nova pasta', (name) => this.run('mkdir', { path: dir, name }, 'Pasta criada')));
  },
  rename(e) {
    this.need(() => this.prompt('Renomear', e.name, (name) => {
      if (name !== e.name) this.run('rename', { path: e.path, name }, 'Renomeado').then(() => this.exitSelect(), () => {});
    }, e.type !== 'dir'));
  },
  remove(items) {
    this.need(() => Sheet.open((b) => {
      const n = items.length;
      Sheet.header(b, n > 1 ? `Excluir ${n} itens?` : `Excluir “${items[0].name}”?`);
      b.appendChild(el('div', 'sheet-note', 'Os itens vão para a lixeira e podem ser restaurados depois (menu ⋮ → Lixeira).'));
      Sheet.row(b, { ico: 'delete', label: n > 1 ? `Mover ${n} itens para a lixeira` : 'Mover para a lixeira', onClick: () => {
        Sheet.close();
        whenHistoryIdle(() => this.run('delete', { paths: items.map((i) => i.path) }, n > 1 ? `${n} itens movidos para a lixeira` : 'Movido para a lixeira')
          .then(() => this.exitSelect(), () => {}));
      } });
      Sheet.row(b, { ico: 'close', label: 'Cancelar', onClick: () => Sheet.close() });
    }));
  },
  // escolher pasta de destino navegando pelas pastas
  move(items) {
    const paths = items.map((i) => i.path);
    let cur = B.tagView ? dirname(paths[0]) : B.path;
    const draw = async () => {
      let dirs = [];
      try { dirs = B.sorted((await api('list', { path: cur })).entries.filter((x) => x.type === 'dir')); } catch (e) { toast(e.message); }
      Sheet.open((b) => {
        Sheet.header(b, items.length > 1 ? `Mover ${items.length} itens para…` : `Mover “${items[0].name}” para…`, cur ? () => { cur = dirname(cur); draw(); } : null);
        b.appendChild(el('div', 'move-path', `${icon('folder')}<span>${esc(cur || 'Início')}</span>`));
        for (const d of dirs) {
          const p = (cur ? cur + '/' : '') + d.name;
          const isSel = paths.includes(p);
          const r = Sheet.row(b, { ico: 'folder', label: d.name, chevron: !isSel, onClick: () => { if (!isSel) { cur = p; draw(); } } });
          if (isSel) r.classList.add('disabled');
        }
        if (!dirs.length) b.appendChild(el('div', 'sheet-note', 'Nenhuma subpasta aqui.'));
        const bar = el('div', 'move-actions');
        const nf = el('button', 'btn', `${icon('add')}Nova pasta`);
        nf.onclick = () => this.prompt('Nova pasta', 'Nova pasta', async (name) => {
          try { const r = await apiPost('fs', { action: 'mkdir' }, { path: cur, name }); cur = r.path; } catch (e) { toast(e.message); }
          draw();
        });
        const ok = el('button', 'btn primary', 'Mover para cá');
        ok.disabled = !cur.includes('/') && false;
        ok.onclick = () => {
          Sheet.close();
          whenHistoryIdle(() => this.run('move', { paths, dest: cur }, `${items.length > 1 ? items.length + ' itens movidos' : 'Movido'} para ${cur || 'Início'}`)
            .then(() => this.exitSelect(), () => {}));
        };
        bar.append(nf, ok); b.appendChild(bar);
      });
    };
    this.need(draw);
  },
  async trash() {
    this.need(async () => {
      let items = [];
      try { items = (await apiPost('fs', { action: 'trash' })).items; } catch (e) { toast(e.message); return; }
      Sheet.open((b) => {
        Sheet.header(b, `Lixeira${items.length ? ` (${items.length})` : ''}`);
        if (!items.length) { b.appendChild(el('div', 'sheet-note', 'A lixeira está vazia.')); return; }
        for (const t of items) {
          const r = el('div', 'row trash-row');
          r.innerHTML = `${icon(t.dir ? 'folder' : typeIcon(typeOfName(t.name)))}<span class="lbl"><b>${esc(t.name)}</b><small>${esc(dirname(t.original) || 'Início')} · ${fmtDate(t.deletedAt)}${t.size ? ' · ' + fmtSize(t.size) : ''}</small></span>`;
          const rs = el('button', 'btn', 'Restaurar');
          rs.onclick = () => { Sheet.close(); whenHistoryIdle(() => this.run('restore', { ids: [t.id] }, `“${t.name}” restaurado`).then(() => this.trash(), () => {})); };
          const del = el('button', 'icon-btn', icon('delete')); del.title = 'Apagar definitivamente';
          del.onclick = () => this.confirmPurge([t.id], `Apagar “${t.name}” definitivamente?`);
          r.append(rs, del); b.appendChild(r);
        }
        Sheet.row(b, { ico: 'delete', label: 'Esvaziar lixeira', onClick: () => this.confirmPurge(null, `Apagar definitivamente ${items.length} item(ns)?`) });
      });
    });
  },
  confirmPurge(ids, title) {
    Sheet.open((b) => {
      Sheet.header(b, title, () => this.trash());
      b.appendChild(el('div', 'sheet-note', 'Esta ação não pode ser desfeita.'));
      Sheet.row(b, { ico: 'delete', label: 'Apagar definitivamente', onClick: async () => {
        try { await apiPost('fs', { action: 'purge' }, ids ? { ids } : { all: true }); toast('Apagado'); this.trash(); } catch (e) { toast(e.message); }
      } });
      Sheet.row(b, { ico: 'close', label: 'Cancelar', onClick: () => this.trash() });
    });
  },

  // ---------- linhas nos menus
  menuRows(b) {
    Sheet.header(b, 'Administrador');
    if (!this.logged) { Sheet.row(b, { ico: 'lock', label: 'Entrar no modo administrador', onClick: () => this.login() }); return; }
    Sheet.row(b, { ico: 'check', label: 'Selecionar itens', onClick: () => { Sheet.close(); this.selecting = true; document.body.classList.add('selecting'); this.updateBar(); } });
    if (!B.tagView) Sheet.row(b, { ico: 'add', label: 'Nova pasta aqui', onClick: () => this.newFolder() });
    Sheet.row(b, { ico: 'delete', label: 'Lixeira', onClick: () => this.trash() });
    Sheet.row(b, { ico: 'lock', label: 'Sair do modo administrador', onClick: () => { Sheet.close(); this.logout(); } });
  },
  itemRows(b, e) {
    if (!this.logged) return;
    Sheet.row(b, { ico: 'tag', label: 'Tags…', value: e.tags && e.tags.length ? e.tags.join(', ') : null, onClick: () => Tags.editFor([e], () => B.render()) });
    Sheet.row(b, { ico: 'edit', label: 'Renomear', onClick: () => this.rename(e) });
    Sheet.row(b, { ico: 'move', label: 'Mover para…', onClick: () => this.move([e]) });
    Sheet.row(b, { ico: 'delete', label: 'Excluir', onClick: () => this.remove([e]) });
  },
};
const typeOfName = (n) => {
  const x = extname(n);
  if (/^(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpg|mpeg|ts|m2ts|mts|3gp|ogv|vob)$/.test(x)) return 'video';
  if (/^(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/.test(x)) return 'audio';
  if (/^(jpg|jpeg|png|gif|webp|bmp|heic|avif)$/.test(x)) return 'image';
  return 'file';
};

// barra de seleção
$('#sel-close').onclick = () => Admin.exitSelect();
$('#sel-all').onclick = () => Admin.selectAll();
$('#sel-tags').onclick = () => Tags.editFor([...Admin.sel.values()], () => { Admin.exitSelect(); B.load(B.path, false); });
$('#sel-move').onclick = () => Admin.move([...Admin.sel.values()]);
$('#sel-rename').onclick = () => { const [e] = Admin.sel.values(); if (e) Admin.rename(e); };
$('#sel-delete').onclick = () => Admin.remove([...Admin.sel.values()]);
document.addEventListener('keydown', (e) => {
  if (!Admin.selecting || e.target.matches('input, textarea')) return;
  if (e.key === 'Escape') { Admin.exitSelect(); e.preventDefault(); }
  else if (e.key === 'Delete' && Admin.sel.size) { Admin.remove([...Admin.sel.values()]); e.preventDefault(); }
  else if (e.key === 'F2' && Admin.sel.size === 1) { Admin.rename([...Admin.sel.values()][0]); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { Admin.selectAll(); e.preventDefault(); }
});

Promise.all([Admin.status(), Tags.load()]).then(() => { if (B.tagView) Tags.renderView(); else if (B.loaded) B.render(); });
