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

  // ---------------------------------------------------------------- rostos (miniaturas) em lotes
  // Cada <img data-crop="id"> é carregada quando aparece (ou está perto de aparecer) na tela. Os ids
  // visíveis são pedidos juntos ao servidor (até 80 por pedido, 3 pedidos ao mesmo tempo) e ficam
  // guardados nesta sessão: ao atualizar a tela, os rostos já vistos aparecem na hora.
  const Crops = (() => {
    const cache = new Map(); const want = new Map(); let inflight = 0; let timer = null;
    const io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); need(e.target); }
    }, { rootMargin: '800px 0px' });
    function need(img) {
      const id = img.dataset.crop; if (!id) return;
      if (cache.has(id)) { img.src = cache.get(id); return; }
      if (!want.has(id)) want.set(id, new Set());
      want.get(id).add(img);
      if (!timer) timer = setTimeout(flush, 10);
    }
    async function flush() {
      timer = null;
      while (want.size && inflight < 3) {
        const ids = [...want.keys()].slice(0, 80);
        const imgs = ids.map((id) => want.get(id)); ids.forEach((id) => want.delete(id));
        inflight++;
        api('people/crops', { ids: ids.join(',') }).then((r) => {
          ids.forEach((id, i) => {
            const url = r[id] ? `data:image/jpeg;base64,${r[id]}` : '';
            if (url) cache.set(id, url);
            for (const img of imgs[i]) if (url) img.src = url; else img.classList.add('pp-noimg');
          });
        }).catch(() => ids.forEach((id, i) => imgs[i].forEach((img) => { img.src = crop(id); }))) // sem lote: um por um
          .finally(() => { inflight--; if (want.size) flush(); });
      }
    }
    function scan(node) {
      if (!node.querySelectorAll) return;
      const list = node.matches && node.matches('img[data-crop]') ? [node] : node.querySelectorAll('img[data-crop]');
      for (const img of list) { if (img.src) continue; if (cache.has(img.dataset.crop)) img.src = cache.get(img.dataset.crop); else io.observe(img); }
    }
    new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) scan(n); }).observe(document.body, { childList: true, subtree: true });
    return { scan };
  })();

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
  function hide() { clearTimeout(refreshTimer); open = false; root.classList.add('hidden'); document.body.classList.toggle('lock', P.state === 'max' || Search.open); B.load(B.path, false); }
  function close() { if (open) closeLayer('people'); }

  // soft: atualiza por trás, mantendo a tela atual (e a rolagem) até a nova versão chegar — sem "carregando"
  let renderSeq = 0;
  async function render(soft = false) {
    const seq = ++renderSeq;
    root.querySelectorAll('.pp-tabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.tab === tab));
    const body = $('.pp-body', root);
    soft = soft && body.children.length && !body.querySelector(':scope > .loading');
    if (!soft) body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const into = soft ? el('div') : body;
    try {
      if (tab === 'faces') await renderFaces(into); else await renderNames(into);
      if (seq !== renderSeq) return; // outra atualização mais nova já está a caminho
      if (soft) { const y = root.scrollTop; body.replaceChildren(...into.childNodes); root.scrollTop = y; }
    } catch (e) { if (seq === renderSeq && !soft) body.innerHTML = `<div class="empty">${icon('info')}${esc(e.message)}</div>`; }
  }
  // várias confirmações seguidas viram UMA atualização (o servidor não recalcula a cada clique)
  let refreshTimer = null;
  const refresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (open) render(true); }, 900); };

  // ================================================================ por rosto
  async function renderFaces(body) {
    if (isDesk()) return renderDesk(body);
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
    if (st.failed) { const rb = el('button', 'btn', 'Tentar de novo os com erro'); rb.onclick = async () => { await apiPost('people/reanalyze', null, { failed: true }); toast('Os vídeos com erro voltam para a fila'); refresh(); }; btns.appendChild(rb); }
    const exb = el('button', 'btn', `Pastas excluídas${st.excluded.length ? ` (${st.excluded.length})` : ''}`); exb.onclick = () => excludedSheet('faces');
    btns.appendChild(exb);
    card.appendChild(btns);
    body.appendChild(card);

    // --- perguntas do cruzamento tags x rostos
    if ((qs0.same || []).length) body.appendChild(sameSection(qs0.same));
    if (qs0.questions.length) body.appendChild(questionsSection(qs0));
    else if (qs0.auto) body.appendChild(el('div', 'pp-note pp-learned', `${icon('check')} ${qs0.auto} rosto(s) aprendidos sozinhos a partir das tags que os vídeos já tinham.`));

    // --- sugestões por rosto
    const sug = sg.suggestions;
    const s1 = el('section', 'pp-sec');
    s1.appendChild(el('h2', '', `Sugestões${sug.length ? ` <small>${sug.length}</small>` : ''}`));
    if (!sug.length) s1.appendChild(el('div', 'pp-note', persons().length ? 'Nenhuma sugestão nova. Conforme o ajudante analisa mais vídeos, aparecem aqui os vídeos em que as pessoas que você nomeou foram reconhecidas.' : 'Dê nome a um grupo de rostos abaixo: depois disso, os vídeos em que essa pessoa aparece são sugeridos aqui.'));
    else {
      const all = el('button', 'btn primary pp-applyall', `Aplicar todas (${sug.length})`);
      all.onclick = async () => { const r = await apiPost('people/apply', null, { pairs: sug.map((x) => ({ path: x.path, tag: x.tag, face: x.face })) }); Tags.apply(r); toast(`${r.applied} tag(s) aplicada(s)`); refresh(); };
      s1.appendChild(all);
      const list = el('div', 'pp-sugs');
      for (const sgi of sug.slice(0, 200)) {
        const row = el('div', 'pp-sug');
        row.innerHTML = `<img data-crop="${sgi.face}" alt="" loading="lazy"><div class="pp-sug-t"><div class="pp-sug-n">${esc(stripExt(sgi.name))}</div><div class="pp-sug-m">${Tags.chip(sgi.tag)} <span>${pct(sgi.sim)} parecido</span>${sgi.conf === 'alta' ? '<span class="pd-conf alta">certeza alta</span>' : ''}${sgi.byName ? '<span class="pd-conf nome">nome no arquivo</span>' : ''}</div></div>`;
        const ok = el('button', 'icon-btn pp-ok', icon('check')); ok.title = 'Confirmar';
        ok.onclick = () => { row.remove(); apiPost('people/apply', null, { pairs: [{ path: sgi.path, tag: sgi.tag, face: sgi.face }] }).then((r) => Tags.apply(r), (e) => toast(e.message)); };
        const no = el('button', 'icon-btn', icon('close')); no.title = 'Não é esta pessoa';
        // "não é esta pessoa": vira exemplo negativo dela (o sistema aprende a não confundir de novo)
        no.onclick = () => { row.remove(); apiPost('people/reject', null, { tag: sgi.tag, faces: [sgi.face], path: sgi.path }).catch((e) => toast(e.message)); };
        row.append(ok, no);
        row.querySelector('.pp-sug-n').onclick = () => playFace(sgi.face);
        row.querySelector('img').onclick = () => zoom([sgi.face], 0);
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
      g.innerHTML = `<div class="pp-faces">${c.sample.slice(0, 4).map((id) => `<img data-crop="${id}" alt="" loading="lazy">`).join('')}</div><div class="pp-g-n">${c.videos} vídeo${c.videos > 1 ? 's' : ''}</div>`;
      g.onclick = () => nameSheet(c, g);
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
      api('people/person', { tag: t.name }).then((r) => { if (r.faces[0]) $('.pp-avatar', b).innerHTML = `<img data-crop="${r.faces[0]}" alt="">`; }).catch(() => {});
      b.onclick = () => personSheet(t);
      pl.appendChild(b);
    }
    s3.appendChild(pl);
    body.appendChild(s3);
  }

  // dar nome a um grupo de rostos
  function nameSheet(c, tile, onDone) {
    const gone = () => { if (tile) { tile.classList.add('pp-gone'); setTimeout(() => tile.remove(), 200); } if (onDone) onDone(); };
    Sheet.open((b) => {
      Sheet.header(b, 'Quem é?');
      const faces = el('div', 'pp-sheet-faces');
      const ids12 = c.faces.slice(0, 12);
      faces.innerHTML = ids12.map((id, i) => `<img data-crop="${id}" alt="" data-i="${i}" class="pp-zoomable" title="Ampliar">`).join('');
      faces.onclick = (ev) => { const im = ev.target.closest('img'); if (im) zoom(ids12, +im.dataset.i); };
      b.appendChild(faces);
      b.appendChild(el('div', 'sheet-note', `${c.count} rosto(s) em ${c.videos} vídeo(s). Ao salvar, a tag da pessoa é aplicada nesses vídeos e os rostos viram referência para reconhecer a pessoa nos outros vídeos.`));
      const f = el('form', 'login-form');
      f.innerHTML = '<input type="text" list="pp-persons" placeholder="Nome da pessoa" maxlength="40" required><datalist id="pp-persons"></datalist><button class="btn primary">Salvar</button><div class="login-err"></div>';
      $('datalist', f).innerHTML = persons().map((t) => `<option value="${esc(t.name)}">`).join('');
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = $('button', f); btn.disabled = true;
        try {
          const r = await apiPost('people/name', null, { faces: c.faces, name: $('input', f).value, apply: true });
          Tags.apply(r); Sheet.close(); gone(); toast(`“${r.tag}” salvo`); refresh();
        } catch (e) { btn.disabled = false; $('.login-err', f).textContent = e.message; }
      };
      b.appendChild(f);
      Sheet.row(b, { ico: 'close', label: 'Ignorar este grupo (não é alguém que quero marcar)', onClick: () => {
        Sheet.close(); gone();
        apiPost('people/ignore', null, { faces: c.faces }).then(refresh, (e) => { toast(e.message); refresh(); });
      } });
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
      // responde na hora: o cartão some e a tela se atualiza por trás
      const send = async (body, msg) => {
        card.classList.add('pp-gone');
        const others = q.options.flatMap((o) => o.all);
        try { const r = await apiPost('people/answer', null, { tag: q.tag, path: q.path, others, ...body }); if (r.tags) Tags.apply(r); if (msg) toast(msg); refresh(); }
        catch (e) { card.classList.remove('pp-gone'); toast(e.message); }
      };
      for (const o of q.options) {
        const b = el('button', 'pp-q-opt');
        b.innerHTML = `<div class="pp-faces">${o.faces.map((id) => `<img data-crop="${id}" alt="" loading="lazy">`).join('')}</div><span>${q.kind === 'isperson' ? `Sim, é ${esc(q.tag)}` : 'É esta pessoa'}</span>${o.seen ? `<small>aparece em ${o.seen} outro(s) vídeo(s) com a tag</small>` : ''}`;
        b.onclick = () => send({ faces: o.all }, `Aprendido: ${q.tag}`);
        const zb = el('span', 'pp-zoom', icon('search')); zb.title = 'Ampliar / conferir no vídeo';
        zb.onclick = (ev) => { ev.stopPropagation(); zoom(o.all.slice(0, 20), 0, q.kind === 'isperson' ? null : { label: 'É esta pessoa', run: () => send({ faces: o.all }, `Aprendido: ${q.tag}`) }); };
        b.appendChild(zb);
        opts.appendChild(b);
      }
      card.appendChild(opts);
      const acts = el('div', 'pp-actions');
      if (q.kind === 'isperson') {
        const no = el('button', 'btn', 'Não é uma pessoa'); no.onclick = () => send({ notPerson: true });
        acts.appendChild(no);
      } else {
        const none = el('button', 'btn', `${esc(q.tag)} não aparece`); none.onclick = () => send({ none: true });
        const open1 = el('button', 'btn', `${icon('play')}Ver o vídeo`); open1.onclick = () => playFace(q.options[0] && q.options[0].all[0], q);
        acts.append(none, open1);
      }
      card.appendChild(acts);
      sec.appendChild(card);
    }
    return sec;
  }

  // ================================================================ ampliar um rosto
  // Mostra o quadro do vídeo no momento em que o rosto foi encontrado (grande), o recorte e um botão para
  // abrir o vídeo naquele ponto. O vídeo abre por cima da tela Pessoas: ao fechar, volta para cá.
  const faceInfo = new Map();
  const infoOf = (id) => { if (!faceInfo.has(id)) faceInfo.set(id, api('people/face', { id }).catch(() => null)); return faceInfo.get(id); };
  async function playFace(id, fallback) {
    const f = id ? await infoOf(id) : null;
    const it = f || fallback; if (!it) return;
    P.open({ path: it.path, name: it.name, type: 'video' }, { from: f ? Math.max(0, f.t - 2) : null });
  }
  // quadro grande: o servidor pode responder "ainda gerando" (imagem 1×1); tenta de novo até ficar pronto
  function loadFrame(img, f, token) {
    let n = 0;
    const url = `/api/thumb?${qs({ path: f.path, t: f.t.toFixed(1), w: 1280, exact: 1 })}`;
    img.onload = () => {
      if (img.dataset.token !== token) return;
      if (img.naturalWidth <= 1) { if (++n < 40) setTimeout(() => { if (img.dataset.token === token) img.src = `${url}&r=${n}`; }, Math.min(1500, 250 * n)); return; }
      img.classList.add('ok');
    };
    img.onerror = () => { if (img.dataset.token === token) img.closest('.fz').classList.add('noframe'); };
    img.src = url;
  }
  let fz = null;
  function zoom(ids, start = 0, action = null) {
    if (!ids || !ids.length) return;
    let i = Math.max(0, Math.min(ids.length - 1, start));
    if (!fz) {
      fz = el('div', 'fz hidden');
      fz.innerHTML = `
        <div class="fz-top"><button class="icon-btn fz-x" aria-label="Fechar">${icon('close')}</button><div class="fz-t"><div class="fz-n"></div><div class="fz-s"></div></div><span class="fz-c"></span></div>
        <div class="fz-stage"><img class="fz-frame" alt=""><img class="fz-crop" alt=""><div class="spinner fz-spin"></div>
          <button class="icon-btn fz-prev" aria-label="Anterior">${icon('back')}</button><button class="icon-btn fz-next" aria-label="Próximo">${icon('right')}</button></div>
        <div class="fz-bar"></div>`;
      document.body.appendChild(fz);
      $('.fz-x', fz).onclick = () => closeLayer('facezoom');
      fz.addEventListener('click', (ev) => { if (ev.target === fz || ev.target.classList.contains('fz-stage')) closeLayer('facezoom'); });
      // deslizar para os lados troca de rosto
      let sx = null;
      fz.addEventListener('pointerdown', (ev) => { sx = ev.clientX; });
      fz.addEventListener('pointerup', (ev) => { if (sx == null) return; const d = ev.clientX - sx; sx = null; if (Math.abs(d) > 60) fz._go(d < 0 ? 1 : -1); });
      document.addEventListener('keydown', (ev) => {
        if (!fz || fz.classList.contains('hidden')) return;
        if (ev.key === 'ArrowRight') fz._go(1); else if (ev.key === 'ArrowLeft') fz._go(-1);
      });
    }
    const show = async () => {
      const id = ids[i]; const token = `${id}:${Date.now()}`;
      fz.classList.remove('noframe');
      const frame = $('.fz-frame', fz); const cropImg = $('.fz-crop', fz);
      frame.classList.remove('ok'); frame.removeAttribute('src'); frame.dataset.token = token;
      cropImg.src = crop(id);
      $('.fz-c', fz).textContent = ids.length > 1 ? `${i + 1} / ${ids.length}` : '';
      $('.fz-prev', fz).classList.toggle('hidden', i === 0);
      $('.fz-next', fz).classList.toggle('hidden', i >= ids.length - 1);
      $('.fz-n', fz).textContent = ''; $('.fz-s', fz).textContent = '';
      const bar = $('.fz-bar', fz); bar.innerHTML = '';
      const f = await infoOf(id);
      if (frame.dataset.token !== token) return;
      if (!f) { fz.classList.add('noframe'); return; }
      $('.fz-n', fz).textContent = stripExt(f.name);
      $('.fz-s', fz).textContent = `rosto encontrado em ${fmtTime(f.t)}`;
      loadFrame(frame, f, token);
      const pl = el('button', 'btn primary', `${icon('play')}Ver no vídeo neste momento`);
      // fecha a ampliação (e a janela de baixo, se houver) e abre o vídeo; ao sair do vídeo, a tela Pessoas continua aqui
      pl.onclick = () => { closeLayer('facezoom'); whenHistoryIdle(() => { Sheet.close(); whenHistoryIdle(() => playFace(id)); }); };
      bar.appendChild(pl);
      if (action) {
        const ab = el('button', 'btn', `${icon('check')}${esc(action.label)}`);
        ab.onclick = () => { closeLayer('facezoom'); action.run(); };
        bar.appendChild(ab);
      }
    };
    fz._go = (d) => { const j = i + d; if (j < 0 || j >= ids.length) return; i = j; show(); };
    $('.fz-prev', fz).onclick = (ev) => { ev.stopPropagation(); fz._go(-1); };
    $('.fz-next', fz).onclick = (ev) => { ev.stopPropagation(); fz._go(1); };
    if (fz.classList.contains('hidden')) { fz.classList.remove('hidden'); pushLayer('facezoom', () => fz.classList.add('hidden')); }
    show();
  }

  async function personSheet(t) {
    const r = await api('people/person', { tag: t.name });
    Sheet.open((b) => {
      Sheet.header(b, t.name);
      Sheet.row(b, { ico: 'tag', label: 'Ver vídeos desta pessoa', onClick: () => { Sheet.close(); close(); whenHistoryIdle(() => Tags.openView(t.name)); } });
      b.appendChild(el('div', 'sheet-note', 'Rostos usados para reconhecer esta pessoa (“auto” = aprendido pelas tags dos vídeos). Toque num rosto para ampliar; no ✕ para removê-lo se estiver errado — ele não será aprendido de novo.'));
      const faces = el('div', 'pp-sheet-faces');
      for (const id of r.faces) {
        const auto = (r.auto || []).includes(id);
        const bad = (r.bad || []).includes(id);
        const im = el('button', 'pp-ref' + (auto ? ' auto' : '') + (bad ? ' bad' : ''), `<img data-crop="${id}" alt=""><span>${icon('close')}</span>${bad ? '<em class="sus">suspeito</em>' : auto ? '<em>auto</em>' : ''}`);
        if (bad) im.title = 'Destoa dos outros rostos desta pessoa — provavelmente é outra pessoa. Já não é usado para reconhecer.';
        if (auto) im.title = 'Aprendido sozinho pelas tags dos vídeos';
        const i = r.faces.indexOf(id);
        im.onclick = (ev) => {
          if (!ev.target.closest('span')) { zoom(r.faces, i); return; } // tocar no rosto amplia; no ✕ remove
          im.remove(); apiPost('people/unlink', null, { tag: t.name, faces: [id] }).catch((e) => toast(e.message));
        };
        faces.appendChild(im);
      }
      if (!r.faces.length) faces.appendChild(el('div', 'sheet-note', 'Nenhum rosto ainda (pessoa criada pelo nome do arquivo).'));
      // limpeza quando a pessoa está sendo confundida com outras
      const nb = (r.bad || []).length; const na = (r.auto || []).length;
      const fix = async (only, msg) => { const x = await apiPost('people/reset-auto', null, { tag: t.name, only }); toast(`${x.removed} ${msg}`); Sheet.close(); refresh(); };
      if (nb) Sheet.row(b, { ico: 'delete', label: `Remover ${nb} rosto(s) suspeito(s)`, value: 'destoam dos outros', onClick: () => fix('bad', 'rosto(s) suspeito(s) removido(s)') });
      if (na) Sheet.row(b, { ico: 'replay', label: `Desfazer o que foi aprendido sozinho (${na})`, value: 'se está confundindo', onClick: () => fix('auto', 'rosto(s) aprendido(s) sozinho(s) removido(s)') });
      if (r.neg) b.appendChild(el('div', 'sheet-note', `${r.neg} rosto(s) marcados como “não é ${esc(t.name)}” ajudam a não confundir.`));
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
        <li>Extraia a pasta num lugar fixo e abra <b>instalar.bat</b> (instala o Python e os componentes, cria o atalho <b>Zima Video Ajudante</b> e abre o programa). Já tinha uma versão? Extraia por cima e rode o instalar.bat de novo.</li>
        <li>Na janela do ajudante, informe o endereço e o código abaixo.</li>
        <li>Na janela você escolhe quanto do PC ele pode usar — no modo <b>Automático</b> ele usa pouco enquanto você está no PC e o máximo quando o PC fica parado. Fechando a janela, ele continua na bandeja (perto do relógio).</li>`;
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
    compress: { title: 'Pastas fora da compressão', off: 'não será mais comprimida', on: 'volta a poder ser comprimida',
      row: ['Não comprimir os vídeos desta pasta', 'Voltar a permitir comprimir esta pasta', 'Sem compressão (pasta acima excluída)'],
      pick: 'Excluir esta pasta da compressão',
      note: 'O compressor nunca mexe nos vídeos destas pastas (e das subpastas), mesmo que você peça para comprimir uma pasta acima. O que estava na fila sai dela.' },
    names: { title: 'Pastas fora da busca por nome', off: 'não entra mais na busca pelo nome do arquivo', on: 'volta para a busca pelo nome do arquivo',
      row: ['Não procurar nomes de pessoas nesta pasta', 'Voltar a procurar nomes nesta pasta', 'Sem busca por nome (pasta acima excluída)'],
      pick: 'Excluir esta pasta da busca por nome',
      note: 'Os arquivos destas pastas (e das subpastas) não são considerados ao procurar nomes de pessoas no nome do arquivo.' },
  };
  const excl = { faces: null, names: null, compress: null };
  async function loadExcluded() {
    try { const r = await api('people/exclude'); excl.faces = r.excluded; excl.names = r.names || []; excl.compress = r.compress || []; } catch { excl.faces = []; excl.names = []; excl.compress = []; }
    return excl;
  }
  const isExcluded = (p, kind = 'faces') => (excl[kind] || []).some((x) => p === x || p.startsWith(x + '/'));
  async function setExcluded(p, on, kind = 'faces') {
    try {
      const r = await apiPost('people/exclude', null, { path: p, on, kind });
      excl.faces = r.excluded; excl.names = r.names || []; excl.compress = r.compress || [];
      toast(`“${basename(p) || 'Início'}” ${on ? KINDS[kind].off : KINDS[kind].on}${r.cancelled ? ` · ${r.cancelled} vídeo(s) saíram da fila` : ''}`);
      if (open) render();
    } catch (e) { toast(e.message); }
  }
  // linhas no menu ⋮ de uma pasta (modo administrador)
  function folderRow(b, e) {
    if (excl.faces === null) loadExcluded();
    for (const kind of ['faces', 'names', 'compress']) {
      const on = isExcluded(e.path, kind);
      const parentEx = on && !excl[kind].includes(e.path);
      const k = KINDS[kind];
      Sheet.row(b, { ico: kind === 'faces' ? 'person' : kind === 'compress' ? 'compress' : 'search', label: parentEx ? k.row[2] : on ? k.row[1] : k.row[0],
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


  // ================================================================ perguntas "é a mesma pessoa?"
  // (como o Google Fotos: um grupo sem nome quase parecido com alguém conhecido — você decide)
  function sameCard(q) {
    const card = el('div', 'pp-q pd-same');
    const p = Tags.list.find((t) => t.name === q.tag);
    card.innerHTML = `<div class="pp-q-h">Este grupo é ${Tags.chip(q.tag)}?</div>
      <div class="pd-same-row"><div class="pp-faces pd-mosaic">${q.sample.slice(0, 4).map((id) => `<img data-crop="${id}" alt="" loading="lazy">`).join('')}</div>
      <span class="pd-vs">?</span><div class="pd-same-p"><span class="pp-avatar pd-av" style="--c:${p ? p.color : '#888'}"></span><b>${esc(q.tag)}</b></div></div>
      <div class="pp-note">${q.videos} vídeo(s) · ${pct(q.sim)} parecido — na dúvida, não marquei sozinho</div>`;
    api('people/person', { tag: q.tag }).then((r) => { if (r.faces[0]) $('.pd-av', card).innerHTML = `<img data-crop="${r.faces[0]}" alt="">`; }).catch(() => {});
    $('.pd-mosaic', card).onclick = () => zoom(q.faces.slice(0, 30), 0);
    $('.pd-mosaic', card).title = 'Ampliar';
    const acts = el('div', 'pp-actions');
    const yes = el('button', 'btn primary', `${icon('check')}Sim, é ${esc(q.tag)}`);
    const no = el('button', 'btn', `${icon('close')}Não é`);
    yes.onclick = () => { card.classList.add('pp-gone'); apiPost('people/name', null, { faces: q.faces, name: q.tag, apply: true }).then((r) => { Tags.apply(r); toast(`Aprendido: ${q.tag}`); refresh(); }, (e) => { card.classList.remove('pp-gone'); toast(e.message); }); };
    no.onclick = () => { card.classList.add('pp-gone'); apiPost('people/reject', null, { tag: q.tag, faces: q.faces.slice(0, 30) }).then(refresh, (e) => { card.classList.remove('pp-gone'); toast(e.message); }); };
    acts.append(yes, no); card.appendChild(acts);
    return card;
  }
  function sameSection(list) {
    const sec = el('section', 'pp-sec');
    sec.appendChild(el('h2', '', `É a mesma pessoa? <small>${list.length}</small>`));
    const g = el('div', 'pd-same-grid');
    for (const q of list) g.appendChild(sameCard(q));
    sec.appendChild(g);
    return sec;
  }

  // ================================================================ desktop
  // Barra lateral com as pessoas + área principal (Revisar / Rostos sem nome / página da pessoa).
  // Grades com seleção múltipla, atalhos de teclado, confirmar/recusar em lote e arrastar grupos até a pessoa.
  const deskMQ = matchMedia('(min-width: 1000px) and (pointer: fine)');
  const isDesk = () => deskMQ.matches;
  deskMQ.addEventListener('change', () => { if (open && tab === 'faces') render(); });
  let deskView = 'review'; let deskData = null; let personQ = ''; let showSingles = false; let personTab = 'sugs';
  const deskSel = new Set(); let lastClicked = null; const expanded = new Set();

  async function renderDesk(body) {
    const qd = await api('people/questions').catch(() => ({ questions: [], same: [], learned: 0, auto: 0, total: 0 }));
    const [st, cl, sg, pr] = await Promise.all([api('people/status'), api('people/clusters'), api('people/suggestions'), api('people/persons')]);
    if (qd.learned) toast(`Aprendi ${qd.learned} rosto(s) a partir das tags dos vídeos`);
    await Tags.load();
    deskData = { qd, st, cl: cl.clusters, sg: sg.suggestions, persons: pr.persons };
    if (deskView.person && !pr.persons.some((x) => x.tag === deskView.person)) deskView = 'review';
    for (const k of [...deskSel]) if (!sg.suggestions.some((x) => sKey(x) === k) && !String(k).startsWith('c:') && !String(k).startsWith('r:')) deskSel.delete(k);
    body.innerHTML = '';
    const wrap = el('div', 'pd');
    const side = el('aside', 'pd-side'); const main = el('section', 'pd-main');
    wrap.append(side, main); body.appendChild(wrap);
    deskSide(side);
    await deskMain(main);
  }
  const sKey = (x) => `${x.path}|${x.tag}`;
  const setView = (v) => { deskView = v; deskSel.clear(); lastClicked = null; refresh(); };

  function deskSide(side) {
    const { st, qd, cl, sg, persons } = deskData;
    const w = st.workers.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    const online = w.find((x) => Date.now() - x.lastSeen < 3 * 60000);
    const pctDone = st.videos ? Math.round((st.analyzed / st.videos) * 100) : 0;
    const card = el('div', 'pd-status');
    card.innerHTML = `<div><b>${st.analyzed}</b> de ${st.videos} vídeos analisados</div>
      <div class="pp-progress"><div style="width:${pctDone}%"></div></div>
      <div class="pp-sub"><i class="pd-dot ${online ? 'on' : ''}"></i>${w.length ? (online ? `${esc(online.name)} trabalhando` : `Ajudante desligado · visto ${ago(w[0].lastSeen)}`) : 'Nenhum ajudante conectado'}</div>
      ${st.old ? `<div class="pp-sub">${st.old} vídeo(s) serão refeitos com a análise nova</div>` : ''}${st.failed ? `<div class="pp-sub">${st.failed} com erro</div>` : ''}`;
    const acts = el('div', 'pd-status-b');
    const a1 = el('button', 'pd-link', 'Ajudante (PC)'); a1.onclick = connectSheet;
    const a2 = el('button', 'pd-link', `Pastas excluídas${st.excluded.length ? ` (${st.excluded.length})` : ''}`); a2.onclick = () => excludedSheet('faces');
    acts.append(a1, a2);
    if (st.failed) { const a3 = el('button', 'pd-link', 'Tentar de novo os com erro'); a3.onclick = async () => { await apiPost('people/reanalyze', null, { failed: true }); toast('Os vídeos com erro voltam para a fila'); refresh(); }; acts.appendChild(a3); }
    card.appendChild(acts);
    side.appendChild(card);

    const nav = el('nav', 'pd-nav');
    const rv = (qd.same || []).length + qd.total + sg.length;
    const n1 = el('button', 'pd-nav-i' + (deskView === 'review' ? ' on' : ''), `${icon('check')}<span>Revisar</span>${rv ? `<b>${rv}</b>` : ''}`);
    n1.onclick = () => setView('review');
    const multi = cl.filter((c) => c.videos > 1).length;
    const n2 = el('button', 'pd-nav-i' + (deskView === 'unnamed' ? ' on' : ''), `${icon('person')}<span>Rostos sem nome</span>${cl.length ? `<b>${multi || cl.length}</b>` : ''}`);
    n2.onclick = () => setView('unnamed');
    nav.append(n1, n2);
    side.appendChild(nav);

    const ph = el('div', 'pd-ph', `<span>Pessoas <small>${persons.length}</small></span>`);
    side.appendChild(ph);
    const search = el('div', 'move-search pd-psearch', `${icon('search')}<input type="search" placeholder="Buscar pessoa…" autocomplete="off">`);
    const inp = $('input', search); inp.value = personQ;
    side.appendChild(search);
    const list = el('div', 'pd-plist');
    const drawList = () => {
      list.innerHTML = '';
      const k = Tags.key(personQ);
      for (const p of persons.filter((x) => !k || Tags.key(x.tag).includes(k))) {
        const b = el('button', 'pd-p' + (deskView.person === p.tag ? ' on' : ''));
        b.innerHTML = `<span class="pp-avatar pd-pav" style="--c:${p.color}">${p.face ? `<img data-crop="${p.face}" alt="" loading="lazy">` : ''}</span><span class="pd-pn">${esc(p.tag)}</span>`
          + `${p.sugg ? `<b class="pd-badge" title="sugestões para revisar">${p.sugg}</b>` : ''}<small>${p.count}</small>`;
        b.onclick = () => { personTab = p.sugg ? 'sugs' : 'refs'; setView({ person: p.tag }); };
        // soltar um grupo de rostos aqui = é esta pessoa
        b.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('text/zv-faces')) { ev.preventDefault(); b.classList.add('drop'); } });
        b.addEventListener('dragleave', () => b.classList.remove('drop'));
        b.addEventListener('drop', (ev) => {
          ev.preventDefault(); b.classList.remove('drop');
          let faces = []; try { faces = JSON.parse(ev.dataTransfer.getData('text/zv-faces')); } catch { return; }
          document.querySelectorAll('.pd-cl.dragging, .pd-cl.sel').forEach((t) => t.classList.add('pp-gone'));
          apiPost('people/name', null, { faces, name: p.tag, apply: true }).then((r) => { Tags.apply(r); toast(`Aprendido: ${p.tag}`); deskSel.clear(); refresh(); }, (e) => { toast(e.message); refresh(); });
        });
        list.appendChild(b);
      }
      if (!list.children.length) list.appendChild(el('div', 'pp-note', persons.length ? 'Ninguém com esse nome.' : 'Nenhuma pessoa ainda. Dê nome a um grupo em “Rostos sem nome”.'));
    };
    inp.addEventListener('input', () => { personQ = inp.value; drawList(); });
    drawList();
    side.appendChild(list);
  }

  async function deskMain(main) {
    const { qd, cl, sg } = deskData;
    if (deskView === 'review') {
      main.appendChild(el('div', 'pd-h', `<h1>Revisar</h1><div class="pd-keys">Atalhos: <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> mover · <kbd>Espaço</kbd> selecionar · <kbd>Y</kbd> confirmar · <kbd>N</kbd> não é · <kbd>Z</kbd> ampliar · <kbd>P</kbd> ver no vídeo · <kbd>Ctrl</kbd>+<kbd>A</kbd> tudo</div>`));
      if (!(qd.same || []).length && !qd.questions.length && !sg.length) {
        main.appendChild(el('div', 'empty', `${icon('check')}Nada para revisar agora.<br><small>Conforme o ajudante analisa vídeos, aparecem aqui as sugestões e as dúvidas.</small>`));
      }
      if ((qd.same || []).length) main.appendChild(sameSection(qd.same));
      if (qd.questions.length) main.appendChild(questionsSection(qd));
      if (sg.length) {
        const sec = el('section', 'pp-sec');
        sec.appendChild(el('h2', '', `Sugestões <small>${sg.length}</small>`));
        sec.appendChild(sugGrid(sg, true));
        main.appendChild(sec);
      }
    } else if (deskView === 'unnamed') {
      main.appendChild(el('div', 'pd-h', `<h1>Rostos sem nome</h1><div class="pd-keys">Clique para dar nome · <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+clique para selecionar vários (mesma pessoa) · arraste um grupo até uma pessoa na barra lateral</div>`));
      const singles = cl.filter((c) => c.videos === 1).length;
      const tools = el('div', 'pd-tools');
      if (singles) {
        const t = el('label', 'pd-check', `<input type="checkbox"${showSingles ? ' checked' : ''}> Mostrar quem aparece em 1 vídeo só (${singles})`);
        $('input', t).onchange = (e) => { showSingles = e.target.checked; refresh(); };
        tools.appendChild(t);
      }
      main.appendChild(tools);
      const list = cl.filter((c) => showSingles || c.videos > 1 || cl.every((x) => x.videos === 1));
      if (!list.length) main.appendChild(el('div', 'empty', `${icon('person')}${deskData.st.analyzed ? 'Todos os rostos encontrados já têm nome (ou foram ignorados).' : 'Os grupos aparecem aqui conforme o ajudante analisa os vídeos.'}`));
      main.appendChild(clusterGrid(list));
    } else if (deskView.person) {
      await personPage(main, deskView.person);
    }
    main.appendChild(bulkBar());
    updateBulk();
  }

  // ---------- grade de sugestões
  function sugGrid(list, byPerson) {
    const box = el('div', 'pd-sugs');
    const groups = new Map();
    for (const x of list) { const k = byPerson ? x.tag : ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    for (const [tag, items] of groups) {
      if (byPerson) {
        const p = deskData.persons.find((x) => x.tag === tag);
        const hi = items.filter((x) => x.conf === 'alta');
        const h = el('div', 'pd-gh');
        h.innerHTML = `<button class="pd-gh-p"><span class="pp-avatar pd-pav" style="--c:${p ? p.color : '#888'}">${p && p.face ? `<img data-crop="${p.face}" alt="">` : ''}</span><b>${esc(tag)}</b></button><small>${items.length} vídeo(s)</small>`;
        $('.pd-gh-p', h).onclick = () => { personTab = 'sugs'; setView({ person: tag }); };
        if (hi.length) { const b = el('button', 'btn', `${icon('check')}Confirmar as de certeza alta (${hi.length})`); b.onclick = () => confirmItems(hi); h.appendChild(b); }
        const all = el('button', 'btn', `Selecionar as ${items.length}`); all.onclick = () => { items.forEach((x) => deskSel.add(sKey(x))); syncSel(); };
        h.appendChild(all);
        box.appendChild(h);
      }
      const grid = el('div', 'pd-grid');
      // listas enormes: mostra os primeiros 120 (os mais parecidos) e o resto sob demanda
      const lim = expanded.has(tag) ? items.length : 120;
      for (const x of items.slice(0, lim)) grid.appendChild(sugTile(x));
      box.appendChild(grid);
      if (items.length > lim) {
        const more = el('button', 'btn pd-more', `Mostrar mais ${items.length - lim}`);
        more.onclick = () => { expanded.add(tag); more.remove(); for (const x of items.slice(lim)) grid.appendChild(sugTile(x)); };
        box.appendChild(more);
      }
    }
    return box;
  }
  function sugTile(x) {
    const t = el('div', 'pd-tile' + (deskSel.has(sKey(x)) ? ' sel' : ''));
    t.tabIndex = 0; t._item = x; t.dataset.key = sKey(x);
    t.innerHTML = `<div class="pd-img"><img data-crop="${x.face}" alt="" loading="lazy"><span class="pd-chk">${icon('check')}</span>
        <div class="pd-acts"><button data-a="ok" title="É ${esc(x.tag)} (Y)">${icon('check')}</button><button data-a="no" title="Não é (N)">${icon('close')}</button><button data-a="zoom" title="Ampliar (Z)">${icon('search')}</button><button data-a="play" title="Ver no vídeo (P)">${icon('play')}</button></div></div>
      <div class="pd-tn" title="${esc(x.name)}">${esc(stripExt(x.name))}</div>
      <div class="pd-tm">${deskView === 'review' ? `${esc(x.tag)} · ` : ''}${pct(x.sim)}${x.conf === 'alta' ? ' <span class="pd-conf alta">alta</span>' : ''}${x.byName ? ' <span class="pd-conf nome" title="o nome da pessoa está no nome do arquivo">nome</span>' : ''}</div>`;
    t.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-a]');
      if (a) { ev.stopPropagation(); return tileAction(a.dataset.a, [x], t); }
      clickSelect(t, ev);
    });
    t.addEventListener('dblclick', () => zoom(x.faces && x.faces.length ? x.faces : [x.face], 0, { label: `É ${x.tag}`, run: () => confirmItems([x]) }));
    t.addEventListener('focus', () => { lastFocus = t; });
    return t;
  }
  let lastFocus = null;
  function tileAction(a, items, t) {
    if (a === 'ok') confirmItems(items);
    else if (a === 'no') rejectItems(items);
    else if (a === 'zoom') { const x = items[0]; zoom(x.faces && x.faces.length ? x.faces : [x.face], 0, { label: `É ${x.tag}`, run: () => confirmItems([x]) }); }
    else if (a === 'play') playFace(items[0].face);
  }
  function tilesOf(keys) { return [...document.querySelectorAll('.pd-main .pd-tile')].filter((t) => keys.includes(t.dataset.key)); }
  function vanish(keys) { tilesOf(keys).forEach((t) => { t.classList.add('pp-gone'); setTimeout(() => t.remove(), 180); }); keys.forEach((k) => deskSel.delete(k)); updateBulk(); }
  function confirmItems(items) {
    if (!items.length) return;
    vanish(items.map(sKey));
    apiPost('people/apply', null, { pairs: items.map((x) => ({ path: x.path, tag: x.tag, face: x.face })) })
      .then((r) => { Tags.apply(r); toast(`${r.applied} vídeo(s) marcados`); refresh(); }, (e) => { toast(e.message); refresh(); });
  }
  function rejectItems(items) {
    if (!items.length) return;
    vanish(items.map(sKey));
    Promise.all(items.map((x) => apiPost('people/reject', null, { tag: x.tag, faces: x.faces && x.faces.length ? x.faces.slice(0, 3) : [x.face], path: x.path })))
      .then(() => { toast(`${items.length} recusada(s) — vou evitar esse engano`); refresh(); }, (e) => { toast(e.message); refresh(); });
  }

  // ---------- seleção (clique, Ctrl/Cmd, Shift) e teclado
  function clickSelect(t, ev) {
    const tiles = [...t.closest('.pd-main').querySelectorAll('.pd-tile, .pd-cl')];
    const k = t.dataset.key;
    if (ev.shiftKey && lastClicked) {
      const a = tiles.indexOf(lastClicked); const b = tiles.indexOf(t);
      if (a >= 0 && b >= 0) for (const x of tiles.slice(Math.min(a, b), Math.max(a, b) + 1)) deskSel.add(x.dataset.key);
    } else if (ev.ctrlKey || ev.metaKey || deskSel.size || t.classList.contains('pd-tile')) {
      if (deskSel.has(k)) deskSel.delete(k); else deskSel.add(k);
    }
    lastClicked = t; t.focus({ preventScroll: true });
    syncSel();
  }
  function syncSel() {
    document.querySelectorAll('.pd-main .pd-tile, .pd-main .pd-cl').forEach((x) => x.classList.toggle('sel', deskSel.has(x.dataset.key)));
    updateBulk();
  }
  function bulkBar() {
    const bar = el('div', 'pd-bulk hidden');
    bar.innerHTML = '<span class="pd-bulk-n"></span><div class="pd-bulk-b"></div>';
    return bar;
  }
  function updateBulk() {
    const bar = document.querySelector('.pd-main .pd-bulk'); if (!bar) return;
    const keys = [...deskSel];
    bar.classList.toggle('hidden', !keys.length);
    if (!keys.length) return;
    const b = $('.pd-bulk-b', bar); b.innerHTML = '';
    $('.pd-bulk-n', bar).textContent = `${keys.length} selecionado(s)`;
    const clusters = keys.filter((k) => k.startsWith('c:'));
    const refsSel = keys.filter((k) => k.startsWith('r:'));
    if (clusters.length) {
      const nm = el('button', 'btn primary', `${icon('edit')}Dar nome (mesma pessoa)`); nm.onclick = () => nameClusters(clusters.map((k) => deskData.cl.find((c) => `c:${c.id}` === k)).filter(Boolean));
      const ig = el('button', 'btn', 'Ignorar'); ig.onclick = () => {
        const cs = clusters.map((k) => deskData.cl.find((c) => `c:${c.id}` === k)).filter(Boolean);
        vanishCl(clusters); apiPost('people/ignore', null, { faces: cs.flatMap((c) => c.faces) }).then(refresh, (e) => { toast(e.message); refresh(); });
      };
      b.append(nm, ig);
    } else if (refsSel.length) {
      const rm = el('button', 'btn', `${icon('close')}Não é ${esc(deskView.person)} — remover`); rm.onclick = () => {
        const ids = refsSel.map((k) => k.slice(2));
        document.querySelectorAll('.pd-main .pd-ref').forEach((t) => { if (deskSel.has(t.dataset.key)) t.remove(); });
        deskSel.clear(); updateBulk();
        apiPost('people/unlink', null, { tag: deskView.person, faces: ids }).then(refresh, (e) => toast(e.message));
      };
      b.append(rm);
    } else {
      const items = keys.map((k) => deskData.sg.find((x) => sKey(x) === k)).filter(Boolean);
      const ok = el('button', 'btn primary', `${icon('check')}Confirmar (Y)`); ok.onclick = () => confirmItems(items);
      const no = el('button', 'btn', `${icon('close')}Não é (N)`); no.onclick = () => rejectItems(items);
      b.append(ok, no);
    }
    const clr = el('button', 'pd-link', 'Limpar seleção (Esc)'); clr.onclick = () => { deskSel.clear(); syncSel(); };
    b.appendChild(clr);
  }
  function moveFocus(dir) {
    const tiles = [...document.querySelectorAll('.pd-main .pd-tile, .pd-main .pd-cl, .pd-main .pd-ref')];
    if (!tiles.length) return;
    const cur = tiles.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { tiles[0].focus(); return; }
    const i = tiles.indexOf(cur);
    let next = null;
    if (dir === 'left') next = tiles[i - 1];
    else if (dir === 'right') next = tiles[i + 1];
    else {
      const r = cur.getBoundingClientRect(); const cx = r.left + r.width / 2;
      const cand = tiles.filter((t) => { const q = t.getBoundingClientRect(); return dir === 'down' ? q.top > r.bottom - 4 : q.bottom < r.top + 4; });
      let bestD = 1e9;
      for (const t of cand) {
        const q = t.getBoundingClientRect();
        const dy = dir === 'down' ? q.top - r.bottom : r.top - q.bottom;
        const d = dy * 4 + Math.abs(q.left + q.width / 2 - cx);
        if (d < bestD) { bestD = d; next = t; }
      }
    }
    if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  }
  document.addEventListener('keydown', (ev) => {
    if (!open || tab !== 'faces' || !isDesk()) return;
    if (!$('#sheet').classList.contains('hidden') || (fz && !fz.classList.contains('hidden'))) return;
    if (ev.target.closest && ev.target.closest('input, textarea, select')) return;
    const k = ev.key;
    const f = document.activeElement && document.activeElement.closest && document.activeElement.closest('.pd-tile, .pd-cl, .pd-ref');
    const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (arrows[k]) { ev.preventDefault(); moveFocus(arrows[k]); return; }
    if (k === 'Escape' && deskSel.size) { ev.preventDefault(); ev.stopPropagation(); deskSel.clear(); syncSel(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'a') {
      ev.preventDefault();
      document.querySelectorAll('.pd-main .pd-tile, .pd-main .pd-cl, .pd-main .pd-ref').forEach((t) => deskSel.add(t.dataset.key));
      syncSel(); return;
    }
    if (k === ' ' && f) { ev.preventDefault(); const key = f.dataset.key; if (deskSel.has(key)) deskSel.delete(key); else deskSel.add(key); lastClicked = f; syncSel(); return; }
    const items = deskSel.size ? [...deskSel].map((x) => deskData.sg.find((s0) => sKey(s0) === x)).filter(Boolean) : (f && f._item ? [f._item] : []);
    const lower = k.toLowerCase();
    if ((lower === 'y' || k === 'Enter') && items.length) { ev.preventDefault(); const nx = neighbor(f); confirmItems(items); if (nx) setTimeout(() => nx.focus(), 200); }
    else if ((lower === 'n' || k === 'Delete') && items.length) { ev.preventDefault(); const nx = neighbor(f); rejectItems(items); if (nx) setTimeout(() => nx.focus(), 200); }
    else if (lower === 'z' && f && f._item) { ev.preventDefault(); tileAction('zoom', [f._item]); }
    else if (lower === 'p' && f && f._item) { ev.preventDefault(); tileAction('play', [f._item]); }
    else if (k === 'Enter' && f && f._cluster) { ev.preventDefault(); nameSheet(f._cluster, f); }
  }, true);
  const neighbor = (f) => { if (!f) return null; const tiles = [...document.querySelectorAll('.pd-main .pd-tile')]; const i = tiles.indexOf(f); return tiles[i + 1] || tiles[i - 1] || null; };

  // ---------- grade de grupos sem nome
  function clusterGrid(list) {
    const grid = el('div', 'pd-cgrid');
    for (const c of list) {
      const t = el('div', 'pd-cl' + (deskSel.has(`c:${c.id}`) ? ' sel' : ''));
      t.tabIndex = 0; t.dataset.key = `c:${c.id}`; t._cluster = c; t.draggable = true;
      t.innerHTML = `<div class="pp-faces">${c.sample.slice(0, 4).map((id) => `<img data-crop="${id}" alt="" loading="lazy" draggable="false">`).join('')}</div>
        <span class="pd-chk">${icon('check')}</span><button class="pd-zoom" title="Ampliar">${icon('search')}</button>
        <div class="pd-tn">${c.videos} vídeo${c.videos > 1 ? 's' : ''}</div><div class="pd-tm">${c.count} rosto(s)${c.q != null && c.q < 0.45 ? ' · <span title="rostos de baixa qualidade (borrados, pequenos ou de lado)">qualidade baixa</span>' : ''}</div>`;
      $('.pd-zoom', t).onclick = (ev) => { ev.stopPropagation(); zoom(c.faces.slice(0, 40), 0); };
      t.addEventListener('click', (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || deskSel.size) return clickSelect(t, ev);
        nameSheet(c, t);
      });
      t.addEventListener('dragstart', (ev) => {
        const sel = deskSel.has(t.dataset.key) ? [...deskSel].map((k) => deskData.cl.find((x) => `c:${x.id}` === k)).filter(Boolean) : [c];
        ev.dataTransfer.setData('text/zv-faces', JSON.stringify(sel.flatMap((x) => x.faces)));
        ev.dataTransfer.effectAllowed = 'copy';
        t.classList.add('dragging'); document.body.classList.add('pd-dragging');
      });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); document.body.classList.remove('pd-dragging'); });
      grid.appendChild(t);
    }
    return grid;
  }
  function vanishCl(keys) { document.querySelectorAll('.pd-main .pd-cl').forEach((t) => { if (keys.includes(t.dataset.key)) { t.classList.add('pp-gone'); setTimeout(() => t.remove(), 180); } }); keys.forEach((k) => deskSel.delete(k)); updateBulk(); }
  function nameClusters(cs) {
    if (!cs.length) return;
    nameSheet({ faces: cs.flatMap((c) => c.faces), count: cs.reduce((a, c) => a + c.count, 0), videos: cs.reduce((a, c) => a + c.videos, 0) }, null, () => vanishCl(cs.map((c) => `c:${c.id}`)));
  }

  // ---------- página da pessoa
  async function personPage(main, tag) {
    const p = deskData.persons.find((x) => x.tag === tag) || { tag, count: 0 };
    const t = Tags.list.find((x) => x.name === tag) || { name: tag, color: '#888', aliases: [] };
    const r = await api('people/person', { tag });
    const head = el('div', 'pd-person-h');
    head.innerHTML = `<span class="pp-avatar pd-big" style="--c:${t.color}">${p.face ? `<img data-crop="${p.face}" alt="">` : ''}</span>
      <div class="pd-ph-t"><h1>${esc(tag)}</h1><div class="pp-sub">${p.count} vídeo(s) com a tag · ${r.faces.length} rosto(s) de referência${r.neg ? ` · ${r.neg} “não é”` : ''}${(t.aliases || []).length ? ` · também: ${esc(t.aliases.join(', '))}` : ''}${p.thr && p.thr > 0.43 ? ` · exigência aumentada (pessoa parecida com outras)` : ''}</div></div>`;
    const acts = el('div', 'pd-ph-a');
    const b1 = el('button', 'btn', `${icon('tag')}Ver vídeos`); b1.onclick = () => { close(); whenHistoryIdle(() => Tags.openView(tag)); };
    const b2 = el('button', 'btn', `${icon('edit')}Nome, cor e juntar`); b2.onclick = () => Tags.manage(t, null);
    const b3 = el('button', 'btn', 'Apelidos'); b3.onclick = () => aliasSheet(t);
    acts.append(b1, b2, b3);
    const nb = (r.bad || []).length; const na = (r.auto || []).length;
    const fix = async (only, msg) => { const x = await apiPost('people/reset-auto', null, { tag, only }); toast(`${x.removed} ${msg}`); refresh(); };
    if (nb) { const b = el('button', 'btn', `Remover ${nb} suspeito(s)`); b.onclick = () => fix('bad', 'rosto(s) suspeito(s) removido(s)'); acts.appendChild(b); }
    if (na) { const b = el('button', 'btn', `Desfazer aprendido sozinho (${na})`); b.onclick = () => fix('auto', 'rosto(s) removido(s)'); acts.appendChild(b); }
    head.appendChild(acts);
    main.appendChild(head);

    const sugs = deskData.sg.filter((x) => x.tag === tag);
    const tabs = el('div', 'chips pd-tabs');
    for (const [k, label] of [['sugs', `Sugestões (${sugs.length})`], ['refs', `Rostos de referência (${r.faces.length})`], ['vids', `Vídeos (${p.count})`]]) {
      const c = el('button', 'chip' + (personTab === k ? ' active' : ''), label);
      c.onclick = () => { personTab = k; deskSel.clear(); refresh(); };
      tabs.appendChild(c);
    }
    main.appendChild(tabs);
    if (personTab === 'sugs') {
      if (!sugs.length) main.appendChild(el('div', 'pp-note', 'Nenhuma sugestão nova para esta pessoa.'));
      else {
        const hi = sugs.filter((x) => x.conf === 'alta');
        const tl = el('div', 'pd-tools');
        if (hi.length) { const b = el('button', 'btn primary', `${icon('check')}Confirmar as de certeza alta (${hi.length})`); b.onclick = () => confirmItems(hi); tl.appendChild(b); }
        const a = el('button', 'btn', `Selecionar todas (${sugs.length})`); a.onclick = () => { sugs.forEach((x) => deskSel.add(sKey(x))); syncSel(); };
        tl.appendChild(a); main.appendChild(tl);
        main.appendChild(sugGrid(sugs, false));
      }
    } else if (personTab === 'refs') {
      main.appendChild(el('div', 'pp-note', 'Rostos usados para reconhecer esta pessoa. Selecione os que estão errados e remova — eles passam a ensinar quem ela NÃO é. Os “suspeitos” destoam dos outros e já não são usados.'));
      const g = el('div', 'pd-grid');
      r.faces.forEach((id, i) => {
        const bad = (r.bad || []).includes(id); const auto = (r.auto || []).includes(id);
        const tile = el('div', 'pd-tile pd-ref' + (bad ? ' bad' : '') + (deskSel.has(`r:${id}`) ? ' sel' : ''));
        tile.tabIndex = 0; tile.dataset.key = `r:${id}`;
        tile.innerHTML = `<div class="pd-img"><img data-crop="${id}" alt="" loading="lazy"><span class="pd-chk">${icon('check')}</span>
          <div class="pd-acts"><button data-a="zoom" title="Ampliar">${icon('search')}</button><button data-a="play" title="Ver no vídeo">${icon('play')}</button></div></div>
          <div class="pd-tm">${bad ? '<span class="pd-conf sus">suspeito</span>' : auto ? '<span class="pd-conf">auto</span>' : '<span class="pd-conf ok">confirmado</span>'}</div>`;
        tile.addEventListener('click', (ev) => {
          const a = ev.target.closest('[data-a]');
          if (a) { ev.stopPropagation(); if (a.dataset.a === 'zoom') zoom(r.faces, i); else playFace(id); return; }
          clickSelect(tile, ev);
        });
        tile.addEventListener('dblclick', () => zoom(r.faces, i));
        g.appendChild(tile);
      });
      main.appendChild(g);
    } else {
      const v = await api('tags', { tag }).catch(() => ({ items: [] }));
      const g = el('div', 'pd-vgrid');
      for (const it of v.items) {
        const c = el('button', 'pd-vid');
        c.innerHTML = `<div class="pd-vthumb"><img alt="" loading="lazy"></div><div class="pd-tn">${esc(stripExt(it.name))}</div><div class="pd-tm">${esc(dirname(it.path))}</div>`;
        if (it.type === 'video' || it.type === 'image') loadThumb($('img', c), it.path, it.mtime, 320); else $('img', c).remove();
        c.onclick = () => P.open(it, { siblings: v.items.filter((x) => x.type === it.type) });
        g.appendChild(c);
      }
      if (!v.items.length) g.appendChild(el('div', 'pp-note', 'Nenhum vídeo com esta tag ainda.'));
      main.appendChild(g);
    }
  }

  return { show, close, folderRow, loadExcluded, excludedSheet, isExcluded: (p, kind) => isExcluded(p, kind), get open() { return open; } };
})();
