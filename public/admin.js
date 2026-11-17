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
  sortNames(arr) { return arr.slice().sort((a, b) => collator.compare(a, b)); },
  apply(r) {
    this.list = (r.tags || []).slice().sort((a, b) => collator.compare(a.name, b.name));
    this.colors = Object.fromEntries(this.list.map((t) => [t.name, t.color]));
    for (const f of [...this.filter]) if (!this.colors[f]) this.filter.delete(f);
    Side.render();
  },
  chip(name, extra = '') { return `<span class="tag ${extra}" style="--c:${this.colors[name] || '#888'}">${esc(name)}</span>`; },
  chips(tags) { return tags && tags.length ? `<div class="item-tags">${this.sortNames(tags).map((t) => this.chip(t)).join('')}</div>` : ''; },

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
  // marcar tags em vários itens de uma vez (estado misto quando só parte dos itens tem a tag).
  // Um campo só: digita para filtrar; se não existir, oferece criar. A janela não é redesenhada a cada
  // toque (só a lista), então o campo não perde o foco.
  editFor(items, done) {
    const paths = items.map((i) => i.path);
    let q = ''; let ui = null;
    const state = (name) => {
      const n = items.filter((i) => (i.tags || []).includes(name)).length;
      return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
    };
    const apply = async (add, remove) => {
      try {
        const r = await apiPost('tags', null, { paths, add, remove });
        this.apply(r);
        for (const i of items) {
          const set = new Set(i.tags || []); add.forEach((t) => set.add(t)); remove.forEach((t) => set.delete(t));
          i.tags = this.sortNames([...set]);
        }
        renderList();
      } catch (e) { toast(e.message); }
    };
    const toggle = (name) => (state(name) === 'on' ? apply([], [name]) : apply([name], []));
    const renderList = () => {
      const box = ui.list; box.innerHTML = '';
      const ql = norm(q.trim());
      const shown = ql ? this.list.filter((t) => norm(t.name).includes(ql)) : this.list;
      const exact = this.list.some((t) => norm(t.name) === ql);
      if (q.trim() && !exact) {
        const c = el('button', 'row tag-create', `${icon('add')}<span class="lbl">Criar tag “${esc(q.trim())}”</span>`);
        c.onclick = () => { const v = q.trim(); q = ''; ui.input.value = ''; apply([v], []); };
        box.appendChild(c);
      }
      for (const t of shown) {
        const r = el('button', 'row tag-row ' + state(t.name));
        r.innerHTML = `<span class="tri"></span><i class="tag-dot" style="background:${t.color}"></i><span class="lbl">${esc(t.name)}</span><span class="val">${t.count}</span>`;
        r.onclick = () => toggle(t.name);
        const more = el('span', 'icon-btn tag-more', icon('more'));
        more.onclick = (ev) => { ev.stopPropagation(); this.manage(t, () => this.editFor(items, done)); };
        r.appendChild(more);
        box.appendChild(r);
      }
      if (!shown.length && !q.trim()) box.appendChild(el('div', 'sheet-note', 'Nenhuma tag ainda. Digite um nome acima para criar.'));
      if (!shown.length && q.trim() && exact) box.appendChild(el('div', 'sheet-note', 'Nenhuma tag encontrada.'));
    };
    Sheet.open((b) => {
      b.classList.add('move-sheet');
      const top = el('div', 'move-top');
      const h = el('h3'); h.textContent = items.length > 1 ? `Tags de ${items.length} itens` : `Tags de “${items[0].name}”`;
      const sb = el('div', 'move-search');
      sb.innerHTML = `${icon('search')}<input type="search" maxlength="40" placeholder="Buscar ou criar tag…" autocomplete="off" enterkeyhint="done">`;
      const input = $('input', sb);
      input.addEventListener('input', () => { q = input.value; renderList(); });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = q.trim(); if (!v) return;
        const hit = this.list.find((t) => norm(t.name) === norm(v)) || this.list.find((t) => norm(t.name).includes(norm(v)));
        if (hit) toggle(hit.name); else apply([v], []);
        q = ''; input.value = ''; renderList();
      });
      top.append(h, sb, el('div', 'sheet-note tag-hint', 'Toque numa tag para marcar ou desmarcar em todos os itens. Enter marca a primeira encontrada ou cria uma nova.'));
      const list = el('div', 'move-list');
      const bar = el('div', 'move-actions');
      const ok = el('button', 'btn primary', 'Concluído'); ok.onclick = () => { Sheet.close(); if (done) done(); };
      bar.append(ok);
      b.append(top, list, bar);
      ui = { list, input };
      renderList();
      if (!IS_TOUCH) setTimeout(() => input.focus(), 60);
    });
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
    try {
      const r = await api('admin/status');
      this.enabled = r.enabled; this.logged = r.logged; this.fromEnv = r.fromEnv; this.readonly = r.readonly || [];
    } catch { /* ignore */ }
  },

  // ---------- login
  login(then) {
    Sheet.open((b) => {
      Sheet.header(b, 'Modo administrador');
      if (!this.enabled) { this.setup(then); return; }
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="password" autocomplete="current-password" placeholder="Senha de administrador" required><button class="btn primary">Entrar</button><div class="login-err"></div>';
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const err = $('.login-err', f); err.textContent = '';
        try {
          await apiPost('admin/login', null, { password: $('input', f).value });
          this.logged = true; Sheet.close(); toast('Modo administrador ativado'); setTimeout(() => this.readonlyWarning(), 3200);
          B.render(); if (then) whenHistoryIdle(then);
        } catch (e) { err.textContent = e.message; }
      };
      b.appendChild(f);
      b.appendChild(el('div', 'sheet-note', 'Permite criar pastas, renomear, mover, excluir (vai para a lixeira) e editar tags. A sessão dura 30 dias neste aparelho.'));
      setTimeout(() => $('input', f).focus(), 60);
    });
  },
  // primeira vez: criar a senha pelo próprio app (só funciona enquanto não existir senha)
  setup(then) {
    Sheet.open((b) => {
      Sheet.header(b, 'Criar senha de administrador');
      b.appendChild(el('div', 'sheet-note', 'Ainda não existe senha. Crie uma agora — ela será pedida para criar pastas, renomear, mover, excluir e editar tags. Depois de criada, só quem souber a senha pode trocá-la.'));
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="password" autocomplete="new-password" placeholder="Nova senha (mín. 4 caracteres)" minlength="4" required>' +
        '<input type="password" autocomplete="new-password" placeholder="Repita a senha" minlength="4" required><button class="btn primary">Criar senha</button><div class="login-err"></div>';
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const [a, c] = [...f.querySelectorAll('input')].map((i) => i.value);
        const err = $('.login-err', f);
        if (a !== c) { err.textContent = 'As senhas não conferem'; return; }
        try {
          await apiPost('admin/setup', null, { password: a });
          this.enabled = true; this.logged = true; Sheet.close();
          toast('Senha criada · modo administrador ativado');
          B.render(); this.readonlyWarning();
          if (then) whenHistoryIdle(then);
        } catch (e) { err.textContent = e.message; }
      };
      b.appendChild(f);
      this.readonlyNote(b);
      setTimeout(() => $('input', f).focus(), 60);
    });
  },
  changePassword() {
    Sheet.open((b) => {
      Sheet.header(b, 'Trocar senha de administrador');
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="password" autocomplete="current-password" placeholder="Senha atual" required>' +
        '<input type="password" autocomplete="new-password" placeholder="Nova senha (mín. 4 caracteres)" minlength="4" required>' +
        '<input type="password" autocomplete="new-password" placeholder="Repita a nova senha" minlength="4" required><button class="btn primary">Trocar</button><div class="login-err"></div>';
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const [cur, a, c] = [...f.querySelectorAll('input')].map((i) => i.value);
        const err = $('.login-err', f);
        if (a !== c) { err.textContent = 'As senhas não conferem'; return; }
        try { await apiPost('admin/password', null, { current: cur, password: a }); Sheet.close(); toast('Senha alterada'); }
        catch (e) { err.textContent = e.message; }
      };
      b.appendChild(f);
      setTimeout(() => $('input', f).focus(), 60);
    });
  },
  // pastas com ":ro" no docker-compose não aceitam alterações: explica como liberar
  readonlyNote(b) {
    if (!this.readonly || !this.readonly.length) return;
    b.appendChild(el('div', 'sheet-note ro-warn', `<b>Atenção:</b> ${this.readonly.map((p) => '“' + esc(p) + '”').join(', ')} ${this.readonly.length > 1 ? 'estão montadas' : 'está montada'} como <b>somente leitura</b>, então mover, renomear e excluir não vão funcionar ali. ` +
      'Para liberar: no ZimaOS, abra as configurações do app Zima Video e, em <b>Volumes</b>, tire a opção de somente leitura. Se não houver essa opção, reinstale o app com o docker-compose novo (que já vem sem “:ro”) — favoritos e tags são mantidos.'));
  },
  readonlyWarning() { if (this.readonly && this.readonly.length) toast('Algumas pastas estão somente leitura — veja o menu ⋮', null, null, 5000); },
  async logout() {
    try { await apiPost('admin/logout'); } catch { /* ignore */ }
    this.logged = false; this.exitSelect(); B.render(); toast('Saiu do modo administrador');
  },
  need(fn) { if (this.logged) fn(); else this.login(fn); },

  // ---------- seleção
  startSelect(e, li) {
    if (!this.logged) return itemMenu(e);
    this.enter();
    navigator.vibrate && navigator.vibrate(15);
    this.toggle(e, li, true);
    // continuar arrastando o dedo depois de segurar marca todos os itens pelo caminho
    this.touchDrag = { base: new Map(this.sel), start: li };
  },
  toggle(e, li, force) {
    const on = force != null ? force : !this.sel.has(e.path);
    if (on) this.sel.set(e.path, e); else this.sel.delete(e.path);
    if (li) { li.classList.toggle('selected', on); this.anchor = li; }
    this.updateBar();
  },
  items() { return [...document.querySelectorAll('#list .item')].filter((li) => li._entry); },
  enter() { if (!this.selecting) { this.selecting = true; document.body.classList.add('selecting'); } },
  setSel(lis, on = true) {
    for (const li of lis) {
      const e = li._entry; if (!e) continue;
      if (on) this.sel.set(e.path, e); else this.sel.delete(e.path);
      li.classList.toggle('selected', on);
    }
    this.updateBar();
  },
  // marca do último item clicado até este (Shift+clique / arrastar o dedo)
  range(li, base) {
    const all = this.items(); const a = all.indexOf(this.anchor); const b = all.indexOf(li);
    if (a < 0 || b < 0) return this.toggle(li._entry, li, true);
    const [i, j] = a < b ? [a, b] : [b, a];
    if (base) { this.sel = new Map(base); all.forEach((x) => x.classList.toggle('selected', this.sel.has(x._entry.path))); }
    this.setSel(all.slice(i, j + 1), true);
  },
  // clique num item: Ctrl/⌘ alterna, Shift marca o intervalo; durante a seleção, clique simples alterna
  click(e, li, ev) {
    const mod = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!this.selecting && !(this.logged && mod)) return false;
    ev.preventDefault();
    this.enter();
    if (ev.shiftKey && this.anchor && document.contains(this.anchor)) this.range(li);
    else this.toggle(e, li);
    return true;
  },
  exitSelect() {
    this.selecting = false; this.sel.clear();
    document.body.classList.remove('selecting');
    document.querySelectorAll('.item.selected').forEach((n) => n.classList.remove('selected'));
    this.updateBar();
  },
  allSelected() { const all = this.items(); return all.length > 0 && all.every((li) => this.sel.has(li._entry.path)); },
  selectAll() {
    this.enter();
    if (this.allSelected()) this.setSel(this.items(), false); // segundo toque: limpa
    else this.setSel(this.items(), true);
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
    $('#sel-all').textContent = this.allSelected() ? 'Limpar' : 'Selecionar tudo';
    $('#sel-rename').disabled = !n;
    $('#sel-rename').title = n > 1 ? 'Renomear em lote' : 'Renomear (F2)';
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
    // monta o novo conjunto de uma vez (renomear "no lugar" estragaria trocas como A↔B)
    const moved = {};
    for (const k of Object.keys(progress)) {
      for (const [a, b] of pairs) {
        if (k === a || k.startsWith(a + '/')) { moved[b + k.slice(a.length)] = progress[k]; delete progress[k]; progressDirty = true; break; }
      }
    }
    Object.assign(progress, moved);
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
  // ---------- renomear em lote
  renameMany(items) {
    // ordem da lista na tela (a numeração segue o que o usuário está vendo)
    const order = new Map(this.items().map((li, i) => [li._entry.path, i]));
    items = items.slice().sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9));
    const split = (e) => {
      if (e.type === 'dir') return [e.name, ''];
      const i = e.name.lastIndexOf('.');
      return i > 0 ? [e.name.slice(0, i), e.name.slice(i)] : [e.name, ''];
    };
    const folder = basename(B.tagView ? dirname(items[0].path) : B.path) || 'Arquivo';
    const st = store.get('renameMany', {});
    const o = { mode: st.mode || 'novo', tpl: st.tpl || `${folder} ##`, start: 1, pre: '', suf: '', find: '', repl: '', cs: false };
    const esc2 = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const compute = () => items.map((e, i) => {
      const [base, ext] = split(e);
      let nb = base;
      if (o.mode === 'novo') {
        let t = o.tpl.trim();
        if (!/#/.test(t)) t = items.length > 1 ? `${t} #` : t; // vários itens sem # → numera no fim
        const n = o.start + i;
        nb = t.replace(/#+/, (m) => String(n).padStart(Math.max(m.length, m.length === 1 ? String(o.start + items.length - 1).length : m.length), '0'));
      } else if (o.mode === 'acrescentar') nb = `${o.pre}${base}${o.suf}`;
      else if (o.find) nb = base.replace(new RegExp(esc2(o.find), o.cs ? 'g' : 'gi'), o.repl);
      return { e, name: nb.trim() + ext };
    });
    const check = (res) => {
      const seen = new Map(); const inBatch = new Set(items.map((e) => e.path));
      const siblings = new Set(B.tagView ? [] : B.entries.map((x) => (B.path ? B.path + '/' : '') + x.name));
      for (const r of res) {
        const target = (dirname(r.e.path) ? dirname(r.e.path) + '/' : '') + r.name;
        r.changed = r.name !== r.e.name;
        if (!r.name.replace(/\.[^.]*$/, '').trim() || /[\/\\]/.test(r.name) || r.name === '.' || r.name === '..') r.err = 'nome inválido';
        else if (seen.has(target)) { r.err = 'repetido'; seen.get(target).err = 'repetido'; }
        else if (r.changed && siblings.has(target) && !inBatch.has(target)) r.err = 'já existe';
        seen.set(target, r);
      }
      return res;
    };
    let ui;
    const refresh = () => {
      const res = check(compute());
      ui.prev.innerHTML = '';
      for (const r of res) {
        const row = el('div', 'rn-row' + (r.err ? ' err' : r.changed ? '' : ' same'));
        row.innerHTML = `<span class="rn-old">${esc(r.e.name)}</span><span class="rn-arrow">→</span><span class="rn-new">${esc(r.name)}</span>${r.err ? `<span class="rn-err">${r.err}</span>` : ''}`;
        ui.prev.appendChild(row);
      }
      const bad = res.filter((r) => r.err).length; const n = res.filter((r) => r.changed && !r.err).length;
      ui.ok.disabled = !!bad || !n;
      ui.ok.textContent = bad ? `${bad} conflito${bad > 1 ? 's' : ''}` : n ? `Renomear ${n}` : 'Nada a mudar';
      ui.res = res;
    };
    const field = (label, input) => { const f = el('label', 'rn-field'); f.appendChild(el('span', '', esc(label))); f.appendChild(input); return f; };
    const inp = (val, ph, on, type = 'text') => {
      const i = el('input'); i.type = type; i.value = val; i.placeholder = ph || '';
      i.addEventListener('input', () => { on(i); refresh(); }); return i;
    };
    const drawMode = () => {
      ui.opts.innerHTML = '';
      ui.tabs.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.m === o.mode));
      if (o.mode === 'novo') {
        ui.opts.appendChild(field('Nome', inp(o.tpl, 'Ex.: Férias ##', (i) => { o.tpl = i.value; })));
        const n = inp(String(o.start), '1', (i) => { o.start = Math.max(0, parseInt(i.value, 10) || 0); }, 'number'); n.min = '0';
        ui.opts.appendChild(field('Começar em', n));
        ui.opts.appendChild(el('div', 'sheet-note', 'Use <b>#</b> para o número (com zeros quando há 10 ou mais itens, para ficarem em ordem) · <b>##</b> → 01, 02… · <b>###</b> → 001… A extensão é mantida.'));
      } else if (o.mode === 'acrescentar') {
        ui.opts.appendChild(field('Antes do nome', inp(o.pre, 'Ex.: [2024] ', (i) => { o.pre = i.value; })));
        ui.opts.appendChild(field('Depois do nome', inp(o.suf, 'Ex.: - Dublado', (i) => { o.suf = i.value; })));
      } else {
        ui.opts.appendChild(field('Procurar', inp(o.find, 'texto a trocar', (i) => { o.find = i.value; })));
        ui.opts.appendChild(field('Substituir por', inp(o.repl, '(vazio = remover)', (i) => { o.repl = i.value; })));
        const cb = el('label', 'rn-check'); cb.innerHTML = '<input type="checkbox"> Diferenciar maiúsculas/minúsculas';
        $('input', cb).checked = o.cs; $('input', cb).onchange = (ev) => { o.cs = ev.target.checked; refresh(); };
        ui.opts.appendChild(cb);
      }
      refresh();
      const first = $('input', ui.opts); if (first && !IS_TOUCH) setTimeout(() => first.focus(), 30);
    };
    this.need(() => Sheet.open((b) => {
      b.classList.add('move-sheet');
      const top = el('div', 'move-top');
      const h = el('h3'); h.textContent = `Renomear ${items.length} ${items.length > 1 ? 'itens' : 'item'}`;
      const tabs = el('div', 'chips rn-tabs');
      for (const [m, label] of [['novo', 'Novo nome'], ['acrescentar', 'Acrescentar'], ['substituir', 'Substituir']]) {
        const c = el('button', 'chip', label); c.dataset.m = m; c.onclick = () => { o.mode = m; drawMode(); }; tabs.appendChild(c);
      }
      const opts = el('div', 'rn-opts');
      top.append(h, tabs, opts);
      const prev = el('div', 'move-list rn-prev');
      const bar = el('div', 'move-actions');
      const cancel = el('button', 'btn', 'Cancelar'); cancel.onclick = () => Sheet.close();
      const ok = el('button', 'btn primary');
      ok.onclick = () => {
        const list = ui.res.filter((r) => r.changed).map((r) => ({ path: r.e.path, name: r.name }));
        store.set('renameMany', { mode: o.mode, tpl: o.tpl });
        Sheet.close();
        whenHistoryIdle(() => this.run('rename-many', { items: list }, `${list.length} ${list.length > 1 ? 'itens renomeados' : 'item renomeado'}`)
          .then(() => this.exitSelect(), () => {}));
      };
      bar.append(cancel, ok);
      b.append(top, prev, bar);
      ui = { tabs, opts, prev, ok };
      drawMode();
    }));
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
  // escolher pasta de destino: navegar, pesquisar (no servidor inteiro) ou usar um destino recente
  move(items) {
    const paths = items.map((i) => i.path);
    let cur = B.tagView ? dirname(paths[0]) : B.path;
    let dirs = []; let q = ''; let seq = 0; let found = null;
    const blocked = (p) => paths.some((x) => p === x || p.startsWith(x + '/')); // não dá para mover para dentro de si mesmo
    const recents = () => store.get('moveRecent', []).filter((p) => p !== cur && !blocked(p));
    let ui = null;

    const renderList = () => {
      const box = ui.list; box.innerHTML = '';
      const ql = norm(q.trim());
      const local = ql ? dirs.filter((d) => norm(d.name).includes(ql)) : dirs;
      if (ql && local.length) box.appendChild(el('div', 'move-sec', 'Nesta pasta'));
      for (const d of local) {
        const p = (cur ? cur + '/' : '') + d.name;
        const r = Sheet.row(box, { ico: 'folder', label: d.name, chevron: !blocked(p), onClick: () => { if (!blocked(p)) go(p); } });
        if (blocked(p)) r.classList.add('disabled');
      }
      if (found && ql) {
        const others = found.filter((f) => dirname(f.path) !== cur);
        if (others.length) box.appendChild(el('div', 'move-sec', 'Em todas as pastas'));
        for (const f of others) {
          const r = Sheet.row(box, { ico: 'folder', label: f.name, value: dirname(f.path) || 'Início', chevron: !blocked(f.path), onClick: () => { if (!blocked(f.path)) go(f.path); } });
          if (blocked(f.path)) r.classList.add('disabled');
        }
        if (!local.length && !others.length) box.appendChild(el('div', 'sheet-note', 'Nenhuma pasta encontrada.'));
      } else if (!local.length) box.appendChild(el('div', 'sheet-note', ql ? 'Nenhuma subpasta com esse nome aqui — pesquisando em todas…' : 'Nenhuma subpasta aqui.'));
    };
    const renderTop = () => {
      ui.path.innerHTML = `${icon('folder')}<span>${esc(cur || 'Início')}</span>`;
      ui.back.classList.toggle('hidden', !cur);
      ui.rec.innerHTML = '';
      const rs = recents();
      ui.rec.classList.toggle('hidden', !rs.length);
      if (rs.length) ui.rec.appendChild(el('span', 'move-rec-l', 'Recentes'));
      for (const p of rs) { const c = el('button', 'chip', esc(basename(p) || 'Início')); c.title = p; c.onclick = () => go(p); ui.rec.appendChild(c); }
      ui.ok.textContent = `Mover para ${cur ? '“' + basename(cur) + '”' : 'Início'}`;
    };
    const go = async (p) => {
      cur = p; q = ''; found = null; ui.input.value = '';
      renderTop(); ui.list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      const my = ++seq;
      try { const r = await api('list', { path: cur }); if (my !== seq) return; dirs = B.sorted(r.entries.filter((x) => x.type === 'dir')); }
      catch (e) { dirs = []; toast(e.message); }
      renderList();
      ui.list.scrollTop = 0;
    };
    let tm;
    const onSearch = () => {
      q = ui.input.value; renderList();
      clearTimeout(tm);
      if (q.trim().length < 2) { found = null; return; }
      const my = ++seq;
      tm = setTimeout(async () => {
        try {
          const r = await api('search', { q: q.trim(), media: 1 });
          if (my !== seq) return;
          found = r.results.filter((x) => x.type === 'dir'); renderList();
        } catch { /* ignore */ }
      }, 250);
    };

    this.need(() => Sheet.open((b) => {
      b.classList.add('move-sheet');
      const top = el('div', 'move-top');
      const h = el('h3');
      const back = el('button', 'icon-btn', icon('back')); back.title = 'Pasta acima'; back.onclick = () => go(dirname(cur));
      h.append(back, document.createTextNode(items.length > 1 ? `Mover ${items.length} itens para…` : `Mover “${items[0].name}” para…`));
      const path = el('div', 'move-path');
      const sb = el('div', 'move-search');
      sb.innerHTML = `${icon('search')}<input type="search" placeholder="Pesquisar pasta…" autocomplete="off" enterkeyhint="search">`;
      const input = $('input', sb); input.addEventListener('input', onSearch);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('.row:not(.disabled)', ui.list); if (first) first.click(); } });
      const rec = el('div', 'move-rec');
      top.append(h, path, sb, rec);
      const list = el('div', 'move-list');
      const bar = el('div', 'move-actions');
      const nf = el('button', 'btn', `${icon('add')}Nova pasta`);
      nf.onclick = () => this.prompt('Nova pasta', 'Nova pasta', async (name) => {
        try { const r = await apiPost('fs', { action: 'mkdir' }, { path: cur, name }); whenHistoryIdle(() => { this.move(items); setTimeout(() => go(r.path), 50); }); }
        catch (e) { toast(e.message); }
      });
      const ok = el('button', 'btn primary');
      ok.onclick = () => {
        const dest = cur;
        store.set('moveRecent', [dest, ...store.get('moveRecent', []).filter((p) => p !== dest)].slice(0, 6));
        Sheet.close();
        whenHistoryIdle(() => this.run('move', { paths, dest }, `${items.length > 1 ? items.length + ' itens movidos' : 'Movido'} para ${dest || 'Início'}`)
          .then(() => this.exitSelect(), () => {}));
      };
      bar.append(nf, ok);
      b.append(top, list, bar);
      ui = { path, back, rec, list, input, ok };
      go(cur);
      if (!IS_TOUCH) setTimeout(() => input.focus(), 60);
    }));
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
    if (!this.logged) {
      Sheet.row(b, { ico: 'lock', label: this.enabled ? 'Entrar no modo administrador' : 'Criar senha de administrador', onClick: () => this.login() });
      return;
    }
    this.readonlyNote(b);
    Sheet.row(b, { ico: 'check', label: 'Selecionar itens', onClick: () => { Sheet.close(); this.enter(); this.updateBar(); } });
    Sheet.row(b, { ico: 'check', label: 'Selecionar tudo desta pasta', onClick: () => { Sheet.close(); this.enter(); this.setSel(this.items(), true); } });
    if (!B.tagView) Sheet.row(b, { ico: 'add', label: 'Nova pasta aqui', onClick: () => this.newFolder() });
    Sheet.row(b, { ico: 'delete', label: 'Lixeira', onClick: () => this.trash() });
    if (!this.fromEnv) Sheet.row(b, { ico: 'lock', label: 'Trocar senha de administrador', onClick: () => this.changePassword() });
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

// ---------- arrastar para selecionar
(() => {
  // rolagem automática perto das bordas enquanto arrasta
  let scrollV = 0; let scrollTimer = null;
  const autoScroll = (y) => {
    const top = $('#crumbs').getBoundingClientRect().bottom; const edge = 56;
    scrollV = y < top + edge ? -Math.ceil((top + edge - y) / 4) : y > innerHeight - edge ? Math.ceil((y - innerHeight + edge) / 4) : 0;
    if (scrollV && !scrollTimer) scrollTimer = setInterval(() => { if (scrollV) scrollBy(0, scrollV); }, 16);
    if (!scrollV && scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
  };
  const stopScroll = () => { scrollV = 0; clearInterval(scrollTimer); scrollTimer = null; };

  // celular: segurar um item e arrastar o dedo (impede a rolagem enquanto seleciona)
  let lastY = 0;
  document.addEventListener('touchmove', (ev) => {
    const d = Admin.touchDrag; if (!d) return;
    ev.preventDefault();
    const t = ev.touches[0]; lastY = t.clientY;
    const li = document.elementFromPoint(t.clientX, t.clientY);
    const item = li && li.closest && li.closest('#list .item');
    if (item && item._entry) { Admin.anchor = d.start; Admin.range(item, d.base); }
    autoScroll(t.clientY);
  }, { passive: false });
  const endTouch = () => { if (Admin.touchDrag) { Admin.touchDrag = null; stopScroll(); } };
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  // mouse: arrastar desenha um retângulo; itens que ele toca ficam marcados (Ctrl/Shift soma à seleção)
  const box = el('div', 'sel-rect hidden'); document.body.appendChild(box);
  let drag = null;
  $('#browser').addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0 || !Admin.logged) return;
    if (ev.target.closest('button, a, input, .item-more, .tag-btn, .card, #continue, #favorites, #tag-home')) return;
    const onItem = ev.target.closest('#list .item');
    if (onItem && !Admin.selecting) return; // fora da seleção, clicar num item abre normalmente
    drag = { x: ev.clientX, y: ev.clientY + scrollY, on: false, base: ev.ctrlKey || ev.metaKey || ev.shiftKey ? new Map(Admin.sel) : new Map() };
  });
  addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerType !== 'mouse') return;
    const y = ev.clientY + scrollY;
    if (!drag.on) {
      if (Math.hypot(ev.clientX - drag.x, y - drag.y) < 8) return;
      drag.on = true; Admin.enter(); box.classList.remove('hidden'); document.body.classList.add('rubber');
    }
    const r = { l: Math.min(drag.x, ev.clientX), r: Math.max(drag.x, ev.clientX), t: Math.min(drag.y, y), b: Math.max(drag.y, y) };
    Object.assign(box.style, { left: r.l + 'px', top: r.t - scrollY + 'px', width: r.r - r.l + 'px', height: r.b - r.t + 'px' });
    Admin.sel = new Map(drag.base);
    for (const li of Admin.items()) {
      const q = li.getBoundingClientRect();
      const hit = q.right > r.l && q.left < r.r && q.bottom + scrollY > r.t && q.top + scrollY < r.b;
      if (hit) Admin.sel.set(li._entry.path, li._entry);
      li.classList.toggle('selected', Admin.sel.has(li._entry.path));
    }
    Admin.updateBar();
    autoScroll(ev.clientY);
  });
  addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.on) {
      box.classList.add('hidden'); document.body.classList.remove('rubber'); stopScroll();
      // o clique que encerra o arrasto não deve alternar o item embaixo do mouse
      const eat = (e) => { e.stopPropagation(); e.preventDefault(); };
      addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', eat, { capture: true }), 50);
      if (!Admin.sel.size) Admin.updateBar();
    }
    drag = null;
  });
})();

// barra de seleção
$('#sel-close').onclick = () => Admin.exitSelect();
$('#sel-all').onclick = () => Admin.selectAll();
$('#sel-tags').onclick = () => Tags.editFor([...Admin.sel.values()], () => { Admin.exitSelect(); B.load(B.path, false); });
$('#sel-move').onclick = () => Admin.move([...Admin.sel.values()]);
$('#sel-rename').onclick = () => {
  const list = [...Admin.sel.values()];
  if (list.length === 1) Admin.rename(list[0]); else if (list.length > 1) Admin.renameMany(list);
};
$('#sel-delete').onclick = () => Admin.remove([...Admin.sel.values()]);
document.addEventListener('keydown', (e) => {
  if (!Admin.selecting || e.target.matches('input, textarea')) return;
  if (e.key === 'Escape') { Admin.exitSelect(); e.preventDefault(); }
  else if (e.key === 'Delete' && Admin.sel.size) { Admin.remove([...Admin.sel.values()]); e.preventDefault(); }
  else if (e.key === 'F2' && Admin.sel.size) { $('#sel-rename').click(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { Admin.selectAll(); e.preventDefault(); }
});

Promise.all([Admin.status(), Tags.load()]).then(() => { if (B.tagView) Tags.renderView(); else if (B.loaded) B.render(); });
