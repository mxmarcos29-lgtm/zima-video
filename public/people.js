'use strict';
/* Zima Video — Pessoas: tags de pessoa sugeridas pelo nome dos arquivos e pelo rosto (ajudante no PC) */

const People = (() => {
  let root = null; let open = false; let tab = 'faces';
  const crop = (id) => `/api/people/crop?${qs({ id })}`;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const ago = (ms) => {
    if (!ms) return 'nunca';
    const s = (Date.now() - ms) / 1000;
    if (s < 90) return 'agora';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    return fmtDate(ms);
  };
  const persons = () => Tags.list.filter((t) => t.person);

  function build() {
    root = el('div', 'people hidden');
    root.innerHTML = `
      <div class="pp-bar">
        <button class="icon-btn pp-close" aria-label="Voltar">${icon('back')}</button>
        <div class="pp-title">Pessoas</div>
        <div class="chips pp-tabs">
          <button class="chip" data-tab="faces">Por rosto</button>
          <button class="chip" data-tab="names">Pelo nome do arquivo</button>
        </div>
      </div>
      <div class="pp-body"></div>`;
    document.body.appendChild(root);
    $('.pp-close', root).onclick = () => close();
    root.querySelectorAll('.pp-tabs .chip').forEach((c) => { c.onclick = () => { tab = c.dataset.tab; render(); }; });
  }

  function show(t) {
    Admin.need(() => {
      if (!root) build();
      if (t) tab = t;
      open = true;
      root.classList.remove('hidden');
      document.body.classList.add('lock');
      pushLayer('people', hide);
      render();
    });
  }
  function hide() { open = false; root.classList.add('hidden'); document.body.classList.toggle('lock', P.state === 'max' || Search.open); B.load(B.path, false); }
  function close() { if (open) closeLayer('people'); }

  async function render() {
    root.querySelectorAll('.pp-tabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.tab === tab));
    const body = $('.pp-body', root);
    body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try { if (tab === 'faces') await renderFaces(body); else await renderNames(body); }
    catch (e) { body.innerHTML = `<div class="empty">${icon('info')}${esc(e.message)}</div>`; }
  }

  // ================================================================ por rosto
  async function renderFaces(body) {
    const [st, cl, sg] = await Promise.all([api('people/status'), api('people/clusters'), api('people/suggestions')]);
    await Tags.load();
    body.innerHTML = '';

    // --- situação da análise e do ajudante
    const w = st.workers.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    const online = w.find((x) => Date.now() - x.lastSeen < 3 * 60000);
    const card = el('div', 'pp-card');
    const pctDone = st.videos ? Math.round((st.analyzed / st.videos) * 100) : 0;
    card.innerHTML = `
      <div class="pp-stat"><b>${st.analyzed}</b> de ${st.videos} vídeos analisados${st.failed ? ` · ${st.failed} com erro` : ''}${st.skipped ? ` · ${st.skipped} em pastas excluídas` : ''}</div>
      <div class="pp-progress"><div style="width:${pctDone}%"></div></div>
      <div class="pp-sub">${w.length ? (online ? `Ajudante ativo: ${esc(online.name)} — ${esc(online.info || '')}` : `Ajudante desligado (${esc(w[0].name)}, visto ${ago(w[0].lastSeen)})`) : 'Nenhum ajudante conectado ainda: a análise de rostos roda no seu PC.'}</div>`;
    const btns = el('div', 'pp-actions');
    const cb = el('button', 'btn primary', `${icon('add')}${w.length ? 'Ajudante / conectar outro PC' : 'Conectar ajudante (PC)'}`); cb.onclick = connectSheet;
    btns.appendChild(cb);
    if (st.failed) { const rb = el('button', 'btn', 'Tentar de novo os com erro'); rb.onclick = async () => { await apiPost('people/reanalyze', null, { failed: true }); toast('Os vídeos com erro voltam para a fila'); render(); }; btns.appendChild(rb); }
    const exb = el('button', 'btn', `Pastas excluídas${st.excluded.length ? ` (${st.excluded.length})` : ''}`); exb.onclick = excludedSheet;
    btns.appendChild(exb);
    card.appendChild(btns);
    body.appendChild(card);

    // --- sugestões por rosto
    const sug = sg.suggestions;
    const s1 = el('section', 'pp-sec');
    s1.appendChild(el('h2', '', `Sugestões${sug.length ? ` <small>${sug.length}</small>` : ''}`));
    if (!sug.length) s1.appendChild(el('div', 'pp-note', persons().length ? 'Nenhuma sugestão nova. Conforme o ajudante analisa mais vídeos, aparecem aqui os vídeos em que as pessoas que você nomeou foram reconhecidas.' : 'Dê nome a um grupo de rostos abaixo: depois disso, os vídeos em que essa pessoa aparece são sugeridos aqui.'));
    else {
      const all = el('button', 'btn primary pp-applyall', `Aplicar todas (${sug.length})`);
      all.onclick = async () => { const r = await apiPost('people/apply', null, { pairs: sug }); Tags.apply(r); toast(`${r.applied} tag(s) aplicada(s)`); render(); };
      s1.appendChild(all);
      const list = el('div', 'pp-sugs');
      for (const sgi of sug.slice(0, 200)) {
        const row = el('div', 'pp-sug');
        row.innerHTML = `<img src="${crop(sgi.face)}" alt="" loading="lazy"><div class="pp-sug-t"><div class="pp-sug-n">${esc(stripExt(sgi.name))}</div><div class="pp-sug-m">${Tags.chip(sgi.tag)} <span>${pct(sgi.sim)} parecido</span></div></div>`;
        const ok = el('button', 'icon-btn pp-ok', icon('check')); ok.title = 'Confirmar';
        ok.onclick = async () => { const r = await apiPost('people/apply', null, { pairs: [sgi] }); Tags.apply(r); row.remove(); };
        const no = el('button', 'icon-btn', icon('close')); no.title = 'Não é esta pessoa';
        no.onclick = async () => { await apiPost('people/ignore', null, { faces: [sgi.face] }); row.remove(); };
        row.append(ok, no);
        row.querySelector('.pp-sug-n').onclick = () => { close(); whenHistoryIdle(() => P.open({ path: sgi.path, name: sgi.name, type: 'video' })); };
        list.appendChild(row);
      }
      s1.appendChild(list);
    }
    body.appendChild(s1);

    // --- grupos de rostos sem nome
    const s2 = el('section', 'pp-sec');
    s2.appendChild(el('h2', '', `Rostos sem nome${cl.clusters.length ? ` <small>${cl.clusters.length} grupos</small>` : ''}`));
    if (!cl.clusters.length) s2.appendChild(el('div', 'pp-note', st.analyzed ? 'Todos os rostos encontrados já têm nome (ou foram ignorados).' : 'Os grupos aparecem aqui conforme o ajudante analisa os vídeos.'));
    const grid = el('div', 'pp-grid');
    for (const c of cl.clusters) {
      const g = el('button', 'pp-group');
      g.innerHTML = `<div class="pp-faces">${c.sample.slice(0, 4).map((id) => `<img src="${crop(id)}" alt="" loading="lazy">`).join('')}</div><div class="pp-g-n">${c.videos} vídeo${c.videos > 1 ? 's' : ''}</div>`;
      g.onclick = () => nameSheet(c);
      grid.appendChild(g);
    }
    s2.appendChild(grid);
    body.appendChild(s2);

    // --- pessoas já nomeadas
    const ps = persons();
    const s3 = el('section', 'pp-sec');
    s3.appendChild(el('h2', '', `Pessoas${ps.length ? ` <small>${ps.length}</small>` : ''}`));
    if (!ps.length) s3.appendChild(el('div', 'pp-note', 'Nenhuma pessoa ainda. Toque num grupo de rostos para dar o nome.'));
    const pl = el('div', 'pp-people');
    for (const t of ps) {
      const b = el('button', 'pp-person');
      b.innerHTML = `<span class="pp-avatar" style="--c:${t.color}"></span><span class="pp-p-n">${esc(t.name)}</span><small>${t.count} item(ns)</small>`;
      api('people/person', { tag: t.name }).then((r) => { if (r.faces[0]) $('.pp-avatar', b).innerHTML = `<img src="${crop(r.faces[0])}" alt="">`; }).catch(() => {});
      b.onclick = () => personSheet(t);
      pl.appendChild(b);
    }
    s3.appendChild(pl);
    body.appendChild(s3);
  }

  // dar nome a um grupo de rostos
  function nameSheet(c) {
    Sheet.open((b) => {
      Sheet.header(b, 'Quem é?');
      const faces = el('div', 'pp-sheet-faces');
      faces.innerHTML = c.faces.slice(0, 12).map((id) => `<img src="${crop(id)}" alt="">`).join('');
      b.appendChild(faces);
      b.appendChild(el('div', 'sheet-note', `${c.count} rosto(s) em ${c.videos} vídeo(s). Ao salvar, a tag da pessoa é aplicada nesses vídeos e os rostos viram referência para reconhecer a pessoa nos outros vídeos.`));
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="text" list="pp-persons" placeholder="Nome da pessoa" maxlength="40" required><datalist id="pp-persons"></datalist><button class="btn primary">Salvar</button><div class="login-err"></div>';
      $('datalist', f).innerHTML = persons().map((t) => `<option value="${esc(t.name)}">`).join('');
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          const r = await apiPost('people/name', null, { faces: c.faces, name: $('input', f).value, apply: true });
          Tags.apply(r); Sheet.close(); toast(`“${r.tag}” salvo`); whenHistoryIdle(render);
        } catch (e) { $('.login-err', f).textContent = e.message; }
      };
      b.appendChild(f);
      Sheet.row(b, { ico: 'close', label: 'Ignorar este grupo (não é alguém que quero marcar)', onClick: async () => { await apiPost('people/ignore', null, { faces: c.faces }); Sheet.close(); whenHistoryIdle(render); } });
      if (!IS_TOUCH) setTimeout(() => $('input', f).focus(), 60);
    });
  }

  // rostos de referência de uma pessoa (dá para remover um que foi marcado por engano)
  async function personSheet(t) {
    const r = await api('people/person', { tag: t.name });
    Sheet.open((b) => {
      Sheet.header(b, t.name);
      Sheet.row(b, { ico: 'tag', label: 'Ver vídeos desta pessoa', onClick: () => { Sheet.close(); close(); whenHistoryIdle(() => Tags.openView(t.name)); } });
      b.appendChild(el('div', 'sheet-note', 'Rostos usados para reconhecer esta pessoa. Toque num rosto para removê-lo se estiver errado.'));
      const faces = el('div', 'pp-sheet-faces');
      for (const id of r.faces) {
        const im = el('button', 'pp-ref', `<img src="${crop(id)}" alt=""><span>${icon('close')}</span>`);
        im.onclick = async () => { await apiPost('people/unlink', null, { tag: t.name, faces: [id] }); im.remove(); };
        faces.appendChild(im);
      }
      if (!r.faces.length) faces.appendChild(el('div', 'sheet-note', 'Nenhum rosto ainda (pessoa criada pelo nome do arquivo).'));
      b.appendChild(faces);
      Sheet.row(b, { ico: 'edit', label: 'Apelidos / outras formas do nome…', onClick: () => aliasSheet(t) });
    });
  }
  function aliasSheet(t) {
    Admin.prompt(`Outros nomes de ${t.name} (separe por vírgula)`, (t.aliases || []).join(', '), async (v) => {
      const r = await apiPost('tags', { action: 'edit' }, { name: t.name, person: true, aliases: v.split(',').map((x) => x.trim()).filter(Boolean) });
      Tags.apply(r); toast('Apelidos salvos');
    });
  }

  // conectar o ajudante (PC)
  async function connectSheet() {
    const st = await api('people/status');
    Sheet.open((b) => {
      Sheet.header(b, 'Ajudante no PC');
      b.appendChild(el('div', 'sheet-note', 'O ajudante usa a placa de vídeo do seu PC (AMD, NVIDIA ou Intel) para analisar os rostos. O NAS só guarda os resultados.'));
      const steps = el('ol', 'pp-steps');
      steps.innerHTML = `
        <li><a class="btn" href="/api/people/worker.zip" download>${icon('download')}Baixar o ajudante (.zip)</a></li>
        <li>Extraia a pasta num lugar fixo e abra <b>instalar.bat</b> (instala o Python e os componentes automaticamente).</li>
        <li>Quando pedir, informe o endereço e o código abaixo.</li>
        <li>Depois é só abrir <b>iniciar.bat</b> (ou <b>iniciar_com_o_windows.bat</b> para abrir sozinho).</li>`;
      b.appendChild(steps);
      const addr = el('div', 'pp-copy', `<span>Endereço</span><code>${esc(location.origin)}</code>`);
      const ca = el('button', 'btn', 'Copiar'); ca.onclick = () => copyText(location.origin); addr.appendChild(ca);
      b.appendChild(addr);
      const pcn = el('input', 'pp-pcname'); pcn.type = 'text'; pcn.maxLength = 40; pcn.value = 'PC principal'; pcn.placeholder = 'Nome deste PC';
      b.appendChild(pcn);
      const code = el('div', 'pp-copy', '<span>Código</span><code class="pp-code">—</code>');
      const gen = el('button', 'btn primary', 'Gerar código');
      gen.onclick = async () => {
        const name = pcn.value.trim() || 'PC principal';
        try {
          const r = await apiPost('people/worker-token', null, { name });
          $('.pp-code', code).textContent = r.token;
          gen.textContent = 'Copiar'; gen.onclick = () => copyText(r.token);
          toast('Código gerado: copie e cole no ajudante (ele só aparece agora)', null, null, 6000);
        } catch (e) { toast(e.message); }
      };
      code.appendChild(gen);
      b.appendChild(code);
      if (st.workers.length) {
        b.appendChild(el('div', 'sheet-note', 'PCs conectados:'));
        for (const w of st.workers) {
          Sheet.row(b, { ico: 'close', label: `${w.name} — visto ${ago(w.lastSeen)}`, value: 'Desconectar', onClick: async () => { await apiPost('people/worker-revoke', null, { name: w.name }); toast(`${w.name} desconectado`); connectSheet(); } });
        }
      }
    });
  }

  // ================================================================ pelo nome do arquivo
  async function renderNames(body) {
    body.innerHTML = '';
    const intro = el('div', 'pp-card');
    intro.innerHTML = `<div class="pp-sub">Procura o nome de cada pessoa (e os apelidos) no nome dos arquivos de vídeo — sem diferenciar maiúsculas, acentos, pontos, traços ou “_”. Ex.: <code>Maria.Souza.2024.1080p</code> encontra “Maria Souza”.</div>`;
    const acts = el('div', 'pp-actions');
    const scanAll = el('button', 'btn primary', `${icon('search')}Procurar na biblioteca toda`);
    const scanHere = el('button', 'btn', 'Só nesta pasta');
    scanHere.disabled = !B.path;
    acts.append(scanAll, scanHere); intro.appendChild(acts);
    body.appendChild(intro);
    const out = el('div'); body.appendChild(out);
    const run = async (scope) => {
      out.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      const r = await apiPost('people/names', null, { scope });
      out.innerHTML = '';
      // sugestões agrupadas por pessoa, com caixas de seleção
      const s1 = el('section', 'pp-sec');
      s1.appendChild(el('h2', '', `Encontrados${r.suggestions.length ? ` <small>${r.suggestions.length}</small>` : ''}`));
      if (!r.suggestions.length) s1.appendChild(el('div', 'pp-note', persons().length ? 'Nenhum arquivo novo com o nome das pessoas cadastradas.' : 'Nenhuma pessoa cadastrada ainda. Crie abaixo a partir dos nomes repetidos, ou marque uma tag como pessoa (⋮ ao lado da tag).'));
      else {
        const sel = new Set(r.suggestions.map((_, i) => i));
        const byTag = {};
        r.suggestions.forEach((x, i) => { (byTag[x.tag] = byTag[x.tag] || []).push([x, i]); });
        for (const [tag, list] of Object.entries(byTag)) {
          s1.appendChild(el('div', 'pp-tagh', `${Tags.chip(tag)} <small>${list.length} arquivo(s)</small>`));
          for (const [x, i] of list) {
            const row = el('label', 'pp-namerow');
            row.innerHTML = `<input type="checkbox" checked><span>${highlightName(x.name, x.match)}</span><small>${esc(dirname(x.path))}</small>`;
            $('input', row).onchange = (e) => { if (e.target.checked) sel.add(i); else sel.delete(i); ap.textContent = `Aplicar selecionados (${sel.size})`; };
            s1.appendChild(row);
          }
        }
        const ap = el('button', 'btn primary pp-applyall', `Aplicar selecionados (${sel.size})`);
        ap.onclick = async () => {
          const res = await apiPost('people/apply', null, { pairs: [...sel].map((i) => r.suggestions[i]) });
          Tags.apply(res); toast(`${res.applied} tag(s) aplicada(s)`); run(scope);
        };
        s1.insertBefore(ap, s1.children[1]);
      }
      out.appendChild(s1);
      // nomes que se repetem em vários arquivos e ainda não são pessoas
      const s2 = el('section', 'pp-sec');
      s2.appendChild(el('h2', '', 'Nomes que se repetem'));
      if (!r.names.length) s2.appendChild(el('div', 'pp-note', 'Nenhum nome novo repetido (2 ou mais palavras com inicial maiúscula em pelo menos 2 arquivos).'));
      for (const n of r.names) {
        const row = el('div', 'pp-cand');
        row.innerHTML = `<div><b>${esc(n.name)}</b> <small>em ${n.files} arquivos</small><div class="pp-sample">${n.sample.map(esc).join(' · ')}</div></div>`;
        const mk = el('button', 'btn', 'Criar pessoa');
        mk.onclick = async () => {
          const t = await apiPost('people/name', null, { faces: [], name: n.name, apply: false });
          Tags.apply(t); toast(`“${n.name}” criada como pessoa`); run(scope);
        };
        row.appendChild(mk); s2.appendChild(row);
      }
      out.appendChild(s2);
    };
    scanAll.onclick = () => run('');
    scanHere.onclick = () => run(B.path);
    run('');
  }
  function highlightName(name, match) {
    const n = esc(name);
    const words = match.split(' ').filter(Boolean);
    return words.reduce((acc, w) => acc.replace(new RegExp(`(${w.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]?')})`, 'i'), '<mark>$1</mark>'), n);
  }

  // ================================================================ pastas fora da análise de rosto
  let excluded = null;
  async function loadExcluded() { try { excluded = (await api('people/exclude')).excluded; } catch { excluded = []; } return excluded; }
  const isExcluded = (p) => (excluded || []).some((x) => p === x || p.startsWith(x + '/'));
  async function setExcluded(p, on) {
    try {
      excluded = (await apiPost('people/exclude', null, { path: p, on })).excluded;
      toast(on ? `“${basename(p) || 'Início'}” não será mais analisada por rosto` : `“${basename(p) || 'Início'}” volta para a análise de rosto`);
      if (open) render();
    } catch (e) { toast(e.message); }
  }
  // linha no menu ⋮ de uma pasta (modo administrador)
  function folderRow(b, e) {
    if (excluded === null) loadExcluded();
    const on = isExcluded(e.path);
    const parentEx = on && !excluded.includes(e.path);
    Sheet.row(b, { ico: 'person', label: parentEx ? 'Sem análise de rosto (pasta acima excluída)' : on ? 'Voltar a analisar rostos nesta pasta' : 'Não analisar rostos nesta pasta',
      onClick: () => { Sheet.close(); if (parentEx) whenHistoryIdle(excludedSheet); else setExcluded(e.path, !on); } });
  }
  async function excludedSheet() {
    await loadExcluded();
    Sheet.open((b) => {
      Sheet.header(b, 'Pastas excluídas');
      b.appendChild(el('div', 'sheet-note', 'Os vídeos destas pastas (e das subpastas) não são enviados ao ajudante, e os rostos já encontrados nelas deixam de aparecer nos grupos e nas sugestões. A busca pelo nome do arquivo continua valendo.'));
      if (!excluded.length) b.appendChild(el('div', 'sheet-note', 'Nenhuma pasta excluída.'));
      for (const p of excluded) Sheet.row(b, { ico: 'folder', label: p || 'Início', value: 'Incluir de novo', onClick: async () => { await setExcluded(p, false); excludedSheet(); } });
      Sheet.row(b, { ico: 'add', label: 'Excluir uma pasta…', onClick: () => pickFolder(B.tagView ? '' : B.path) });
    });
  }
  // navegador de pastas simples para escolher qual excluir
  async function pickFolder(cur) {
    let items = [];
    try { items = (await api('list', { path: cur })).entries.filter((i) => i.type === 'dir').map((i) => ({ ...i, path: cur ? `${cur}/${i.name}` : i.name })); } catch (e) { toast(e.message); }
    Sheet.open((b) => {
      Sheet.header(b, cur ? basename(cur) : 'Início', cur ? () => pickFolder(dirname(cur)) : () => excludedSheet());
      if (cur) {
        const on = isExcluded(cur);
        Sheet.row(b, { ico: on ? 'check' : 'close', label: on ? 'Esta pasta já está excluída' : 'Excluir esta pasta da análise de rosto', onClick: on ? null : async () => { await setExcluded(cur, true); excludedSheet(); } });
      }
      if (!items.length) b.appendChild(el('div', 'sheet-note', 'Sem subpastas.'));
      for (const d of items) Sheet.row(b, { ico: 'folder', label: d.name, value: isExcluded(d.path) ? 'excluída' : null, chevron: true, onClick: () => pickFolder(d.path) });
    });
  }

  return { show, close, folderRow, loadExcluded, get open() { return open; } };
})();
