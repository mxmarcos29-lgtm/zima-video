'use strict';
/* Zima Video — página com todas as tags em ordem alfabética, com índice de letras na lateral */

const TagIndex = (() => {
  let root = null; let open = false; let q = ''; let kind = 'all';
  const letterOf = (name) => { const c = norm(name.trim()).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
  const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

  function build() {
    root = el('div', 'tagsp hidden');
    root.innerHTML = `
      <div class="tp-bar">
        <button class="icon-btn tp-close" aria-label="Voltar">${icon('back')}</button>
        <div class="tp-title">Tags</div>
        <div class="move-search tp-search">${icon('search')}<input type="search" maxlength="40" placeholder="Buscar tag…" autocomplete="off"></div>
        <div class="chips tp-kinds">
          <button class="chip" data-k="all">Todas</button>
          <button class="chip" data-k="person">Pessoas</button>
          <button class="chip" data-k="other">Outras</button>
        </div>
      </div>
      <div class="tp-list"></div>
      <nav class="tp-index" aria-label="Ir para a letra"></nav>
      <div class="tp-bubble hidden"></div>`;
    document.body.appendChild(root);
    $('.tp-close', root).onclick = () => close();
    const inp = $('.tp-search input', root);
    inp.addEventListener('input', () => { q = inp.value; renderList(); root.scrollTop = 0; });
    root.querySelectorAll('.tp-kinds .chip').forEach((c) => { c.onclick = () => { kind = c.dataset.k; renderList(); root.scrollTop = 0; }; });
    bindIndex($('.tp-index', root));
  }

  async function show() {
    if (!root) build();
    open = true; q = ''; $('.tp-search input', root).value = '';
    root.classList.remove('hidden');
    document.body.classList.add('lock');
    pushLayer('tagsall', hide);
    renderList();
    await Tags.load(); // lista atualizada (contagens)
    if (open) renderList();
    if (!IS_TOUCH) setTimeout(() => $('.tp-search input', root).focus(), 60);
  }
  function hide() { open = false; root.classList.add('hidden'); document.body.classList.toggle('lock', P.state === 'max' || Search.open || (typeof People !== 'undefined' && People.open)); }
  function close() { if (open) closeLayer('tagsall'); }

  function renderList() {
    root.querySelectorAll('.tp-kinds .chip').forEach((c) => c.classList.toggle('active', c.dataset.k === kind));
    const list = $('.tp-list', root); list.innerHTML = '';
    const ql = Tags.key(q);
    const tags = Tags.list.filter((t) => (kind === 'all' || (kind === 'person') === !!t.person)
      && (!ql || Tags.key(t.name).includes(ql) || (t.aliases || []).some((a) => Tags.key(a).includes(ql))));
    // grupos por letra inicial (já vem em ordem alfabética)
    const groups = new Map();
    for (const t of tags) { const l = letterOf(t.name); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(t); }
    const order = LETTERS.filter((l) => groups.has(l));
    for (const l of order) {
      const sec = el('section', 'tp-sec'); sec.dataset.letter = l;
      sec.appendChild(el('h3', 'tp-letter', l));
      for (const t of groups.get(l)) {
        const r = el('button', 'tp-row' + (t.count ? '' : ' empty'));
        const alias = ql && !Tags.key(t.name).includes(ql) ? (t.aliases || []).find((a) => Tags.key(a).includes(ql)) : null;
        r.innerHTML = `<i class="tag-dot" style="background:${t.color}"></i><span class="tp-name">${esc(t.name)}${alias ? `<small> · ${esc(alias)}</small>` : ''}</span>`
          + `${t.person ? `<span class="tp-person" title="Pessoa">${icon('person')}</span>` : ''}<span class="tp-count">${t.count}</span>`;
        r.onclick = () => { close(); whenHistoryIdle(() => Tags.openView(t.name)); };
        if (Admin.logged) {
          const more = el('span', 'icon-btn tp-more', icon('more')); more.title = 'Cor, renomear, juntar, excluir…';
          more.onclick = (ev) => { ev.stopPropagation(); Tags.manage(t, null); };
          r.appendChild(more);
        }
        sec.appendChild(r);
      }
      list.appendChild(sec);
    }
    if (!order.length) list.appendChild(el('div', 'empty', `${icon('tag')}${q ? 'Nenhuma tag encontrada' : 'Nenhuma tag ainda'}`));
    else list.appendChild(el('div', 'tp-foot', `${tags.length} tag(s)`));
    // índice: letras com tags ficam ativas
    const idx = $('.tp-index', root); idx.innerHTML = '';
    for (const l of LETTERS) { const b = el('span', 'tp-l' + (groups.has(l) ? '' : ' off'), l); b.dataset.letter = l; idx.appendChild(b); }
    idx.classList.toggle('hidden', order.length < 2);
    root.style.setProperty('--tp-bar', `${$('.tp-bar', root).offsetHeight}px`);
  }

  // ir até a letra: toque ou arraste o dedo/mouse sobre o índice
  function jump(l) {
    const secs = [...root.querySelectorAll('.tp-sec')];
    if (!secs.length) return;
    // letra sem tags: vai para a próxima que existe (ou a última)
    const i = LETTERS.indexOf(l);
    const target = secs.find((s) => LETTERS.indexOf(s.dataset.letter) >= i) || secs[secs.length - 1];
    const bar = $('.tp-bar', root).offsetHeight;
    root.scrollTop = target.offsetTop - bar;
    const bub = $('.tp-bubble', root); bub.textContent = target.dataset.letter; bub.classList.remove('hidden');
  }
  function bindIndex(idx) {
    let active = false;
    const at = (ev) => {
      const r = idx.getBoundingClientRect();
      const y = Math.min(r.bottom - 1, Math.max(r.top, ev.clientY));
      const items = [...idx.children];
      const k = Math.floor(((y - r.top) / r.height) * items.length);
      return items[Math.min(items.length - 1, Math.max(0, k))].dataset.letter;
    };
    idx.addEventListener('pointerdown', (ev) => { active = true; idx.setPointerCapture(ev.pointerId); idx.classList.add('on'); jump(at(ev)); ev.preventDefault(); });
    idx.addEventListener('pointermove', (ev) => { if (active) jump(at(ev)); });
    const end = () => { active = false; idx.classList.remove('on'); setTimeout(() => { if (!active) $('.tp-bubble', root).classList.add('hidden'); }, 450); };
    idx.addEventListener('pointerup', end); idx.addEventListener('pointercancel', end);
  }

  return { show, close, refresh: () => { if (open) renderList(); }, get open() { return open; } };
})();
