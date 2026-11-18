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
    // as perguntas vêm primeiro: o cruzamento com as tags pode aprender rostos e mudar grupos/sugestões
    const qs0 = await api('people/questions').catch(() => ({ questions: [], learned: 0, auto: 0 }));
    const [st, cl, sg] = await Promise.all([api('people/status'), api('people/clusters'), api('people/suggestions')]);
    if (qs0.learned) toast(`Aprendi ${qs0.learned} rosto(s) a partir das tags dos vídeos`);
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
    const exb = el('button', 'btn', `Pastas excluídas${st.excluded.length ? ` (${st.excluded.length})` : ''}`); exb.onclick = () => excludedSheet('faces');
    btns.appendChild(exb);
    card.appendChild(btns);
    body.appendChild(card);

    // --- perguntas do cruzamento tags x rostos
    if (qs0.questions.length) body.appendChild(questionsSection(qs0));
    else if (qs0.auto) body.appendChild(el('div', 'pp-note pp-learned', `${icon('check')} ${qs0.auto} rosto(s) aprendidos sozinhos a partir das tags que os vídeos já tinham.`));

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
  function questionsSection(qd) {
    const sec = el('section', 'pp-sec pp-qs');
    sec.appendChild(el('h2', '', `Perguntas <small>${qd.total}</small>`));
    sec.appendChild(el('div', 'pp-note', 'Cruzei as tags que os vídeos já têm (manuais ou pelo nome do arquivo) com os rostos encontrados. Onde não tive certeza, preciso da sua ajuda — cada resposta ensina e costuma resolver vários vídeos de uma vez.'));
    for (const q of qd.questions) {
      const card = el('div', 'pp-q');
      const title = q.kind === 'isperson'
        ? `“${esc(q.tag)}” é uma pessoa? É este rosto?`
        : `Quem é ${Tags.chip(q.tag)} neste vídeo?`;
      card.innerHTML = `<div class="pp-q-h">${title}</div><div class="pp-q-v">${esc(stripExt(q.name))}</div><div class="pp-note">${esc(q.reason)}${q.more ? ` · mais ${q.more} vídeo(s) com a mesma dúvida` : ''}</div>`;
      const opts = el('div', 'pp-q-opts');
      const send = async (body, msg) => {
        card.classList.add('busy');
        try { const r = await apiPost('people/answer', null, { tag: q.tag, path: q.path, ...body }); if (r.tags) Tags.apply(r); if (msg) toast(msg); render(); }
        catch (e) { card.classList.remove('busy'); toast(e.message); }
      };
      for (const o of q.options) {
        const b = el('button', 'pp-q-opt');
        b.innerHTML = `<div class="pp-faces">${o.faces.map((id) => `<img src="${crop(id)}" alt="" loading="lazy">`).join('')}</div><span>${q.kind === 'isperson' ? `Sim, é ${esc(q.tag)}` : 'É esta pessoa'}</span>${o.seen ? `<small>aparece em ${o.seen} outro(s) vídeo(s) com a tag</small>` : ''}`;
        b.onclick = () => send({ faces: o.all }, `Aprendido: ${q.tag}`);
        opts.appendChild(b);
      }
      card.appendChild(opts);
      const acts = el('div', 'pp-actions');
      if (q.kind === 'isperson') {
        const no = el('button', 'btn', 'Não é uma pessoa'); no.onclick = () => send({ notPerson: true });
        acts.appendChild(no);
      } else {
        const none = el('button', 'btn', `${esc(q.tag)} não aparece`); none.onclick = () => send({ none: true });
        const open1 = el('button', 'btn', `${icon('play')}Ver o vídeo`); open1.onclick = () => { close(); whenHistoryIdle(() => P.open({ path: q.path, name: q.name, type: 'video' })); };
        acts.append(none, open1);
      }
      card.appendChild(acts);
      sec.appendChild(card);
    }
    return sec;
  }

  async function personSheet(t) {
    const r = await api('people/person', { tag: t.name });
    Sheet.open((b) => {
      Sheet.header(b, t.name);
      Sheet.row(b, { ico: 'tag', label: 'Ver vídeos desta pessoa', onClick: () => { Sheet.close(); close(); whenHistoryIdle(() => Tags.openView(t.name)); } });
      b.appendChild(el('div', 'sheet-note', 'Rostos usados para reconhecer esta pessoa (“auto” = aprendido pelas tags dos vídeos). Toque num rosto para removê-lo se estiver errado — ele não será aprendido de novo.'));
      const faces = el('div', 'pp-sheet-faces');
      for (const id of r.faces) {
        const auto = (r.auto || []).includes(id);
        const im = el('button', 'pp-ref' + (auto ? ' auto' : ''), `<img src="${crop(id)}" alt=""><span>${icon('close')}</span>${auto ? '<em>auto</em>' : ''}`);
        if (auto) im.title = 'Aprendido sozinho pelas tags dos vídeos';
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
    await loadExcluded();
    const intro = el('div', 'pp-card');
    intro.innerHTML = `<div class="pp-sub">Procura o nome de cada pessoa (e os apelidos) no nome dos arquivos de vídeo — sem diferenciar maiúsculas, acentos, pontos, traços ou “_”. Ex.: <code>Maria.Souza.2024.1080p</code> encontra “Maria Souza”.</div>`;
    const acts = el('div', 'pp-actions');
    const scanAll = el('button', 'btn primary', `${icon('search')}Procurar na biblioteca toda`);
    const scanHere = el('button', 'btn', 'Só nesta pasta');
    scanHere.disabled = !B.path;
    const exb = el('button', 'btn', `Pastas excluídas${excl.names.length ? ` (${excl.names.length})` : ''}`);
    exb.onclick = () => excludedSheet('names');
    acts.append(scanAll, scanHere, exb); intro.appendChild(acts);
    body.appendChild(intro);
    const out = el('div'); body.appendChild(out);
    let scope = '';
    const run = async (sc = scope) => {
      scope = sc;
      out.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      const [r, sim] = await Promise.all([apiPost('people/names', null, { scope }), api('tags', { similar: 1 }).catch(() => ({ groups: [] }))]);
      out.innerHTML = '';
      if (r.skipped) out.appendChild(el('div', 'pp-note', `${r.skipped} vídeo(s) em pastas excluídas não foram considerados.`));

      // pessoas cadastradas com nomes quase iguais (provável erro de digitação ao criar)
      const dupPeople = sim.groups.filter((g) => g.some((x) => x.person));
      if (dupPeople.length) {
        const sd = el('div', 'pp-card pp-warn');
        sd.innerHTML = `<div class="pp-sub"><b>${dupPeople.length} grupo(s) de pessoas com nomes muito parecidos</b> — ${dupPeople.slice(0, 3).map((g) => g.map((x) => `“${esc(x.name)}”`).join(' / ')).join(' · ')}. Pode ser a mesma pessoa com erro de digitação.</div>`;
        const jb = el('button', 'btn', 'Revisar e juntar'); jb.onclick = () => Tags.similarSheet();
        const a2 = el('div', 'pp-actions'); a2.appendChild(jb); sd.appendChild(a2);
        out.appendChild(sd);
      }

      // sugestões agrupadas por pessoa, com caixas de seleção
      const s1 = el('section', 'pp-sec');
      s1.appendChild(el('h2', '', `Encontrados${r.suggestions.length ? ` <small>${r.suggestions.length}</small>` : ''}`));
      if (!r.suggestions.length) s1.appendChild(el('div', 'pp-note', persons().length ? 'Nenhum arquivo novo com o nome das pessoas cadastradas.' : 'Nenhuma pessoa cadastrada ainda. Crie abaixo a partir dos nomes repetidos, ou marque uma tag como pessoa (⋮ ao lado da tag).'));
      else {
        const sel = new Set(r.suggestions.map((_, i) => i));
        const byTag = {};
        r.suggestions.forEach((x, i) => { (byTag[x.tag] = byTag[x.tag] || []).push([x, i]); });
        const ap = el('button', 'btn primary pp-applyall', '');
        const upd = () => { ap.textContent = `Aplicar selecionados (${sel.size})`; ap.disabled = !sel.size; };
        s1.appendChild(ap);
        for (const [tag, list] of Object.entries(byTag)) {
          s1.appendChild(el('div', 'pp-tagh', `${Tags.chip(tag)} <small>${list.length} arquivo(s)</small>`));
          for (const [x, i] of list) {
            const row = el('div', 'pp-namerow');
            row.innerHTML = `<input type="checkbox" checked><span>${highlightName(x.name, x.match)}</span><small>${esc(dirname(x.path))}</small>`;
            $('input', row).onchange = (e) => { if (e.target.checked) sel.add(i); else sel.delete(i); upd(); };
            row.onclick = (e) => { if (e.target.closest('input, button')) return; const c = $('input', row); c.checked = !c.checked; c.onchange({ target: c }); };
            const no = el('button', 'icon-btn pp-no', icon('close')); no.title = `Não é ${tag} (não sugerir de novo)`;
            no.onclick = async () => { await apiPost('people/name-reject', null, { pairs: [x] }); sel.delete(i); row.remove(); upd(); };
            row.appendChild(no);
            s1.appendChild(row);
          }
        }
        upd();
        ap.onclick = async () => {
          const res = await apiPost('people/apply', null, { pairs: [...sel].map((i) => r.suggestions[i]) });
          Tags.apply(res); toast(`${res.applied} tag(s) aplicada(s)`); run();
        };
        s1.appendChild(el('div', 'pp-note', 'O ✕ ao lado do arquivo diz que aquele nome não é a pessoa — ele não volta a ser sugerido.'));
      }
      out.appendChild(s1);

      // grafias parecidas com o nome de uma pessoa cadastrada
      if (r.typos.length) {
        const s3 = el('section', 'pp-sec');
        s3.appendChild(el('h2', '', `Parece erro de digitação <small>${r.typos.length}</small>`));
        s3.appendChild(el('div', 'pp-note', 'Nomes nos arquivos muito parecidos com o de uma pessoa cadastrada. Se for a mesma pessoa, a grafia vira um apelido e os arquivos passam a ser encontrados.'));
        for (const t of r.typos) {
          const row = el('div', 'pp-cand');
          row.innerHTML = `<div><b>${esc(t.name)}</b> <small>em ${t.files} arquivo(s)</small> → ${Tags.chip(t.tag)}<div class="pp-sample">${t.sample.map(esc).join(' · ')}</div></div>`;
          const bx = el('div', 'pp-cand-b');
          const yes = el('button', 'btn primary', 'É a mesma pessoa');
          yes.onclick = async () => { const res = await apiPost('people/alias', null, { tag: t.tag, alias: t.name, person: true }); Tags.apply(res); toast(`“${t.name}” agora também encontra ${t.tag}`); run(); };
          const no = el('button', 'btn', 'Não é');
          no.onclick = async () => { await apiPost('people/name-ignore', null, { names: [t.name] }); row.remove(); };
          const adj = el('button', 'btn', `${icon('edit')}Ajustar`);
          adj.onclick = () => adjustSheet(t.name, () => run(), [t.name]);
          bx.append(yes, adj, no); row.appendChild(bx); s3.appendChild(row);
        }
        out.appendChild(s3);
      }

      // nomes que se repetem em vários arquivos e ainda não são pessoas
      const s2 = el('section', 'pp-sec');
      s2.appendChild(el('h2', '', 'Nomes que se repetem'));
      if (!r.names.length) s2.appendChild(el('div', 'pp-note', 'Nenhum nome novo repetido (2 ou mais palavras com inicial maiúscula em pelo menos 2 arquivos).'));
      for (const n of r.names) {
        const row = el('div', 'pp-cand');
        const vars = n.variants.length ? `<div class="pp-var">Também escrito: ${n.variants.map((v) => `<b>${esc(v.name)}</b> (${v.files})`).join(', ')} — provável erro de digitação</div>` : '';
        row.innerHTML = `<div><b>${esc(n.name)}</b> <small>em ${n.files} arquivos</small>${vars}<div class="pp-sample">${n.sample.map(esc).join(' · ')}</div></div>`;
        const bx = el('div', 'pp-cand-b');
        const mk = el('button', 'btn primary', 'Criar pessoa');
        mk.onclick = async () => {
          const t = await apiPost('people/name', null, { faces: [], name: n.name, apply: false });
          if (n.variants.length) await apiPost('tags', { action: 'edit' }, { name: t.tag, aliases: n.variants.map((v) => v.name) }).then((x) => Tags.apply(x));
          else Tags.apply(t);
          toast(`“${n.name}” criada como pessoa${n.variants.length ? ` (com ${n.variants.length} grafia(s) parecida(s))` : ''}`); run();
        };
        const no = el('button', 'btn', 'Não é nome');
        no.title = 'Não é uma pessoa — não sugerir de novo';
        no.onclick = async () => { await apiPost('people/name-ignore', null, { names: [n.name, ...n.variants.map((v) => v.name)] }); row.remove(); };
        const adj = el('button', 'btn', `${icon('edit')}Ajustar`); adj.title = 'Corrigir o nome (ex.: tirar uma palavra a mais)';
        adj.onclick = () => adjustSheet(n.name, () => run(), [n.name, ...n.variants.map((v) => v.name)]);
        const lk = el('button', 'btn', `${icon('tag')}É de outra tag`); lk.title = 'Este nome pertence a uma tag que já existe';
        lk.onclick = () => linkToTag([n.name, ...n.variants.map((v) => v.name)], () => run());
        bx.append(mk, adj, lk, no); row.appendChild(bx); s2.appendChild(row);
      }
      if (r.ignored) {
        const ig = el('button', 'pp-link', `${r.ignored} nome(s) marcado(s) como “não é nome” — ver/desfazer`);
        ig.onclick = () => ignoredSheet(() => run());
        s2.appendChild(ig);
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

  // ================================================================ pastas excluídas (rosto e nome do arquivo)
  const KINDS = {
    faces: { title: 'Pastas fora da análise de rosto', off: 'não será mais analisada por rosto', on: 'volta para a análise de rosto',
      row: ['Não analisar rostos nesta pasta', 'Voltar a analisar rostos nesta pasta', 'Sem análise de rosto (pasta acima excluída)'],
      pick: 'Excluir esta pasta da análise de rosto',
      note: 'Os vídeos destas pastas (e das subpastas) não são enviados ao ajudante, e os rostos já encontrados nelas deixam de aparecer nos grupos e nas sugestões.' },
    names: { title: 'Pastas fora da busca por nome', off: 'não entra mais na busca pelo nome do arquivo', on: 'volta para a busca pelo nome do arquivo',
      row: ['Não procurar nomes de pessoas nesta pasta', 'Voltar a procurar nomes nesta pasta', 'Sem busca por nome (pasta acima excluída)'],
      pick: 'Excluir esta pasta da busca por nome',
      note: 'Os arquivos destas pastas (e das subpastas) não são considerados ao procurar nomes de pessoas no nome do arquivo.' },
  };
  const excl = { faces: null, names: null };
  async function loadExcluded() {
    try { const r = await api('people/exclude'); excl.faces = r.excluded; excl.names = r.names || []; } catch { excl.faces = []; excl.names = []; }
    return excl;
  }
  const isExcluded = (p, kind = 'faces') => (excl[kind] || []).some((x) => p === x || p.startsWith(x + '/'));
  async function setExcluded(p, on, kind = 'faces') {
    try {
      const r = await apiPost('people/exclude', null, { path: p, on, kind });
      excl.faces = r.excluded; excl.names = r.names || [];
      toast(`“${basename(p) || 'Início'}” ${on ? KINDS[kind].off : KINDS[kind].on}`);
      if (open) render();
    } catch (e) { toast(e.message); }
  }
  // linhas no menu ⋮ de uma pasta (modo administrador)
  function folderRow(b, e) {
    if (excl.faces === null) loadExcluded();
    for (const kind of ['faces', 'names']) {
      const on = isExcluded(e.path, kind);
      const parentEx = on && !excl[kind].includes(e.path);
      const k = KINDS[kind];
      Sheet.row(b, { ico: kind === 'faces' ? 'person' : 'search', label: parentEx ? k.row[2] : on ? k.row[1] : k.row[0],
        onClick: () => { Sheet.close(); if (parentEx) whenHistoryIdle(() => excludedSheet(kind)); else setExcluded(e.path, !on, kind); } });
    }
  }
  async function excludedSheet(kind = 'faces') {
    await loadExcluded();
    const k = KINDS[kind]; const list = excl[kind];
    Sheet.open((b) => {
      Sheet.header(b, k.title);
      b.appendChild(el('div', 'sheet-note', k.note));
      if (!list.length) b.appendChild(el('div', 'sheet-note', 'Nenhuma pasta excluída.'));
      for (const p of list) Sheet.row(b, { ico: 'folder', label: p || 'Início', value: 'Incluir de novo', onClick: async () => { await setExcluded(p, false, kind); excludedSheet(kind); } });
      Sheet.row(b, { ico: 'add', label: 'Excluir uma pasta…', onClick: () => pickFolder(B.tagView ? '' : B.path, kind) });
    });
  }
  // navegador de pastas simples para escolher qual excluir
  async function pickFolder(cur, kind = 'faces') {
    let items = [];
    try { items = (await api('list', { path: cur })).entries.filter((i) => i.type === 'dir').map((i) => ({ ...i, path: cur ? `${cur}/${i.name}` : i.name })); } catch (e) { toast(e.message); }
    Sheet.open((b) => {
      Sheet.header(b, cur ? basename(cur) : 'Início', cur ? () => pickFolder(dirname(cur), kind) : () => excludedSheet(kind));
      if (cur) {
        const on = isExcluded(cur, kind);
        Sheet.row(b, { ico: on ? 'check' : 'close', label: on ? 'Esta pasta já está excluída' : KINDS[kind].pick, onClick: on ? null : async () => { await setExcluded(cur, true, kind); excludedSheet(kind); } });
      }
      if (!items.length) b.appendChild(el('div', 'sheet-note', 'Sem subpastas.'));
      for (const d of items) Sheet.row(b, { ico: 'folder', label: d.name, value: isExcluded(d.path, kind) ? 'excluída' : null, chevron: true, onClick: () => pickFolder(d.path, kind) });
    });
  }

  // ajustar um nome encontrado (ex.: "Carlos Pereira Show" -> "Carlos Pereira") e conferir de novo:
  // em quantos arquivos aparece, grafias parecidas e se já existe uma pessoa com nome igual/parecido
  function adjustSheet(orig, after, oldNames = []) {
    let res = null; const pickVar = new Set();
    Sheet.open((b) => {
      Sheet.header(b, 'Ajustar nome');
      b.appendChild(el('div', 'sheet-note', `Encontrado como “${esc(orig)}”. Corrija o nome (tire palavras a mais, acerte a grafia) e confira de novo.`));
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="text" maxlength="60" required><button class="btn primary">Conferir</button><div class="login-err"></div>';
      const inp = $('input', f); inp.value = orig;
      b.appendChild(f);
      const out = el('div', 'pp-adj'); b.appendChild(out);
      const done = async (msg) => {
        // o nome antigo (com a palavra a mais) não volta a ser sugerido
        const old = oldNames.filter((x) => Tags.key(x) !== Tags.key(res.name) && !res.variants.some((v) => Tags.key(v.name) === Tags.key(x)) && !pickVar.has(x));
        if (old.length) await apiPost('people/name-ignore', null, { names: old }).catch(() => {});
        Sheet.close(); toast(msg); if (after) whenHistoryIdle(after);
      };
      const show = () => {
        out.innerHTML = '';
        const r = res;
        out.appendChild(el('div', 'pp-adj-h', `<b>${esc(r.name)}</b> aparece em <b>${r.files}</b> arquivo(s)`));
        if (r.sample.length) out.appendChild(el('div', 'pp-sample', r.sample.map(esc).join(' · ')));
        if (r.variants.length) {
          out.appendChild(el('div', 'pp-adj-h', 'Grafias parecidas (marque as que são a mesma pessoa):'));
          for (const v of r.variants) {
            const row = el('label', 'pp-namerow');
            row.innerHTML = `<input type="checkbox"><span><b>${esc(v.name)}</b> <small>${v.files} arquivo(s)</small></span><small>${esc(v.sample)}</small>`;
            const cb = $('input', row); cb.checked = pickVar.has(v.name);
            cb.onchange = () => { if (cb.checked) pickVar.add(v.name); else pickVar.delete(v.name); };
            out.appendChild(row);
          }
        }
        const acts = el('div', 'pp-actions');
        const target = r.same || r.like;
        if (r.like) out.appendChild(el('div', 'pp-var', `Parece com a pessoa “${esc(r.like)}” já cadastrada.`));
        if (target) {
          const add = el('button', 'btn primary', r.same ? `Usar a pessoa “${esc(r.same)}”` : `É ${esc(r.like)}: adicionar como apelido`);
          add.onclick = async () => {
            let t = null;
            for (const al of [r.name, ...pickVar]) {
              if (Tags.key(al) === Tags.key(target)) continue;
              t = await apiPost('people/alias', null, { tag: target, alias: al, person: !!r.like });
            }
            if (!t) t = await apiPost('tags', { action: 'edit' }, { name: target, person: true });
            Tags.apply(t); done(`“${r.name}” ligado a ${target}`);
          };
          acts.appendChild(add);
        }
        const lk = el('button', 'btn', `${icon('tag')}É de outra tag…`);
        lk.onclick = () => linkToTag([r.name, ...pickVar], async () => { await done('Nome ligado à tag'); }, true);
        if (!r.same) {
          const mk = el('button', 'btn' + (target ? '' : ' primary'), `Criar pessoa “${esc(r.name)}”`);
          mk.onclick = async () => {
            const t = await apiPost('people/name', null, { faces: [], name: r.name, apply: false });
            let tl = t;
            if (pickVar.size) tl = await apiPost('tags', { action: 'edit' }, { name: t.tag, aliases: [...pickVar] });
            Tags.apply(tl); done(`“${r.name}” criada como pessoa${pickVar.size ? ` (+${pickVar.size} grafia(s))` : ''}`);
          };
          acts.appendChild(mk);
        }
        acts.appendChild(lk);
        out.appendChild(acts);
        if (!r.files && !r.variants.length) out.appendChild(el('div', 'pp-note', 'Nenhum arquivo com esse nome. Confira a grafia.'));
      };
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        $('.login-err', f).textContent = '';
        out.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        try { res = await apiPost('people/name-check', null, { name: inp.value }); pickVar.clear(); show(); }
        catch (e) { out.innerHTML = ''; $('.login-err', f).textContent = e.message; }
      };
      if (!IS_TOUCH) setTimeout(() => { inp.focus(); inp.select(); }, 60);
    });
  }

  // indicar que o nome encontrado é de uma tag que já existe: vira um apelido dela, e os arquivos com
  // esse nome passam a ser sugeridos para a tag
  function linkToTag(names, after, quiet) {
    let q = '';
    Sheet.open((b) => {
      b.classList.add('move-sheet');
      const top = el('div', 'move-top');
      const h = el('h3'); h.textContent = `“${names[0]}” é de qual tag?`;
      const sb = el('div', 'move-search');
      sb.innerHTML = `${icon('search')}<input type="search" maxlength="40" placeholder="Buscar tag…" autocomplete="off">`;
      const input = $('input', sb);
      top.append(h, sb, el('div', 'sheet-note tag-hint', `${names.length > 1 ? `“${names.map(esc).join('”, “')}” viram` : 'O nome vira'} outro nome da tag escolhida. Os arquivos com esse nome passam a aparecer em “Encontrados” para essa tag.`));
      const list = el('div', 'move-list');
      const render = () => {
        list.innerHTML = '';
        const ql = Tags.key(q);
        const shown = Tags.list.filter((t) => !ql || Tags.key(t.name).includes(ql) || (t.aliases || []).some((a) => Tags.key(a).includes(ql)));
        for (const t of shown) {
          const r = el('button', 'row');
          r.innerHTML = `<i class="tag-dot" style="background:${t.color}"></i><span class="lbl">${esc(t.name)}</span>${t.person ? '<span class="val">pessoa</span>' : ''}<span class="val">${t.count}</span>`;
          r.onclick = async () => {
            try {
              let res = null;
              for (const n of names) if (Tags.key(n) !== Tags.key(t.name)) res = await apiPost('people/alias', null, { tag: t.name, alias: n });
              if (res) Tags.apply(res);
              if (!quiet) { Sheet.close(); toast(`“${names[0]}” ligado à tag ${t.name}`); }
              if (after) whenHistoryIdle(after);
            } catch (e) { toast(e.message); }
          };
          list.appendChild(r);
        }
        if (!shown.length) list.appendChild(el('div', 'sheet-note', 'Nenhuma tag encontrada.'));
      };
      input.addEventListener('input', () => { q = input.value; render(); });
      b.append(top, list); render();
      if (!IS_TOUCH) setTimeout(() => input.focus(), 60);
    });
  }

  // nomes marcados como "não é nome de pessoa" (para desfazer)
  async function ignoredSheet(after) {
    let names = [];
    try { names = (await api('people/name-ignore')).names; } catch (e) { toast(e.message); return; }
    Sheet.open((b) => {
      Sheet.header(b, 'Não são nomes de pessoas');
      b.appendChild(el('div', 'sheet-note', 'Estes nomes não são mais sugeridos. Toque para voltar a sugerir.'));
      if (!names.length) b.appendChild(el('div', 'sheet-note', 'Nenhum.'));
      for (const n of names) Sheet.row(b, { ico: 'close', label: n, value: 'Voltar a sugerir', onClick: async () => { await apiPost('people/name-ignore', null, { names: [n], on: false }); if (after) after(); ignoredSheet(after); } });
    });
  }

  return { show, close, folderRow, loadExcluded, get open() { return open; } };
})();
