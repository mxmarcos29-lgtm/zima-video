'use strict';
/* Zima Video — Compressor: deixa vídeos menores sem bagunçar a organização (mesmo nome, pasta, data,
   tags, rostos e visualizações; o original vai para a Lixeira). Trabalho feito pelo ajudante no PC ou pelo NAS. */

const Compress = (() => {
  const PRESETS = [
    ['h264', 'Compatível (H.264)', 'Toca em qualquer aparelho. Economia menor.'],
    ['h265', 'Economia (H.265)', 'Bem menor. Toca na maioria dos celulares, PCs e TVs atuais.'],
    ['av1', 'Máxima economia (AV1)', 'O menor de todos. Aparelhos antigos (celulares/TVs de alguns anos atrás) podem não tocar bem.'],
  ];
  const QUAL = [['alta', 'Visualmente igual', 'VMAF 95 — não dá para ver diferença (recomendado)'], ['equilibrada', 'Equilibrada', 'VMAF 93 — diferença só olhando de perto'],
    ['economica', 'Econômica', 'VMAF 90 — menor ainda; boa para celular']];
  const RES = [[0, 'Manter'], [1080, 'Até 1080p'], [720, 'Até 720p']];
  const WHERE = [['auto', 'Automático', 'No PC (ajudante) quando ele está ligado; senão no NAS'], ['pc', 'Só no PC', 'Espera o ajudante do PC'], ['nas', 'No NAS', 'Mais lento; não precisa do PC']];
  const opts = Object.assign({ preset: 'h265', quality: 'alta', maxh: 0, where: 'auto', trash: true, measure: false }, store.get('compressOpts', {}));
  const saveOpts = () => store.set('compressOpts', opts);

  // ---------- escolher e confirmar
  function open(paths) {
    Admin.need(() => {
      if (!paths || !paths.length) paths = [B.path].filter(Boolean);
      if (!paths.length) { toast('Escolha uma pasta ou vídeos'); return; }
      let est = null; let seq = 0;
      Sheet.open((b) => {
        Sheet.header(b, 'Comprimir vídeos');
        b.appendChild(el('div', 'sheet-note', 'A versão menor fica no mesmo lugar, com o mesmo nome e a mesma data — tags, rostos, visualizações e favoritos continuam valendo. O original vai para a Lixeira (dá para restaurar).'));
        const box = el('div', 'cz');
        const group = (title, items, key, render) => {
          const g = el('div', 'cz-g'); g.appendChild(el('div', 'cz-t', title));
          const row = el('div', 'cz-opts');
          for (const it of items) {
            const btn = el('button', 'cz-o' + (opts[key] === it[0] ? ' on' : ''), render(it));
            btn.onclick = () => { opts[key] = it[0]; saveOpts(); row.querySelectorAll('.cz-o').forEach((x) => x.classList.toggle('on', x === btn)); if (key !== 'where') estimate(); };
            row.appendChild(btn);
          }
          g.appendChild(row); return g;
        };
        box.appendChild(group('Formato', PRESETS, 'preset', (p) => `<b>${p[1]}</b><small>${p[2]}</small>`));
        box.appendChild(group('Qualidade', QUAL, 'quality', (p) => `<b>${p[1]}</b><small>${p[2]}</small>`));
        const ms = el('label', 'cz-check', `<input type="checkbox"${opts.measure ? ' checked' : ''}> <span><b>Medir a qualidade antes</b> (só no PC) — testa trechos de cada vídeo com VMAF e escolhe o ajuste mais econômico que mantém o nível, pulando o que não compensa. Arquivos bem menores, mas <b>bem mais lento</b>.</span>`);
        $('input', ms).onchange = (e) => { opts.measure = e.target.checked; saveOpts(); };
        box.appendChild(ms);
        box.appendChild(group('Resolução máxima', RES, 'maxh', (p) => `<b>${p[1]}</b>`));
        box.appendChild(group('Onde comprimir', WHERE, 'where', (p) => `<b>${p[1]}</b><small>${p[2]}</small>`));
        const tr = el('label', 'cz-check', `<input type="checkbox"${opts.trash ? ' checked' : ''}> Guardar o original na Lixeira (recomendado — o espaço é liberado ao esvaziar a lixeira)`);
        $('input', tr).onchange = (e) => { opts.trash = e.target.checked; saveOpts(); };
        box.appendChild(tr);
        const out = el('div', 'cz-est', '<div class="loading"><div class="spinner"></div></div>');
        box.appendChild(out);
        const go = el('button', 'btn primary cz-go', 'Comprimir'); go.disabled = true;
        go.onclick = async () => {
          go.disabled = true;
          try {
            const r = await apiPost('compress', { action: 'add' }, { paths, ...opts });
            Sheet.close(); toast(`${r.added} vídeo(s) na fila de compressão`);
            whenHistoryIdle(() => status());
          } catch (e) { toast(e.message); go.disabled = false; }
        };
        box.appendChild(go);
        b.appendChild(box);
        async function estimate() {
          const my = ++seq; out.innerHTML = '<div class="loading"><div class="spinner"></div></div>'; go.disabled = true;
          try {
            est = await apiPost('compress', { action: 'estimate' }, { paths, preset: opts.preset, maxh: opts.maxh, quality: opts.quality });
            if (my !== seq) return;
            const save = est.size - est.est;
            out.innerHTML = est.todo
              ? `<div class="cz-big">${est.todo} vídeo(s): ${fmtSize(est.size)} → ~${fmtSize(est.est)}</div>
                 <div class="cz-save">economia estimada ~${fmtSize(save)} (${Math.round(save * 100 / Math.max(1, est.size))}%)</div>
                 ${est.skipped ? `<div class="pp-note">${est.skipped} já estão compactos (ou em formato mais eficiente) e serão pulados.</div>` : ''}
                 ${est.excluded ? `<div class="pp-note">${est.excluded} vídeo(s) em pastas excluídas da compressão ficam de fora.</div>` : ''}
                 <div class="pp-note">A estimativa é aproximada: depende do conteúdo. Se um vídeo não ficar menor, o original é mantido.</div>`
              : `<div class="pp-note">${est.count ? 'Todos os vídeos escolhidos já estão compactos — nada a comprimir com este formato.' : est.excluded ? `Os ${est.excluded} vídeo(s) escolhidos estão em pastas excluídas da compressão.` : 'Nenhum vídeo encontrado.'}</div>`;
            const list = el('div', 'cz-list');
            for (const x of est.items.slice(0, 60)) {
              list.appendChild(el('div', 'cz-li' + (x.skip ? ' skip' : ''), `<span>${esc(stripExt(x.name))}</span><small>${x.skip ? esc(x.skip) : `${fmtSize(x.size)} → ~${fmtSize(x.est)}`}${x.codec ? ` · ${esc(x.codec)} ${x.height || ''}p` : ''}</small>`));
            }
            if (est.items.length) out.appendChild(list);
            go.textContent = est.todo ? `Comprimir ${est.todo} vídeo(s)` : 'Comprimir';
            go.disabled = !est.todo;
          } catch (e) { if (my === seq) out.innerHTML = `<div class="pp-note">${esc(e.message)}</div>`; }
        }
        estimate();
      });
    });
  }

  // ---------- acompanhar a fila
  let timer = null;
  function status() {
    Admin.need(() => {
      let body = null;
      const draw = async () => {
        let s; try { s = await api('compress'); } catch (e) { return; }
        if (!body || !body.isConnected) { clearInterval(timer); timer = null; return; }
        body.innerHTML = '';
        const head = el('div', 'cz-head');
        head.innerHTML = `<div><b>${fmtSize(s.saved)}</b> economizados</div><div class="pp-sub">${s.working ? `${s.working} comprimindo` : 'nada comprimindo agora'}${s.queued ? ` · ${s.queued} na fila` : ''} · ${s.pc ? 'ajudante do PC ligado' : 'ajudante do PC desligado'}${s.nas ? ' · NAS comprimindo' : ''}</div>`;
        body.appendChild(head);
        if (s.queued && !s.pc && s.items.some((i) => i.status === 'queued' && i.where === 'pc')) body.appendChild(el('div', 'pp-note', 'Há vídeos esperando o ajudante do PC. Abra o Zima Video Ajudante no PC (com o nível Médio ou Máximo) para começar.'));
        if (s.items.some((i) => i.status === 'queued' && i.preset === 'av1' && i.where !== 'pc') && !s.nasAv1 && !s.pc) body.appendChild(el('div', 'pp-note', 'O NAS não tem codificador de AV1: os vídeos em AV1 esperam o ajudante do PC.'));
        const acts = el('div', 'pp-actions');
        if (s.queued || s.working) { const c = el('button', 'btn', 'Cancelar tudo'); c.onclick = async () => { await apiPost('compress', { action: 'cancel' }, { all: true }); draw(); }; acts.appendChild(c); }
        const failed = s.items.filter((i) => i.status === 'failed' || i.status === 'cancelled');
        if (failed.length) { const r = el('button', 'btn', `Tentar de novo (${failed.length})`); r.onclick = async () => { await apiPost('compress', { action: 'retry' }, { ids: failed.map((i) => i.id) }); draw(); }; acts.appendChild(r); }
        if (s.items.some((i) => !['queued', 'working'].includes(i.status))) { const c = el('button', 'btn', 'Limpar concluídos'); c.onclick = async () => { await apiPost('compress', { action: 'clear' }, {}); draw(); }; acts.appendChild(c); }
        const t = el('button', 'btn', 'Abrir a Lixeira'); t.onclick = () => Admin.trash(); acts.appendChild(t);
        body.appendChild(acts);
        const list = el('div', 'cz-q');
        const label = { queued: 'na fila', working: 'comprimindo', done: 'pronto', skipped: 'mantido', failed: 'erro', cancelled: 'cancelado' };
        for (const i of s.items) {
          const row = el('div', `cz-qi ${i.status}`);
          const fmt = (PRESETS.find((p) => p[0] === i.preset) || [, i.preset])[1] + (i.quality ? ` · ${(QUAL.find((x) => x[0] === i.quality) || [, ''])[1]}` : '');
          let info = '';
          if (i.status === 'working') info = `${i.stage === 'medindo qualidade' ? 'medindo a qualidade · ' : ''}${i.pct || 0}%${i.speed ? ` · ${esc(i.speed)}` : ''} · ${esc(i.by || '')}`;
          else if (i.status === 'done') info = `${fmtSize(i.origSize)} → ${fmtSize(i.newSize)} (−${Math.round((1 - i.newSize / i.origSize) * 100)}%)${i.vmaf ? ` · VMAF ${i.vmaf}` : ''}${i.enc ? ` · ${esc(i.enc)}` : ''}`;
          else if (i.status === 'skipped') info = esc(i.note || 'não ficou menor');
          else if (i.status === 'failed') info = esc(i.error || '');
          else if (i.status === 'cancelled' && i.note) info = esc(i.note);
          else info = `${fmtSize(i.origSize)} → ~${fmtSize(i.est)} · ${i.where === 'pc' ? 'no PC' : i.where === 'nas' ? 'no NAS' : 'PC ou NAS'}`;
          row.innerHTML = `<div class="cz-qn"><span>${esc(stripExt(i.name))}</span><b>${label[i.status] || i.status}</b></div><div class="cz-qm">${esc(fmt)} · ${info}</div>${i.status === 'working' ? `<div class="pp-progress"><div style="width:${i.pct || 0}%"></div></div>` : ''}`;
          if (['queued', 'working'].includes(i.status)) {
            const x = el('button', 'icon-btn cz-x', icon('close')); x.title = 'Cancelar';
            x.onclick = async () => { await apiPost('compress', { action: 'cancel' }, { ids: [i.id] }); draw(); };
            row.appendChild(x);
          }
          list.appendChild(row);
        }
        if (!s.items.length) list.appendChild(el('div', 'pp-note', 'Nenhum vídeo na fila. Use “Comprimir…” no menu ⋮ de uma pasta, de um vídeo, ou na barra de seleção.'));
        body.appendChild(list);
      };
      Sheet.open((b) => {
        Sheet.header(b, 'Compressor');
        Sheet.row(b, { ico: 'add', label: 'Comprimir os vídeos desta pasta…', onClick: () => open([B.path]) });
        Sheet.row(b, { ico: 'folder', label: 'Pastas excluídas da compressão…', chevron: true, onClick: () => { clearInterval(timer); timer = null; People.excludedSheet('compress'); } });
        body = el('div', 'cz-status'); b.appendChild(body);
        body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        draw();
        clearInterval(timer); timer = setInterval(draw, 3000);
      });
    });
  }
  return { open, status };
})();
