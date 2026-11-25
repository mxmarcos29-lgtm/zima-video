'use strict';
/*
 * Zima Video — explorador de arquivos + player de vídeo para ZimaOS.
 * Servidor HTTP sem dependências externas (apenas Node.js + ffmpeg/ffprobe).
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- config
const ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');
const PORT = parseInt(process.env.PORT || '8080', 10);
const CACHE = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const HWACCEL = (process.env.HWACCEL || 'none').toLowerCase(); // none | vaapi
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const X264_PRESET = process.env.X264_PRESET || 'veryfast';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const SHOW_HIDDEN = process.env.SHOW_HIDDEN === '1';
const THUMBNAILS = process.env.THUMBNAILS !== '0';
const PREVIEWS = process.env.PREVIEWS !== '0';
// pré-geração em segundo plano: all = miniaturas + prévias + storyboards | thumbs = só miniaturas | off
const PREGEN = (process.env.PREGEN || 'all').toLowerCase();
const NICE = ['/usr/bin/nice', '/bin/nice'].find((f) => { try { fs.accessSync(f); return true; } catch { return false; } });
const INDEX_TTL = parseInt(process.env.SEARCH_INDEX_TTL || '600', 10) * 1000;
const SEG = 4; // duração dos segmentos HLS (s): menor = conversão começa a tocar mais cedo
const PUBLIC = path.join(__dirname, 'public');

const EXT = {
  video: 'mp4 m4v mkv webm mov avi wmv flv mpg mpeg mpe m2ts mts ts m2v vob 3gp 3g2 ogv asf rm rmvb divx xvid f4v mxf dv qt nut y4m'.split(' '),
  audio: 'mp3 m4a m4b aac flac wav ogg oga opus wma alac aif aiff ape mka ac3 dts wv amr'.split(' '),
  image: 'jpg jpeg png gif webp bmp avif heic svg'.split(' '),
  subtitle: 'srt vtt ass ssa'.split(' '),
};
const TYPE_BY_EXT = {};
for (const [t, list] of Object.entries(EXT)) for (const e of list) TYPE_BY_EXT[e] = t;

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', webmanifest: 'application/manifest+json',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mka: 'audio/x-matroska',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  srt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8', ass: 'text/plain; charset=utf-8', ssa: 'text/plain; charset=utf-8',
};

const extOf = (n) => path.extname(n).slice(1).toLowerCase();
const typeOf = (n) => TYPE_BY_EXT[extOf(n)] || 'file';
const isHidden = (n) => !SHOW_HIDDEN && (n.startsWith('.') || n.startsWith('@') || n === '$RECYCLE.BIN' || n === 'System Volume Information' || n === 'lost+found');
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

fs.mkdirSync(path.join(CACHE, 'thumbs'), { recursive: true });
fs.mkdirSync(path.join(CACHE, 'subs'), { recursive: true });
fs.mkdirSync(path.join(CACHE, 'previews'), { recursive: true });
// A pasta de cache do app pode estar DENTRO da biblioteca (ex.: /DATA/AppData/zima-video/cache, com /DATA como
// mídia). Ela é marcada e reconhecida (pelo arquivo-marca ou por ser a mesma pasta) para nunca aparecer como
// mídia: nem na lista, na busca, nas tags, nas sugestões ou na análise de rosto.
const CACHE_MARK = '.zima-video-cache';
let cacheId = null;
try {
  fs.writeFileSync(path.join(CACHE, CACHE_MARK), 'Cache do Zima Video (miniaturas e prévias) — não é mídia.\n');
  const cst = fs.statSync(CACHE); cacheId = `${cst.dev}:${cst.ino}`;
} catch { /* cache só leitura */ }
const cacheRels = new Set(); // caminhos (relativos à mídia) onde a pasta de cache foi encontrada
const inCacheRel = (rel) => { for (const c of cacheRels) if (rel === c || rel.startsWith(c + '/')) return true; return false; };
async function isCacheDir(abs, st) {
  if (!st) st = await statSafe(abs);
  if (!st || !st.isDirectory()) return false;
  if (cacheId && `${st.dev}:${st.ino}` === cacheId) return true;
  return !!(await statSafe(path.join(abs, CACHE_MARK)));
}
fs.mkdirSync(path.join(CACHE, 'storyboards'), { recursive: true });
fs.rmSync(path.join(CACHE, 'hls'), { recursive: true, force: true });
fs.mkdirSync(path.join(CACHE, 'hls'), { recursive: true });

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/** Converte caminho relativo (da URL) em absoluto, garantindo que fique dentro de ROOT. */
function resolveSafe(rel) {
  rel = String(rel || '').replace(/\\/g, '/');
  const abs = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new HttpError(403, 'Caminho inválido');
  return abs;
}
const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

const acceptsGzip = (req) => !!req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
function sendJSON(res, obj, code = 200) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (body.length > 1400 && acceptsGzip(res.req)) { body = zlib.gzipSync(body, { level: 6 }); headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

function run(cmd, args, { timeout = 120000, maxBuffer = 64 * 1024 * 1024, bg = false } = {}) {
  return new Promise((resolve, reject) => {
    // bg: tarefas de segundo plano rodam com prioridade mínima de CPU (nice 19)
    const p = bg && NICE ? spawn(NICE, ['-n', '19', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let size = 0; let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => { size += d.length; if (size <= maxBuffer) out.push(d); });
    p.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} saiu com código ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Fila simples para limitar processos ffmpeg simultâneos (miniaturas, legendas). */
// fifo: ordem de chegada (o navegador pede de cima para baixo). bump(key) passa um pedido que já está
// esperando para a frente da fila: o app repete o pedido só das miniaturas visíveis na tela, então elas
// furam a fila de pedidos antigos (de pastas que o usuário já deixou ou bem abaixo na rolagem).
function makeQueue(concurrency, maxWaiting = Infinity, { lifo = false } = {}) {
  let active = 0; const waiting = [];
  const next = () => {
    if (active >= concurrency || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = lifo ? waiting.pop() : waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  const q = (fn, key) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject, key });
    // fila cheia: descarta os pedidos mais antigos (o usuário já rolou a tela para outro lugar)
    while (waiting.length > maxWaiting) waiting.shift().reject(new HttpError(503, 'Fila cheia'));
    next();
  });
  q.bump = (key) => {
    const i = waiting.findIndex((w) => w.key === key);
    if (i <= 0) return;
    const [w] = waiting.splice(i, 1);
    if (lifo) waiting.push(w); else waiting.unshift(w);
  };
  return q;
}
const thumbQueue = makeQueue(parseInt(process.env.THUMB_CONCURRENCY || '2', 10), 400);
const previewQueue = makeQueue(2, 60);
const subQueue = makeQueue(1);
const clipQueue = makeQueue(parseInt(process.env.PREVIEW_CONCURRENCY || '1', 10), 3);

/** Evita trabalho duplicado para a mesma chave. */
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

// ---------------------------------------------------------------- listing
async function statSafe(p) { try { return await fsp.stat(p); } catch { return null; } }

// cache das listagens: reler e dar stat em centenas de arquivos num HD (disputando com o ffmpeg) é lento.
// Vale enquanto a pasta não mudar (mtime) e por no máximo 30s (tamanho/data de arquivos podem mudar).
const listCache = new Map();
const PENDING_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
async function listDir(rel) {
  const abs = resolveSafe(rel);
  const st = await statSafe(abs);
  if (!st) throw new HttpError(404, 'Pasta não encontrada');
  if (!st.isDirectory()) throw new HttpError(400, 'Não é uma pasta');
  const c = listCache.get(abs);
  let entries;
  if (c && c.mtime === st.mtimeMs && Date.now() - c.at < 30000) entries = c.entries;
  else {
    entries = await readEntries(abs, st);
    listCache.set(abs, { mtime: st.mtimeMs, at: Date.now(), entries });
    if (listCache.size > 300) listCache.delete(listCache.keys().next().value);
  }
  // tags e visualizações mudam sem mexer na pasta: sempre atuais
  return { path: relOf(abs), entries: entries.map((e) => { const r = relOf(path.join(abs, e.name)); return { ...e, tags: tagsOf(r), views: viewsOf(r) }; }) };
}
async function readEntries(abs, st) {
  // pasta alterada depois da última indexação → reindexa em segundo plano
  if (index && st.mtimeMs > indexBuiltAt && !indexBuilding) indexBuilding = buildIndex().finally(() => { indexBuilding = null; });
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  const items = dirents.filter((d) => !isHidden(d.name));
  // stat em lotes para não estourar descritores em pastas enormes
  for (let i = 0; i < items.length; i += 64) {
    const chunk = items.slice(i, i + 64);
    const stats = await Promise.all(chunk.map((d) => statSafe(path.join(abs, d.name))));
    chunk.forEach((d, k) => {
      const s = stats[k];
      if (!s) return;
      const dir = s.isDirectory();
      entries.push({ name: d.name, type: dir ? 'dir' : typeOf(d.name), size: dir ? 0 : s.size, mtime: s.mtimeMs, _s: s });
    });
  }
  // a pasta de cache do app não aparece
  const out = [];
  for (const e of entries) {
    const s = e._s; delete e._s;
    if (e.type === 'dir' && await isCacheDir(path.join(abs, e.name), s)) { cacheRels.add(relOf(path.join(abs, e.name))); continue; }
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- search index
let index = null; let indexBuiltAt = 0; let indexBuilding = null;

async function buildIndex() {
  const t0 = Date.now();
  const out = []; const foundCache = new Set();
  const stack = [ROOT];
  const MAX = 1000000;
  while (stack.length && out.length < MAX) {
    const dir = stack.pop();
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (isHidden(d.name)) continue;
      const abs = path.join(dir, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) { const s = await statSafe(abs); if (!s) continue; isDir = s.isDirectory(); }
      const rel = relOf(abs);
      if (isDir && await isCacheDir(abs)) { foundCache.add(rel); continue; } // cache do próprio app
      out.push({ p: rel, n: norm(d.name), d: isDir, t: isDir ? 'dir' : typeOf(d.name) });
      if (isDir) stack.push(abs);
    }
  }
  index = out; indexBuiltAt = Date.now();
  if ([...foundCache].join('\n') !== [...cacheRels].join('\n')) { cacheRels.clear(); for (const c of foundCache) cacheRels.add(c); }
  if (cacheRels.size) purgeCacheItems().catch((e) => console.error('cache purge', e));
  console.log(`[busca] índice com ${out.length} itens em ${Date.now() - t0}ms`);
  return out;
}

async function getIndex() {
  const stale = Date.now() - indexBuiltAt > INDEX_TTL;
  if (!index || stale) {
    if (!indexBuilding) indexBuilding = buildIndex().finally(() => { indexBuilding = null; });
    if (!index) await indexBuilding; // primeira vez: espera; depois: usa o antigo enquanto reconstrói
  }
  return index;
}

async function search(q, scope, mediaOnly) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return { results: [], total: 0 };
  const idx = await getIndex();
  let prefix = '';
  if (scope) { prefix = relOf(resolveSafe(scope)); if (prefix) prefix += '/'; }
  const results = [];
  let total = 0;
  for (const it of idx) {
    if (prefix && !it.p.startsWith(prefix)) continue;
    if (mediaOnly && !(it.d || it.t === 'video' || it.t === 'audio')) continue;
    if (!terms.every((t) => it.n.includes(t))) continue;
    total++;
    if (results.length < 2000) results.push(it);
  }
  const qn = terms.join(' ');
  const score = (it) => (it.n === qn ? 0 : it.n.startsWith(terms[0]) ? 1 : 2) + (it.d ? 0 : 0.5);
  results.sort((a, b) => score(a) - score(b) || a.p.length - b.p.length);
  const top = results.slice(0, 300);
  const withStat = await Promise.all(top.map(async (it) => {
    const s = await statSafe(path.join(ROOT, it.p));
    return { path: it.p, name: path.posix.basename(it.p), type: it.t, size: s && !it.d ? s.size : 0, mtime: s ? s.mtimeMs : 0, tags: tagsOf(it.p), views: viewsOf(it.p) };
  }));
  return { results: withStat, total, indexedAt: indexBuiltAt };
}

// ---------------------------------------------------------------- probe
const probeCache = new Map();
// cache de informações dos vídeos salvo em disco: depois de reiniciar não precisa rodar ffprobe de novo
const PROBE_FILE = path.join(CACHE, 'probe-cache.json');
let probeDirty = false;
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')))) probeCache.set(k, v); } catch { /* sem cache */ }
setInterval(() => {
  if (!probeDirty) return;
  probeDirty = false;
  const obj = Object.fromEntries([...probeCache.entries()].slice(-20000));
  fs.writeFile(PROBE_FILE + '.tmp', JSON.stringify(obj), (e) => { if (!e) fs.rename(PROBE_FILE + '.tmp', PROBE_FILE, () => {}); });
}, 30000).unref();

async function probe(abs) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const key = `${abs}|${st.size}|${st.mtimeMs}`;
  if (probeCache.has(key)) return probeCache.get(key);
  return once('probe:' + key, async () => {
    const buf = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 30000 });
    const j = JSON.parse(buf.toString());
    const streams = j.streams || [];
    const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '';
    const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    let fps = 0;
    if (v && v.avg_frame_rate && v.avg_frame_rate.includes('/')) {
      const [a, b] = v.avg_frame_rate.split('/').map(Number); if (b) fps = a / b;
    }
    const audio = streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
      index: i, codec: s.codec_name, profile: s.profile || '', channels: s.channels || 0, bitrate: parseInt(s.bit_rate || (s.tags && (s.tags.BPS || s.tags['BPS-eng'])) || 0, 10) || 0,
      lang: tag(s, 'language'), title: tag(s, 'title'), default: !!(s.disposition && s.disposition.default),
    }));
    const TEXT_SUBS = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'srt'];
    const subs = streams.filter((s) => s.codec_type === 'subtitle').map((s, i) => ({
      index: i, codec: s.codec_name, lang: tag(s, 'language'), title: tag(s, 'title'),
      default: !!(s.disposition && s.disposition.default), forced: !!(s.disposition && s.disposition.forced),
      text: TEXT_SUBS.includes(s.codec_name),
    }));
    let rot = 0;
    if (v) {
      const sd = (v.side_data_list || []).find((d) => d.rotation != null);
      rot = Math.round(parseFloat(sd ? sd.rotation : (v.tags && v.tags.rotate) || 0) || 0);
    }
    const info = {
      duration: parseFloat((j.format && j.format.duration) || (v && v.duration) || 0) || 0,
      format: (j.format && j.format.format_name) || '',
      bitrate: parseInt((j.format && j.format.bit_rate) || 0, 10),
      title: (j.format && j.format.tags && (j.format.tags.title || j.format.tags.TITLE)) || '',
      start: parseFloat((j.format && j.format.start_time) || 0) || 0,
      // vídeos de celular costumam ser gravados deitados com marcação de rotação (90°/270°):
      // largura/altura informadas já são as de exibição (como o navegador e o ffmpeg mostram)
      video: v ? { codec: v.codec_name, profile: v.profile || '', level: v.level || 0, rotation: rot,
        width: Math.abs(rot) % 180 === 90 ? v.height : v.width, height: Math.abs(rot) % 180 === 90 ? v.width : v.height, pix_fmt: v.pix_fmt || '', fps,
        start: parseFloat(v.start_time || (j.format && j.format.start_time) || 0) || 0 } : null,
      audio, subs,
    };
    probeCache.set(key, info); probeDirty = true;
    if (probeCache.size > 20000) probeCache.delete(probeCache.keys().next().value);
    return info;
  });
}

/** Legendas externas (.srt/.vtt/.ass) na mesma pasta com o mesmo nome base. */
async function sidecarSubs(abs) {
  const dir = path.dirname(abs);
  const base = norm(path.basename(abs, path.extname(abs)));
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const subs = names.filter((n) => typeOf(n) === 'subtitle');
  const videosInDir = names.filter((n) => typeOf(n) === 'video').length;
  return subs
    .filter((n) => norm(n).startsWith(base) || videosInDir === 1)
    .map((n) => {
      const stem = path.basename(n, path.extname(n));
      const rest = stem.length > base.length && norm(stem).startsWith(base) ? stem.slice(base.length).replace(/^[ ._-]+/, '') : '';
      return { path: relOf(path.join(dir, n)), name: n, label: rest || path.extname(n).slice(1).toUpperCase() };
    });
}

// ---------------------------------------------------------------- streaming (arquivo original)
async function serveFile(req, res, abs, { download = false, cache = false, immutable = false } = {}) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const type = MIME[extOf(abs)] || 'application/octet-stream';
  const headers = {
    'Content-Type': type, 'Accept-Ranges': 'bytes',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    // imutável: a URL traz a data do arquivo (v=…), então o navegador nunca precisa perguntar de novo
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : cache ? 'public, max-age=86400' : 'private, max-age=0, must-revalidate',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
  const range = req.headers.range;
  let start = 0; let end = st.size - 1; let code = 200;
  if (range && /^bytes=/.test(range)) {
    const m = range.replace(/^bytes=/, '').split(',')[0].split('-');
    if (m[0] === '') { start = Math.max(0, st.size - parseInt(m[1], 10)); }
    else { start = parseInt(m[0], 10); if (m[1]) end = Math.min(parseInt(m[1], 10), st.size - 1); }
    if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
    }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(abs, { start, end, highWaterMark: 256 * 1024 });
  stream.pipe(res);
  const media = /^(video|audio)\//.test(type) && end - start > 4 * 1024 * 1024;
  if (media) activeStreams++;
  res.on('close', () => { stream.destroy(); if (media) activeStreams--; });
}

// ---------------------------------------------------------------- transcodificação
function targetSize(info, h) {
  const v = info.video;
  if (!v || !v.width || !v.height) return null;
  // a qualidade (720p, 1080p…) vale para o lado menor, assim um vídeo vertical "720p" fica 720×1280
  const short = Math.min(v.width, v.height);
  const k = h ? Math.min(1, h / short) : 1;
  const ev = (x) => Math.max(2, Math.round(x / 2) * 2);
  return { w: ev(v.width * k), h: ev(v.height * k) };
}

function videoEncodeArgs(info, h, hw, keyint) {
  const size = targetSize(info, h);
  // limite de bitrate pelo lado menor (do maior para o menor: chaves numéricas em objeto ficam em ordem crescente)
  const tiers = [[2160, 16000], [1440, 10000], [1080, 6000], [720, 3500], [480, 1600], [0, 900]];
  const short = size ? Math.min(size.w, size.h) : 720;
  const maxrate = tiers.find(([k]) => short >= k)[1];
  const args = [];
  if (hw === 'vaapi') {
    args.push('-vf', `format=nv12|vaapi,hwupload,scale_vaapi=w=${size ? size.w : -2}:h=${size ? size.h : -2}`);
    args.push('-c:v', 'h264_vaapi', '-qp', '23', '-b:v', `${maxrate}k`, '-maxrate', `${maxrate}k`);
  } else {
    args.push('-vf', size ? `scale=${size.w}:${size.h},format=yuv420p` : 'format=yuv420p');
    args.push('-c:v', 'libx264', '-preset', X264_PRESET, '-crf', '23', '-profile:v', 'high', '-level', '4.1',
      '-maxrate', `${maxrate}k`, '-bufsize', `${maxrate * 2}k`);
  }
  if (keyint) args.push('-force_key_frames', `expr:gte(t,n_forced*${keyint})`);
  return args;
}

function hwInputArgs(hw) {
  if (hw === 'vaapi') {
    return ['-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va',
      '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi'];
  }
  return [];
}

const AUDIO_ARGS = ['-c:a', 'aac', '-ac', '2', '-b:a', '192k'];

/**
 * Stream MP4 fragmentado progressivo (remux ou transcode) a partir do tempo t.
 * Usado por navegadores com suporte a vídeo progressivo sem Content-Length (Chrome, Firefox, Android).
 */
async function serveProgressive(req, res, abs, q) {
  const info = await probe(abs);
  const t = Math.max(0, parseFloat(q.get('t') || '0') || 0);
  const mode = q.get('mode') === 'transcode' ? 'transcode' : 'remux';
  const audioIdx = parseInt(q.get('audio') || '0', 10) || 0;
  const h = parseInt(q.get('h') || '0', 10) || 0;
  const audioOnly = !info.video;
  const L = mode === 'remux' && !audioOnly ? await landing(abs, t) : t;

  const build = (hw) => {
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (mode === 'transcode' && !audioOnly) a.push(...hwInputArgs(hw));
    const remuxVideo = mode === 'remux' && !audioOnly;
    // Remux (vídeo copiado): o navegador ignora deslocamentos iniciais entre faixas no MP4 fragmentado,
    // então áudio e vídeo precisam começar exatamente no mesmo instante: o áudio é cortado/preenchido
    // com silêncio para começar no keyframe L, a linha do tempo é zerada em L (o cliente usa L como
    // deslocamento) e o delay_moov grava edit lists que compensam o atraso dos B-frames.
    if (remuxVideo) {
      if (t > 0) a.push('-noaccurate_seek', '-ss', t.toFixed(3));
    } else if (t > 0) a.push('-ss', t.toFixed(3));
    a.push('-i', abs);
    if (audioOnly) a.push('-vn'); else a.push('-map', '0:v:0');
    if (info.audio.length) a.push('-map', `0:a:${Math.min(audioIdx, info.audio.length - 1)}`);
    if (!audioOnly) {
      if (mode === 'remux') a.push('-c:v', 'copy');
      else a.push(...videoEncodeArgs(info, h, hw, 2));
    }
    if (remuxVideo && info.audio.length) a.push('-af', `aresample=48000:async=1:first_pts=${Math.round((L - t) * 48000)}`);
    a.push(...AUDIO_ARGS, '-sn', '-dn', '-map_metadata', '-1', '-max_muxing_queue_size', '4096');
    if (remuxVideo) a.push('-output_ts_offset', (t - L).toFixed(4));
    a.push('-movflags', `frag_keyframe+empty_moov+${remuxVideo ? 'delay_moov+' : ''}default_base_moof`,
      '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1');
    return a;
  };

  res.writeHead(200, { 'Content-Type': audioOnly ? 'audio/mp4' : 'video/mp4', 'Cache-Control': 'no-store', 'X-Start-Time': String(L) });
  if (req.method === 'HEAD') return res.end();

  let proc = null; let closed = false;
  const start = (hw) => {
    let sent = 0; let err = '';
    proc = spawn(FFMPEG, build(hw), { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { sent += d.length; if (!res.write(d)) { proc.stdout.pause(); res.once('drain', () => proc && proc.stdout.resume()); } });
    proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    proc.on('close', (code) => {
      if (closed) return;
      if (code !== 0 && sent === 0 && hw !== 'none') { console.warn('[transcode] hw falhou, usando software:', err.trim()); return start('none'); }
      if (code !== 0 && err) console.warn('[transcode]', err.trim().split('\n').slice(-2).join(' | '));
      res.end();
    });
  };
  start(mode === 'transcode' ? HWACCEL : 'none');
  activeStreams++;
  res.on('close', () => { closed = true; activeStreams--; if (proc) proc.kill('SIGKILL'); });
}

/** Tempo do keyframe imediatamente anterior a t (onde um remux com -c:v copy realmente começa). */
/**
 * Primeiro keyframe que o ffmpeg vai emitir ao copiar o vídeo a partir de s (tempos relativos ao
 * início do arquivo). Usa o mesmo mecanismo de busca do ffmpeg (ffprobe -read_intervals).
 */
const landingCache = new Map();
async function landing(abs, s) {
  const info = await probe(abs);
  const fs0 = info.start || 0;
  const key = `${abs}|${info.duration}|${s.toFixed(3)}`;
  if (landingCache.has(key)) return landingCache.get(key);
  let L = s;
  try {
    const ri = s > 0 ? `${(s + fs0).toFixed(3)}%+#300` : '%+#300';
    const out = await run(FFPROBE, ['-v', 'error', '-read_intervals', ri, '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', abs], { timeout: 15000 });
    for (const line of out.toString().split('\n')) {
      const [pts, flags] = line.split(',');
      const v = parseFloat(pts);
      if (flags && flags.includes('K') && isFinite(v)) { L = v - fs0; break; }
    }
  } catch { /* usa s */ }
  landingCache.set(key, L);
  if (landingCache.size > 500) landingCache.delete(landingCache.keys().next().value);
  return L;
}

/**
 * Plano de remux para o tempo t: s = onde buscar, l = onde o vídeo realmente começa (linha do tempo zero).
 * O ffmpeg recua 3/23s ao buscar em vídeos com B-frames; buscar 0,16s depois de um keyframe faz
 * ffmpeg e ffprobe caírem sempre no mesmo keyframe.
 */
async function remuxPlan(abs, t) {
  if (t <= 0.2) return { s: 0, l: await landing(abs, 0) };
  const k0 = await landing(abs, t);
  const s = Math.max(0, (k0 <= t + 0.05 ? k0 : t) + 0.16);
  return { s, l: await landing(abs, s) };
}

// ---------------------------------------------------------------- HLS sob demanda (iPhone/Safari)
const hlsJobs = new Map(); // sid -> job

function hlsSid(abs, h, audio) { return sha1(`${abs}|${h}|${audio}`).slice(0, 16); }

async function hlsPlaylist(abs, q) {
  const info = await probe(abs);
  const h = parseInt(q.get('h') || '0', 10) || 0;
  const audio = parseInt(q.get('audio') || '0', 10) || 0;
  const sid = hlsSid(abs, h, audio);
  if (!hlsJobs.has(sid)) {
    hlsJobs.set(sid, { sid, abs, h, audio, info, dir: path.join(CACHE, 'hls', sid), proc: null, start: -1, lastReq: Date.now() });
  }
  const dur = info.duration || 0;
  const n = Math.max(1, Math.ceil(dur / SEG));
  let m = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
  for (let i = 0; i < n; i++) {
    const d = i === n - 1 ? Math.max(0.1, dur - SEG * i) : SEG;
    m += `#EXTINF:${d.toFixed(3)},\nseg.ts?sid=${sid}&n=${i}\n`;
  }
  return m + '#EXT-X-ENDLIST\n';
}

function hlsStartJob(job, n, hw = HWACCEL) {
  if (job.proc) { job.proc.removeAllListeners('close'); job.proc.kill('SIGKILL'); }
  fs.mkdirSync(job.dir, { recursive: true });
  const info = job.info;
  const audioOnly = !info.video;
  const t = n * SEG;
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (!audioOnly) a.push(...hwInputArgs(hw));
  if (t > 0) a.push('-ss', String(t));
  a.push('-i', job.abs);
  if (audioOnly) a.push('-vn'); else a.push('-map', '0:v:0');
  if (info.audio.length) a.push('-map', `0:a:${Math.min(job.audio, info.audio.length - 1)}`);
  if (!audioOnly) a.push(...videoEncodeArgs(info, job.h, hw, SEG));
  a.push(...AUDIO_ARGS, '-sn', '-dn', '-map_metadata', '-1', '-max_muxing_queue_size', '4096',
    '-output_ts_offset', String(t), '-f', 'hls', '-hls_time', String(SEG), '-start_number', String(n),
    '-hls_list_size', '0', '-hls_flags', 'temp_file+independent_segments', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(job.dir, 's%05d.ts'), path.join(job.dir, 'ffmpeg.m3u8'));
  const proc = spawn(FFMPEG, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  proc.on('close', (code) => {
    if (job.proc !== proc) return;
    job.proc = null; job.done = code === 0;
    if (code !== 0 && hw !== 'none' && !fs.existsSync(segPath(job, n))) {
      console.warn('[hls] hw falhou, usando software:', err.trim());
      return hlsStartJob(job, n, 'none');
    }
    if (code !== 0 && code !== null) { job.error = err.trim(); console.warn('[hls]', job.error.split('\n').slice(-2).join(' | ')); }
  });
  job.proc = proc; job.start = n; job.done = false; job.error = null;
}

const segPath = (job, n) => path.join(job.dir, `s${String(n).padStart(5, '0')}.ts`);

/** Segmento mais alto já gerado pela tarefa atual. */
function hlsLatest(job) {
  let k = job.start;
  while (fs.existsSync(segPath(job, k))) k++;
  return k - 1;
}

async function hlsSegment(req, res, q) {
  const job = hlsJobs.get(q.get('sid') || '');
  if (!job) throw new HttpError(404, 'Sessão expirada');
  const n = parseInt(q.get('n') || '0', 10);
  job.lastReq = Date.now();
  const file = segPath(job, n);
  if (!(await exists(file))) {
    const running = job.proc && n >= job.start && n <= hlsLatest(job) + 4;
    if (!running) hlsStartJob(job, n);
    const deadline = Date.now() + 60000;
    while (!(await exists(file))) {
      if (Date.now() > deadline) throw new HttpError(504, 'Tempo esgotado gerando segmento');
      if (!job.proc && !(await exists(file))) {
        if (job.error) throw new HttpError(500, 'Falha na conversão');
        hlsStartJob(job, n);
      }
      if (res.destroyed) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const data = await fsp.readFile(file);
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

// limpeza de sessões HLS ociosas
setInterval(() => {
  const now = Date.now();
  for (const [sid, job] of hlsJobs) {
    if (job.proc && now - job.lastReq > 90000) { job.proc.kill('SIGKILL'); job.proc = null; }
    if (now - job.lastReq > 30 * 60000) { fs.rm(job.dir, { recursive: true, force: true }, () => {}); hlsJobs.delete(sid); }
  }
}, 30000).unref();

// ---------------------------------------------------------------- miniaturas
async function thumbnail(abs, t, width, { bg = false, hq = false } = {}) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const key = sha1(`${abs}|${st.size}|${st.mtimeMs}|${t}|${width}${hq ? '|hq' : ''}`);
  const out = path.join(CACHE, 'thumbs', key.slice(0, 2), key + '.jpg');
  if (await exists(out)) return out;
  const failMark = out + '.fail';
  if (await exists(failMark)) throw new HttpError(404, 'Sem miniatura');
  const queue = t === 'auto' ? thumbQueue : previewQueue;
  if (!bg) queue.bump(key); // pedido repetido da tela: passa na frente
  return once('thumb:' + key, () => queue(async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    let at = 0; let info = null;
    try { info = await probe(abs); } catch { /* ignore */ }
    if (t === 'auto' && typeOf(abs) === 'image') at = 0;
    else if (t === 'auto') {
      const d = info ? info.duration : 0;
      at = d > 0 ? Math.min(d * 0.15, Math.max(0, d - 1)) : 5;
    } else at = Math.max(0, parseFloat(t) || 0);
    const tmp = out + '.' + process.pid + '.tmp.jpg';
    // sem -ss quando é 0: o leitor de JPEG do ffmpeg não gera nada com -ss (nem -ss 0)
    const isImg = typeOf(abs) === 'image';
    // vídeo: decodifica só o quadro-chave mais próximo (~40% mais rápido; para miniatura não precisa ser exato)
    const fast = isImg ? [] : ['-skip_frame', 'nokey', '-noaccurate_seek'];
    let useFast = true;
    const attempt = (ss) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(useFast ? fast : []), ...(ss > 0 ? ['-ss', ss.toFixed(2)] : []), '-i', abs,
      '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:-2:flags=bilinear`, '-q:v', hq ? '3' : t === 'auto' ? '4' : '7', '-y', tmp], { timeout: 30000, bg });
    try {
      await attempt(at).catch(() => {});
      if (!(await exists(tmp))) { useFast = false; await attempt(at).catch(() => {}); } // sem quadro-chave útil: modo exato
      if (!(await exists(tmp))) await attempt(0);
      if (!(await exists(tmp))) throw new Error('sem frame');
      await fsp.rename(tmp, out);
      return out;
    } catch (e) {
      fsp.rm(tmp, { force: true }).catch(() => {});
      if (t === 'auto') await fsp.writeFile(failMark, String(e.message)).catch(() => {});
      throw new HttpError(404, 'Sem miniatura');
    }
  }, key));
}

// ---------------------------------------------------------------- prévia em vídeo (estilo YouTube)
/**
 * Clipe curto e mudo (≈10s) com trechos de vários pontos do vídeo, em 16:9 pequeno.
 * Gerado uma vez e guardado no cache.
 */
async function previewClip(abs, { bg = false } = {}) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const key = sha1(`${abs}|${st.size}|${st.mtimeMs}|pv1`);
  const out = path.join(CACHE, 'previews', key.slice(0, 2), key + '.mp4');
  if (await exists(out)) return out;
  if (await exists(out + '.fail')) throw new HttpError(404, 'Sem prévia');
  return once('clip:' + key, () => clipQueue(async () => {
    const info = await probe(abs);
    if (!info.video) throw new HttpError(404, 'Sem vídeo');
    const d = info.duration || 0;
    const LEN = 2;
    let parts;
    if (d <= 0) parts = [[0, 8]];
    else if (d < 14) parts = [[0, Math.min(d, 10)]];
    else {
      const n = d < 60 ? 3 : 5;
      parts = Array.from({ length: n }, (_, i) => [Math.min(d * (0.1 + (0.75 * i) / (n - 1)), d - LEN - 0.5), LEN]);
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    for (const [ss, t] of parts) args.push('-ss', ss.toFixed(2), '-t', String(t), '-i', abs);
    const W = 384; const H = 216;
    const chains = parts.map((_, i) => `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=24,setsar=1,format=yuv420p[v${i}]`);
    const filter = chains.join(';') + ';' + parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0[out]`;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = out + '.' + process.pid + '.tmp.mp4';
    args.push('-filter_complex', filter, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-profile:v', 'main', '-level', '3.1', '-movflags', '+faststart', '-y', tmp);
    try {
      await run(FFMPEG, args, { timeout: 120000, bg });
      await fsp.rename(tmp, out);
      return out;
    } catch (e) {
      fsp.rm(tmp, { force: true }).catch(() => {});
      await fsp.writeFile(out + '.fail', String(e.message)).catch(() => {});
      console.warn('[prévia]', path.basename(abs), e.message);
      throw new HttpError(404, 'Sem prévia');
    }
  }));
}

// ---------------------------------------------------------------- storyboard (prévia da barra de progresso)
// Folhas de 10×10 miniaturas (160×90) cobrindo o vídeo todo, geradas de uma vez lendo só os quadros-chave.
// Com elas a prévia ao arrastar a barra é instantânea (antes: um ffmpeg por posição).
const sbQueue = makeQueue(1, 6);
const SB = { cols: 10, rows: 10, w: 160, h: 90 };
async function storyboardInfo(abs) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const key = sha1(`${abs}|${st.size}|${st.mtimeMs}|sb1`);
  return { key, dir: path.join(CACHE, 'storyboards', key.slice(0, 2), key) };
}
async function storyboard(abs, { bg = false, wait = true } = {}) {
  const { key, dir } = await storyboardInfo(abs);
  const meta = path.join(dir, 'meta.json');
  const done = await loadJSON(meta, null);
  if (done) return done;
  if (await exists(dir + '.fail')) return { ready: false, failed: true };
  const job = once('sb:' + key, () => sbQueue(async () => {
    const info = await probe(abs);
    if (!info.video || !info.duration) throw new HttpError(404, 'Sem vídeo');
    const interval = Math.max(2, info.duration / 240); // até 240 quadros (3 folhas)
    const tmp = dir + '.tmp' + process.pid;
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    try {
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-i', abs, '-map', '0:v:0', '-an', '-sn',
        '-vf', `fps=1/${interval.toFixed(3)},scale=${SB.w}:${SB.h}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${SB.w}:${SB.h}:(ow-iw)/2:(oh-ih)/2,tile=${SB.cols}x${SB.rows}`,
        '-q:v', '5', '-y', path.join(tmp, 'sb_%d.jpg')], { timeout: 15 * 60000, bg });
      const sheets = (await fsp.readdir(tmp)).filter((n) => /^sb_\d+\.jpg$/.test(n)).length;
      if (!sheets) throw new Error('sem quadros');
      const m = { ready: true, interval, count: Math.ceil(info.duration / interval), sheets, ...SB, v: key.slice(0, 12) };
      await fsp.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(m));
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(dir), { recursive: true });
      await fsp.rename(tmp, dir);
      return m;
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (!(e instanceof HttpError && e.code === 503)) await fsp.writeFile(dir + '.fail', String(e.message)).catch(() => {});
      throw e;
    }
  }));
  if (!wait) { job.catch(() => {}); return { ready: false }; }
  return job;
}

// ---------------------------------------------------------------- pré-geração em segundo plano
// Percorre a biblioteca e deixa miniaturas, prévias e storyboards prontos, com prioridade mínima de CPU.
// Pausa enquanto alguém assiste ou navega (pedidos recentes), para não disputar disco/CPU.
let activeStreams = 0;          // vídeos sendo transmitidos agora
let lastUserActivity = 0;       // último pedido de miniatura/prévia/storyboard vindo de um usuário
const pregen = { enabled: PREGEN !== 'off', running: false, total: 0, done: 0, current: '', last: 0 };
const isBusy = () => activeStreams > 0 || [...hlsJobs.values()].some((j) => j.proc) || Date.now() - lastUserActivity < 8000;
async function pregenPass() {
  if (!pregen.enabled || pregen.running) return;
  pregen.running = true;
  try {
    const idx = await getIndex();
    const vids = idx.filter((it) => it.t === 'video' || (it.t === 'image' && THUMBNAILS));
    pregen.total = vids.length; pregen.done = 0;
    for (const it of vids) {
      while (isBusy()) await new Promise((r) => setTimeout(r, 5000));
      const abs = path.join(ROOT, it.p);
      pregen.current = it.p;
      try {
        if (THUMBNAILS) await thumbnail(abs, 'auto', 320, { bg: true });
        if (it.t === 'video' && PREGEN === 'all') {
          if (PREVIEWS) await previewClip(abs, { bg: true }).catch(() => {});
          await storyboard(abs, { bg: true }).catch(() => {});
        }
      } catch { /* arquivo problemático: segue */ }
      pregen.done++;
    }
  } finally {
    pregen.running = false; pregen.current = ''; pregen.last = Date.now();
  }
}
if (pregen.enabled) {
  setTimeout(() => pregenPass().catch(() => {}), 45000).unref();
  setInterval(() => pregenPass().catch(() => {}), 30 * 60000).unref(); // pega arquivos novos
}

// ---------------------------------------------------------------- legendas
function srtToVtt(text) {
  text = text.replace(/^﻿/, '').replace(/\r/g, '');
  return 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2').replace(/^\d+\n(?=\d{1,2}:\d{2})/gm, '');
}

function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return buf.toString('latin1'); // legendas antigas em Windows-1252/ISO-8859-1
}

async function subtitle(q) {
  const file = q.get('file');
  if (file) {
    const abs = resolveSafe(file);
    const ext = extOf(abs);
    const buf = await fsp.readFile(abs);
    if (ext === 'vtt') return decodeText(buf);
    if (ext === 'srt') return srtToVtt(decodeText(buf));
    // ass/ssa → ffmpeg
    const out = await subQueue(() => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-sub_charenc', 'UTF-8', '-i', abs, '-f', 'webvtt', 'pipe:1'], { timeout: 60000 }));
    return out.toString('utf8');
  }
  const abs = resolveSafe(q.get('path'));
  const track = parseInt(q.get('track') || '0', 10) || 0;
  const st = await statSafe(abs);
  if (!st) throw new HttpError(404, 'Arquivo não encontrado');
  const key = sha1(`${abs}|${st.size}|${st.mtimeMs}|${track}`);
  const out = path.join(CACHE, 'subs', key + '.vtt');
  if (await exists(out)) return fsp.readFile(out, 'utf8');
  return once('sub:' + key, () => subQueue(async () => {
    const buf = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', abs, '-map', `0:s:${track}`, '-f', 'webvtt', 'pipe:1'], { timeout: 600000 });
    await fsp.writeFile(out, buf);
    return buf.toString('utf8');
  }));
}

// ---------------------------------------------------------------- favoritos
// Guardados no servidor (mesma lista no celular e no computador).
const DATA_DIR = path.resolve(process.env.DATA_DIR || CACHE);
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');
let favorites = null;
async function loadFavorites() {
  if (favorites) return favorites;
  try { favorites = JSON.parse(await fsp.readFile(FAV_FILE, 'utf8')); if (!Array.isArray(favorites)) favorites = []; }
  catch { favorites = []; }
  return favorites;
}
let favWrite = Promise.resolve();
function saveFavorites() {
  const data = JSON.stringify(favorites, null, 1);
  favWrite = favWrite.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = FAV_FILE + '.tmp';
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, FAV_FILE);
  }).catch((e) => console.warn('[favoritos]', e.message));
  return favWrite;
}
async function listFavorites() {
  const favs = await loadFavorites();
  const items = await Promise.all(favs.map(async (f) => {
    const st = await statSafe(path.join(ROOT, f.path));
    const dir = st ? st.isDirectory() : f.type === 'dir';
    return { path: f.path, name: path.posix.basename(f.path) || 'Início', type: dir ? 'dir' : typeOf(f.path),
      size: st && !dir ? st.size : 0, mtime: st ? st.mtimeMs : 0, added: f.added, missing: !st, tags: tagsOf(f.path), views: viewsOf(f.path) };
  }));
  return { items };
}
async function setFavorite(rel, on) {
  const abs = resolveSafe(rel);
  const p = relOf(abs);
  const favs = await loadFavorites();
  const i = favs.findIndex((f) => f.path === p);
  if (on && i < 0) {
    const st = await statSafe(abs);
    if (!st) throw new HttpError(404, 'Arquivo não encontrado');
    favs.unshift({ path: p, type: st.isDirectory() ? 'dir' : typeOf(p), added: Date.now() });
  } else if (!on && i >= 0) favs.splice(i, 1);
  await saveFavorites();
  return listFavorites();
}

// ---------------------------------------------------------------- JSON persistente (escrita atômica e em fila)
const jsonWrites = new Map();
function saveJSON(file, data) {
  const body = JSON.stringify(data, null, 1);
  const prev = jsonWrites.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', body);
    await fsp.rename(file + '.tmp', file);
  }).catch((e) => console.warn('[dados]', path.basename(file), e.message));
  jsonWrites.set(file, next);
  return next;
}
async function loadJSON(file, def) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return def; } }

// ---------------------------------------------------------------- tags
const TAG_FILE = path.join(DATA_DIR, 'tags.json');
const TAG_COLORS = ['#7c5cff', '#ff5c7a', '#2bb673', '#ffb020', '#3ea6ff', '#ff7a2f', '#c05cff', '#14b8a6', '#e5484d', '#8d9eff'];
let tagDb = null;
let tagVer = 0; // muda a cada gravação das tags
async function loadTags() {
  if (!tagDb) {
    tagDb = await loadJSON(TAG_FILE, null);
    if (!tagDb || typeof tagDb !== 'object') tagDb = {};
    tagDb.tags = tagDb.tags || {}; tagDb.items = tagDb.items || {};
  }
  return tagDb;
}
const saveTags = () => { tagVer++; return saveJSON(TAG_FILE, tagDb); };
const tagsOf = (rel) => (tagDb && tagDb.items[rel]) || undefined;
const ptCollator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const ptSort = (a, b) => ptCollator.compare(a, b);
function cleanTagName(n) {
  n = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) throw new HttpError(400, 'Nome de tag vazio');
  return n;
}
// chave para comparar nomes de tag: sem maiúsculas, acentos e pontuação ("Maria.Souza" = "maria souza")
const tagKey = (s) => norm(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim();
// tag já existente com o mesmo nome (ou apelido de pessoa) — evita criar duplicadas
function findTag(db, name) {
  if (db.tags[name]) return name;
  const k = tagKey(name); if (!k) return null;
  for (const t of Object.keys(db.tags)) if (tagKey(t) === k) return t;
  for (const [t, v] of Object.entries(db.tags)) if ((v.aliases || []).some((a) => tagKey(a) === k)) return t;
  return null;
}
function lev1(a, b) { // distância de edição <= 1?
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
// grupos de tags que parecem ser a mesma: nome igual sem acento/pontuação, palavras trocadas de ordem,
// apelido de outra tag, ou um erro de digitação (1 letra) em nomes longos
async function similarTags() {
  const db = await loadTags();
  const names = Object.keys(db.tags);
  const count = {};
  for (const list of Object.values(db.items)) for (const t of list) count[t] = (count[t] || 0) + 1;
  const parent = Object.fromEntries(names.map((n) => [n, n]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const join = (a, b) => { parent[find(a)] = find(b); };
  const info = names.map((n) => {
    const k = tagKey(n);
    return { n, k, w: k.split(' ').sort().join(' '), al: (db.tags[n].aliases || []).map(tagKey) };
  });
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const a = info[i]; const b = info[j];
      if (!a.k || !b.k) continue;
      if (a.k === b.k || a.w === b.w || a.al.includes(b.k) || b.al.includes(a.k) || (a.k.length >= 6 && b.k.length >= 6 && lev1(a.k, b.k))) join(a.n, b.n);
    }
  }
  const groups = {};
  for (const n of names) (groups[find(n)] = groups[find(n)] || []).push(n);
  return {
    groups: Object.values(groups).filter((g) => g.length > 1)
      .map((g) => g.map((n) => ({ name: n, count: count[n] || 0, person: !!db.tags[n].person })).sort((a, b) => b.count - a.count || ptSort(a.name, b.name)))
      .sort((a, b) => ptSort(a[0].name, b[0].name)),
  };
}
// juntar tags: os itens de "from" passam a ter "into"; os nomes antigos viram apelidos de "into"
async function mergeTags({ from, into }) {
  const db = await loadTags();
  into = cleanTagName(into);
  if (!db.tags[into]) throw new HttpError(404, 'Tag de destino não encontrada');
  const src = [...new Set((from || []).map(cleanTagName))].filter((f) => f !== into && db.tags[f]);
  if (!src.length) throw new HttpError(400, 'Escolha as tags para juntar');
  const dst = db.tags[into];
  const aliases = new Set(dst.aliases || []);
  for (const f of src) {
    const v = db.tags[f];
    if (v.person) dst.person = true;
    for (const a of [f, ...(v.aliases || [])]) if (tagKey(a) !== tagKey(into)) aliases.add(a);
    for (const [k, list] of Object.entries(db.items)) {
      if (!list.includes(f)) continue;
      db.items[k] = [...new Set(list.map((t) => (t === f ? into : t)))].sort(ptSort);
    }
    delete db.tags[f];
    await peopleTagRenamed(f, into);
  }
  if (aliases.size) dst.aliases = [...aliases].slice(0, 30);
  await saveTags();
  return { ok: true, merged: src.length, into, ...(await listTags()) };
}
async function listTags() {
  const db = await loadTags();
  const count = {};
  for (const list of Object.values(db.items)) for (const t of list) count[t] = (count[t] || 0) + 1;
  const tags = Object.entries(db.tags).map(([name, v]) => ({ name, color: v.color, count: count[name] || 0, person: !!v.person, aliases: v.aliases || [] }))
    .sort((a, b) => ptSort(a.name, b.name));
  return { tags };
}
async function assignTags({ paths, add = [], remove = [] }) {
  const db = await loadTags();
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nenhum item selecionado');
  add = add.map((t) => findTag(db, cleanTagName(t)) || cleanTagName(t)); remove = remove.map(cleanTagName);
  for (const t of add) if (!db.tags[t]) db.tags[t] = { color: TAG_COLORS[Object.keys(db.tags).length % TAG_COLORS.length] };
  for (const raw of paths) {
    const rel = relOf(resolveSafe(raw));
    if (!(await statSafe(path.join(ROOT, rel)))) continue;
    const set = new Set(db.items[rel] || []);
    add.forEach((t) => set.add(t)); remove.forEach((t) => set.delete(t));
    if (set.size) db.items[rel] = [...set].sort(ptSort); else delete db.items[rel];
  }
  await saveTags();
  return listTags();
}
async function editTag({ name, newName, color, remove, person, aliases }) {
  const db = await loadTags();
  name = cleanTagName(name);
  if (!db.tags[name]) throw new HttpError(404, 'Tag não encontrada');
  if (remove) {
    delete db.tags[name];
    for (const [k, list] of Object.entries(db.items)) { const l = list.filter((t) => t !== name); if (l.length) db.items[k] = l; else delete db.items[k]; }
    await peopleTagRenamed(name, null);
  } else {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) db.tags[name].color = color;
    // pessoa: usada na detecção pelo nome dos arquivos e pelo rosto; apelidos = outras formas do nome
    if (person != null) db.tags[name].person = !!person;
    if (Array.isArray(aliases)) db.tags[name].aliases = [...new Set(aliases.map((a) => String(a).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
    if (newName && cleanTagName(newName) !== name) {
      const nn = cleanTagName(newName);
      if (db.tags[nn]) throw new HttpError(409, `Já existe a tag “${nn}”: use “Juntar com outra tag”`);
      db.tags[nn] = db.tags[name]; delete db.tags[name];
      for (const [k, list] of Object.entries(db.items)) db.items[k] = [...new Set(list.map((t) => (t === name ? nn : t)))].sort(ptSort);
      await peopleTagRenamed(name, nn);
    }
  }
  await saveTags();
  return listTags();
}
// tira tags, rostos e visualizações que tenham ido parar em arquivos do cache (versões antigas não escondiam)
let purgedKey = '';
async function purgeCacheItems() {
  const key = [...cacheRels].join('\n'); if (key === purgedKey) return; purgedKey = key;
  const db = await loadTags(); let n = 0;
  for (const rel of Object.keys(db.items)) if (inCacheRel(rel)) { delete db.items[rel]; n++; }
  if (n) await saveTags();
  let f = 0;
  for (const rel of [...faceVideos.keys()]) if (inCacheRel(rel)) { fs.rm(videoFile(rel), { force: true }, () => {}); indexFaces(rel, null); f++; }
  if (n || f) console.log(`[cache] pasta de cache dentro da biblioteca escondida (${[...cacheRels].join(', ')}): ${n} tag(s) e ${f} análise(s) de rosto removidas`);
}
async function itemsWithTag(tag) {
  const db = await loadTags();
  const out = [];
  for (const [rel, list] of Object.entries(db.items)) {
    if (!list.includes(tag) || inCacheRel(rel)) continue;
    const st = await statSafe(path.join(ROOT, rel));
    if (!st) continue;
    const dir = st.isDirectory();
    out.push({ path: rel, name: path.posix.basename(rel), type: dir ? 'dir' : typeOf(rel), size: dir ? 0 : st.size, mtime: st.mtimeMs, tags: list, views: viewsOf(rel) });
  }
  out.sort((a, b) => ((b.type === 'dir') - (a.type === 'dir')) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
  return { items: out };
}

// ---------------------------------------------------------------- visualizações
// Quantas vezes cada vídeo foi assistido (contado pelo player depois de ~30s assistidos) e quando.
// Guardado no servidor: igual em todos os aparelhos.
const VIEWS_FILE = path.join(DATA_DIR, 'views.json');
let viewDb = null; // { path: { n, last, first } }
async function loadViews() {
  if (!viewDb) { viewDb = await loadJSON(VIEWS_FILE, null); if (!viewDb || typeof viewDb !== 'object' || Array.isArray(viewDb)) viewDb = {}; }
  return viewDb;
}
let viewSaveTimer = null;
const saveViews = (now = false) => {
  clearTimeout(viewSaveTimer);
  if (now) return saveJSON(VIEWS_FILE, viewDb);
  viewSaveTimer = setTimeout(() => saveJSON(VIEWS_FILE, viewDb), 2000); // agrupa várias contagens seguidas
  return Promise.resolve();
};
const viewsOf = (rel) => (viewDb && viewDb[rel]) || undefined;
const viewLimiter = new Map(); // evita contar o mesmo vídeo várias vezes seguidas (ex.: recarregar a página)
async function addView(req, rel) {
  if (req.method !== 'POST' || req.headers['x-zv'] !== '1') throw new HttpError(403, 'Requisição inválida');
  const abs = resolveSafe(rel); const r = relOf(abs);
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const db = await loadViews();
  const key = `${req.socket.remoteAddress}|${r}`;
  if (Date.now() - (viewLimiter.get(key) || 0) < 60000) return { ok: true, views: db[r], counted: false };
  viewLimiter.set(key, Date.now());
  if (viewLimiter.size > 5000) viewLimiter.delete(viewLimiter.keys().next().value);
  const now = Date.now();
  const v = db[r] || { n: 0, first: now };
  v.n += 1; v.last = now; db[r] = v;
  await saveViews();
  return { ok: true, views: v, counted: true };
}
async function clearViews(rel) {
  const db = await loadViews(); const r = relOf(resolveSafe(rel));
  delete db[r]; await saveViews(true);
  return { ok: true };
}

// ---------------------------------------------------------------- administração (gerenciar arquivos)
// Senha do administrador: variável ADMIN_PASSWORD (tem prioridade) ou criada pelo próprio app,
// guardada como hash scrypt em DATA_DIR/admin.json.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
let adminStored; // { salt, hash } | null
async function storedAdmin() {
  if (adminStored === undefined) {
    const j = await loadJSON(ADMIN_FILE, null);
    adminStored = j && j.salt && j.hash ? j : null;
  }
  return adminStored;
}
async function adminEnabled() { return !!(ADMIN_PASSWORD || (await storedAdmin())); }
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(String(pw), salt, 32, (e, k) => (e ? rej(e) : res(k))));
async function checkPassword(pw) {
  if (ADMIN_PASSWORD) {
    const a = crypto.createHash('sha256').update(String(pw || '')).digest();
    return crypto.timingSafeEqual(a, crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
  }
  const st = await storedAdmin(); if (!st) return false;
  const k = await scrypt(pw || '', Buffer.from(st.salt, 'hex'));
  return crypto.timingSafeEqual(k, Buffer.from(st.hash, 'hex'));
}
async function setStoredPassword(pw) {
  pw = String(pw || '');
  if (pw.length < 4) throw new HttpError(400, 'A senha precisa ter pelo menos 4 caracteres');
  const salt = crypto.randomBytes(16);
  adminStored = { salt: salt.toString('hex'), hash: (await scrypt(pw, salt)).toString('hex'), created: Date.now() };
  await saveJSON(ADMIN_FILE, adminStored);
  adminSecret = null; // trocar a senha encerra as outras sessões
}
let adminSecret = null;
async function getAdminSecret() {
  if (adminSecret) return adminSecret;
  const f = path.join(DATA_DIR, 'admin.key');
  let salt = (await loadJSON(f, null)) || null;
  if (!salt) { salt = crypto.randomBytes(32).toString('hex'); await saveJSON(f, salt); }
  const st = await storedAdmin();
  adminSecret = crypto.createHash('sha256').update(`${salt}|${ADMIN_PASSWORD || (st ? st.hash : '')}`).digest();
  return adminSecret;
}
// pastas montadas como somente leitura (":ro" no docker-compose) — o app avisa no menu
function readonlyMounts() {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split('\n').map((l) => l.split(' '))
      .filter((f) => f.length > 3 && (f[1] === ROOT || f[1].startsWith(ROOT + '/')) && f[3].split(',').includes('ro'))
      .map((f) => relOf(f[1].replace(/\\040/g, ' ')) || '/');
  } catch { return []; }
}
async function sessionCookie(res) {
  const exp = String(Date.now() + 30 * 86400000);
  const sig = crypto.createHmac('sha256', await getAdminSecret()).update(exp).digest('hex');
  res.setHeader('Set-Cookie', `zv_admin=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}`);
}
async function adminSetup(req, res) {
  // criar a senha pelo app: só enquanto nenhuma senha existir
  if (req.method !== 'POST' || req.headers['x-zv'] !== '1') throw new HttpError(403, 'Requisição inválida');
  if (await adminEnabled()) throw new HttpError(409, 'Já existe uma senha de administrador');
  const { password } = await readBody(req);
  await setStoredPassword(password);
  await sessionCookie(res);
  console.log('[admin] senha de administrador criada pelo app');
  return { ok: true };
}
async function adminChangePassword(req) {
  await requireAdmin(req);
  if (ADMIN_PASSWORD) throw new HttpError(409, 'A senha está definida pela variável ADMIN_PASSWORD; altere-a nas configurações do app no ZimaOS');
  const { current, password } = await readBody(req);
  if (!(await checkPassword(current))) throw new HttpError(401, 'Senha atual incorreta');
  await setStoredPassword(password);
  return { ok: true };
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
async function isAdmin(req) {
  if (!(await adminEnabled())) return false;
  const c = cookies(req).zv_admin; if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || !(+exp > Date.now())) return false;
  const good = crypto.createHmac('sha256', await getAdminSecret()).update(exp).digest('hex');
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (d) => { size += d.length; if (size > limit) { reject(new HttpError(413, 'Requisição grande demais')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new HttpError(400, 'JSON inválido')); } });
    req.on('error', reject);
  });
}
// toda alteração: POST + cabeçalho próprio (bloqueia formulários de outros sites) + sessão de administrador
async function requireAdmin(req) {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
  if (req.headers['x-zv'] !== '1') throw new HttpError(403, 'Requisição inválida');
  if (!(await adminEnabled())) throw new HttpError(403, 'Crie a senha de administrador primeiro (menu ⋮)');
  if (!(await isAdmin(req))) throw new HttpError(401, 'Entre no modo administrador');
}
async function requireAdminGet(req) {
  if (!(await isAdmin(req))) throw new HttpError(401, 'Entre no modo administrador');
}
const loginFails = new Map(); // ip -> { n, until }
async function adminLogin(req, res) {
  if (req.method !== 'POST' || req.headers['x-zv'] !== '1') throw new HttpError(403, 'Requisição inválida');
  if (!(await adminEnabled())) throw new HttpError(403, 'Crie a senha de administrador primeiro');
  const ip = req.socket.remoteAddress || '?';
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil((f.until - Date.now()) / 60000)} min`);
  const { password } = await readBody(req);
  if (!(await checkPassword(password))) {
    const n = (f ? f.n : 0) + 1;
    loginFails.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 });
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, 'Senha incorreta');
  }
  loginFails.delete(ip);
  await sessionCookie(res);
  return { ok: true };
}

function validName(n) {
  n = String(n || '').trim();
  if (!n || n === '.' || n === '..' || /[\/\\\0]/.test(n) || n.length > 255) throw new HttpError(400, 'Nome inválido');
  return n;
}
function fsError(e) {
  if (e instanceof HttpError) return e;
  if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
    return new HttpError(403, 'Pasta somente leitura: nas configurações do app no ZimaOS, troque o volume para leitura e gravação (tire o ":ro")');
  }
  if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') return new HttpError(409, 'Já existe um item com esse nome');
  if (e.code === 'ENOENT') return new HttpError(404, 'Item não encontrado');
  if (e.code === 'EBUSY') return new HttpError(409, 'Item em uso');
  return new HttpError(500, e.message);
}
/** Item que pode ser alterado: dentro de ROOT e abaixo das pastas de volume (DATA, Discos…). */
function editablePath(rel) {
  const abs = resolveSafe(rel);
  const r = relOf(abs);
  if (!r || !r.includes('/')) throw new HttpError(403, 'Pastas de volume não podem ser alteradas');
  return abs;
}
async function freeName(dir, name) {
  const ext = path.extname(name); const base = ext && ext.length < name.length ? name.slice(0, -ext.length) : name;
  let cand = name; let i = 2;
  while (await exists(path.join(dir, cand))) cand = `${base} (${i++})${ext && ext.length < name.length ? ext : ''}`;
  return cand;
}
async function moveFs(from, to) {
  // a origem precisa aceitar gravação (senão sobraria uma cópia no destino)
  await fsp.access(path.dirname(from), fs.constants.W_OK);
  try { await fsp.rename(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // discos/volumes diferentes: copia e só então apaga a origem; se a cópia falhar, desfaz
    try { await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); }
    catch (err) { await fsp.rm(to, { recursive: true, force: true }).catch(() => {}); throw err; }
    await fsp.rm(from, { recursive: true, force: true });
  }
}
/** Atualiza favoritos, tags e índice quando algo muda de caminho (inclui o conteúdo de pastas). */
async function relocate(pairs) {
  const favs = await loadFavorites(); const db = await loadTags();
  let favChanged = false; let tagChanged = false;
  const map = (p) => { for (const [a, b] of pairs) { if (p === a) return b; if (p.startsWith(a + '/')) return b + p.slice(a.length); } return null; };
  for (const f of favs) { const n = map(f.path); if (n !== null) { f.path = n; favChanged = true; } }
  // monta um objeto novo (renomear "no lugar" estragaria trocas como A↔B)
  const items = {};
  for (const [k, v] of Object.entries(db.items)) { const n = map(k); if (n !== null) tagChanged = true; items[n !== null ? n : k] = v; }
  db.items = items;
  const vdb = await loadViews(); const nv = {}; let viewChanged = false;
  for (const [k, v] of Object.entries(vdb)) { const n = map(k); if (n !== null) viewChanged = true; nv[n !== null ? n : k] = v; }
  if (viewChanged) { viewDb = nv; await saveViews(true); }
  await peopleRelocate(pairs);
  if (favChanged) await saveFavorites();
  if (tagChanged) await saveTags();
  indexBuiltAt = 0; // a pesquisa reindexa na próxima consulta
}
async function forget(rels) {
  // remove favoritos/tags de itens apagados; devolve o que foi removido (para restaurar da lixeira)
  const favs = await loadFavorites(); const db = await loadTags();
  const under = (p, a) => p === a || p.startsWith(a + '/');
  const vdb = await loadViews();
  const saved = { favs: [], tags: {}, views: {} };
  for (const a of rels) {
    for (let i = favs.length - 1; i >= 0; i--) if (under(favs[i].path, a)) { saved.favs.push(favs[i]); favs.splice(i, 1); }
    for (const k of Object.keys(db.items)) if (under(k, a)) { saved.tags[k] = db.items[k]; delete db.items[k]; }
    for (const k of Object.keys(vdb)) if (under(k, a)) { saved.views[k] = vdb[k]; delete vdb[k]; }
  }
  await saveFavorites(); await saveTags(); await saveViews(true);
  await peopleRelocate([], rels); // rostos de itens apagados saem da análise (refazem se restaurados)
  indexBuiltAt = 0;
  return saved;
}

// lixeira: fica no mesmo disco do item (mover é instantâneo), registrada em trash.json
const TRASH_FILE = path.join(DATA_DIR, 'trash.json');
const TRASH_DIR = '.zima-lixeira';
// Pasta raiz da montagem onde o item está (a lixeira fica nela: mover dentro da mesma montagem é
// instantâneo). Usa a tabela de montagens — volumes do Docker do mesmo disco ainda são montagens
// diferentes e não permitem mover entre si (EXDEV).
function mountPoints() {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split('\n').map((l) => l.split(' ')[1]).filter(Boolean)
      .map((m) => m.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\'));
  } catch { return null; }
}
async function mountRoot(abs) {
  const mps = mountPoints();
  if (mps) {
    let best = null;
    for (const m of mps) if ((abs === m || abs.startsWith(m === '/' ? '/' : m + '/')) && (!best || m.length > best.length)) best = m;
    if (best && (best === ROOT || best.startsWith(ROOT + '/'))) return best;
    return ROOT; // item no próprio sistema de arquivos do contêiner, abaixo de ROOT
  }
  // sem /proc/mounts: sobe enquanto o dispositivo (st.dev) for o mesmo
  const dev = (await fsp.stat(abs)).dev;
  let cur = path.dirname(abs);
  while (cur !== ROOT) {
    const parent = path.dirname(cur);
    const ps = await statSafe(parent);
    if (!ps || ps.dev !== dev) break;
    cur = parent;
  }
  return cur;
}
async function loadTrash() { const t = await loadJSON(TRASH_FILE, []); return Array.isArray(t) ? t : []; }

async function fsAction(action, body) {
  try {
    switch (action) {
      case 'mkdir': {
        const dir = resolveSafe(body.path || '');
        if (dir === ROOT) throw new HttpError(400, 'Crie a pasta dentro de um volume (DATA, Discos…)');
        const name = validName(body.name);
        await fsp.mkdir(path.join(dir, name));
        return { ok: true, path: relOf(path.join(dir, name)) };
      }
      case 'rename': {
        const abs = editablePath(body.path);
        const name = validName(body.name);
        const to = path.join(path.dirname(abs), name);
        if (to === abs) return { ok: true, moved: [] };
        if (await exists(to) && to.toLowerCase() !== abs.toLowerCase()) throw new HttpError(409, 'Já existe um item com esse nome');
        await fsp.rename(abs, to);
        const pair = [relOf(abs), relOf(to)];
        await relocate([pair]);
        return { ok: true, moved: [pair] };
      }
      case 'rename-many': {
        // renomear em lote: valida tudo antes, depois renomeia em duas fases (via nomes temporários),
        // o que permite trocas como A→B e B→A; se algo falhar no meio, desfaz.
        const list = [];
        for (const it of body.items || []) {
          const abs = editablePath(it.path);
          const name = validName(it.name);
          const to = path.join(path.dirname(abs), name);
          if (to !== abs) list.push({ abs, to });
        }
        if (!list.length) return { ok: true, moved: [] };
        const sources = new Set(list.map((x) => x.abs));
        const targets = new Set();
        for (const x of list) {
          if (targets.has(x.to)) throw new HttpError(409, `Nome repetido no lote: ${path.basename(x.to)}`);
          targets.add(x.to);
          if (!sources.has(x.to) && (await exists(x.to)) && x.to.toLowerCase() !== x.abs.toLowerCase()) {
            throw new HttpError(409, `Já existe: ${path.basename(x.to)}`);
          }
          await fsp.access(path.dirname(x.abs), fs.constants.W_OK);
        }
        const tag = crypto.randomBytes(4).toString('hex');
        const staged = []; // { abs, tmp, to }
        try {
          for (let i = 0; i < list.length; i++) {
            const tmp = path.join(path.dirname(list[i].abs), `.zv-ren-${tag}-${i}`);
            await fsp.rename(list[i].abs, tmp);
            staged.push({ ...list[i], tmp, done: false });
          }
          for (const st of staged) { await fsp.rename(st.tmp, st.to); st.done = true; }
        } catch (e) {
          for (const st of staged.reverse()) {
            try { await fsp.rename(st.done ? st.to : st.tmp, st.abs); } catch { /* melhor esforço */ }
          }
          throw e;
        }
        const pairs = list.map((x) => [relOf(x.abs), relOf(x.to)]);
        await relocate(pairs);
        return { ok: true, moved: pairs };
      }
      case 'move': {
        const dest = resolveSafe(body.dest || '');
        const ds = await statSafe(dest);
        if (!ds || !ds.isDirectory()) throw new HttpError(400, 'Pasta de destino inválida');
        // ROOT só contém os volumes (DATA, Discos…): algo movido para lá ficaria no contêiner e se perderia
        if (dest === ROOT) throw new HttpError(400, 'Escolha uma pasta dentro de um volume (DATA, Discos…)');
        const moved = []; const errors = [];
        for (const rel of body.paths || []) {
          try {
            const abs = editablePath(rel);
            if (dest === abs || dest.startsWith(abs + path.sep)) throw new HttpError(400, 'Não dá para mover uma pasta para dentro dela mesma');
            if (path.dirname(abs) === dest) continue;
            const to = path.join(dest, await freeName(dest, path.basename(abs)));
            await moveFs(abs, to);
            moved.push([relOf(abs), relOf(to)]);
          } catch (e) { errors.push(`${path.posix.basename(String(rel))}: ${fsError(e).message}`); }
        }
        if (moved.length) await relocate(moved);
        return { ok: !errors.length, moved, errors };
      }
      case 'delete': {
        const trash = await loadTrash(); const done = []; const errors = [];
        for (const rel of body.paths || []) {
          try {
            const abs = editablePath(rel);
            const st = await fsp.stat(abs);
            await fsp.access(path.dirname(abs), fs.constants.W_OK); // pasta somente leitura → erro claro (EROFS)
            const tdir = path.join(await mountRoot(abs), TRASH_DIR);
            await fsp.mkdir(tdir, { recursive: true });
            const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
            const stored = path.join(tdir, `${id}-${path.basename(abs)}`);
            await fsp.rename(abs, stored);
            const r = relOf(abs);
            const saved = await forget([r]);
            trash.push({ id, original: r, stored: relOf(stored), name: path.basename(abs), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, deletedAt: Date.now(), saved });
            done.push(r);
          } catch (e) { errors.push(`${path.posix.basename(String(rel))}: ${fsError(e).message}`); }
        }
        await saveJSON(TRASH_FILE, trash);
        return { ok: !errors.length, deleted: done, errors };
      }
      case 'trash': return { items: (await loadTrash()).map(({ saved, ...t }) => t).reverse() };
      case 'restore': {
        const trash = await loadTrash(); const restored = []; const errors = [];
        for (const id of body.ids || []) {
          const i = trash.findIndex((t) => t.id === id); if (i < 0) continue;
          const t = trash[i];
          try {
            const target = resolveSafe(t.original);
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const to = path.join(path.dirname(target), await freeName(path.dirname(target), path.basename(target)));
            await fsp.rename(resolveSafe(t.stored), to);
            const newRel = relOf(to);
            // devolve favoritos e tags (ajustando o caminho se precisou de outro nome)
            const favs = await loadFavorites(); const db = await loadTags();
            const fix = (p) => (p === t.original ? newRel : p.startsWith(t.original + '/') ? newRel + p.slice(t.original.length) : p);
            for (const f of (t.saved && t.saved.favs) || []) favs.push({ ...f, path: fix(f.path) });
            for (const [k, v] of Object.entries((t.saved && t.saved.tags) || {})) db.items[fix(k)] = v;
            const vdb = await loadViews();
            for (const [k, v] of Object.entries((t.saved && t.saved.views) || {})) vdb[fix(k)] = v;
            await saveViews(true);
            await saveFavorites(); await saveTags();
            trash.splice(i, 1); restored.push(newRel);
          } catch (e) { errors.push(`${t.name}: ${fsError(e).message}`); }
        }
        await saveJSON(TRASH_FILE, trash); indexBuiltAt = 0;
        return { ok: !errors.length, restored, errors };
      }
      case 'purge': {
        const trash = await loadTrash();
        const ids = body.all ? trash.map((t) => t.id) : (body.ids || []);
        const keep = [];
        for (const t of trash) {
          if (!ids.includes(t.id)) { keep.push(t); continue; }
          try { await fsp.rm(resolveSafe(t.stored), { recursive: true, force: true }); } catch (e) { keep.push(t); }
        }
        await saveJSON(TRASH_FILE, keep);
        return { ok: true, remaining: keep.length };
      }
      default: throw new HttpError(404, 'Ação desconhecida');
    }
  } catch (e) { throw fsError(e); }
}

// ---------------------------------------------------------------- pessoas
// Duas fontes de sugestão de tags de pessoa (tags marcadas como "pessoa"):
//  1) nome do arquivo: procura o nome/apelidos da pessoa no nome do arquivo (sem acentos, pontuação etc.)
//  2) rosto: um "ajudante" no PC analisa quadros dos vídeos (detecção SCRFD + assinatura ArcFace) e manda
//     as assinaturas dos rostos. Aqui elas são agrupadas (rostos parecidos) e comparadas com as pessoas que
//     o usuário nomeou. O NAS não faz o trabalho pesado: só guarda e compara (produto escalar de vetores).
const PEOPLE_DIR = path.join(DATA_DIR, 'faces');
const PEOPLE_FILE = path.join(DATA_DIR, 'people.json');
const WORKER_FILE = path.join(DATA_DIR, 'worker.json');
const FACE_MATCH = 0.42;   // semelhança mínima para sugerir uma pessoa (ArcFace: mesma pessoa ~0,5–0,99; outra < 0,3)
const FACE_CLUSTER = 0.5;  // semelhança mínima para juntar rostos sem nome no mesmo grupo
fs.mkdirSync(path.join(PEOPLE_DIR, 'v'), { recursive: true });
fs.mkdirSync(path.join(PEOPLE_DIR, 'c'), { recursive: true });

const faceVideos = new Map(); // path -> { key, at, frames, faces: [{ id, t, score, n, emb: Float32Array }] }
const faceById = new Map();   // id -> { path, face }
let peopleDb = { refs: {}, ignored: {}, excluded: [], auto: {}, neg: {}, answered: {}, blocked: {}, notPerson: {}, nameExcluded: [], nameIgnored: {}, nameRejected: {}, compressExcluded: [] };
// nameExcluded: pastas fora da busca pelo nome do arquivo; nameIgnored: chave do nome -> nome ("não é nome de pessoa");
// nameRejected: 'caminho|tag' -> 1 (o nome no arquivo não é esta pessoa)
// auto: faceId -> tag (aprendido sozinho pelas tags); answered: 'path|tag' -> resposta do usuário;
// blocked: 'tag|faceId' -> rosto que o usuário disse não ser a pessoa; notPerson: tag -> 1 (não perguntar se é pessoa) // refs: tag -> [faceId]; ignored: faceId -> 1; excluded: pastas fora da análise de rosto
// pasta (ou algo dentro dela) excluída da análise de rosto?
const faceExcluded = (rel) => peopleDb.excluded.some((x) => rel === x || rel.startsWith(x + '/'));
const nameExcluded = (rel) => peopleDb.nameExcluded.some((x) => rel === x || rel.startsWith(x + '/'));
// compressExcluded: pastas que o compressor nunca mexe
const compressExcluded = (rel) => peopleDb.compressExcluded.some((x) => rel === x || rel.startsWith(x + '/'));
let clusterCache = null;   // grupos sem nome como a tela mostra (derivados da base; baratos de refazer)
let clusterBase = null;    // agrupamento completo (caro): refeito quando chegam rostos novos ou por trás, com o app parado
let clusterRebuildTimer = null;
let faceVer = 0;               // muda quando chegam ou saem rostos
let peopleVer = 0;             // muda a cada alteração em people.json
let protoSeq = 0;
const groupRows = new Map();   // rel -> [{ key, rel, ids, mean, n, sims: Map(tag -> [versão, semelhança]) }]
const b64ToEmb = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); };
const embToB64 = (e) => Buffer.from(e.buffer, e.byteOffset, e.byteLength).toString('base64');
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const videoFile = (rel) => path.join(PEOPLE_DIR, 'v', sha1(rel).slice(0, 2), sha1(rel) + '.json');

function indexFaces(rel, rec) {
  const old = faceVideos.get(rel);
  if (old) for (const f of old.faces) faceById.delete(f.id);
  groupRows.delete(rel); faceVer++;
  if (clusterBase) clusterBase.dirty.add(rel);
  if (!rec) { faceVideos.delete(rel); clusterCache = null; return; }
  faceVideos.set(rel, rec);
  for (const f of rec.faces) faceById.set(f.id, { path: rel, face: f });
  clusterCache = null;
}
(function loadFaces() {
  try {
    for (const d of fs.readdirSync(path.join(PEOPLE_DIR, 'v'))) {
      for (const f of fs.readdirSync(path.join(PEOPLE_DIR, 'v', d))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(PEOPLE_DIR, 'v', d, f), 'utf8'));
          indexFaces(j.path, { key: j.key, at: j.at, frames: j.frames, status: j.status, v: j.v || 1, faces: (j.faces || []).map((x) => ({ ...x, emb: b64ToEmb(x.emb) })),
            groups: (j.groups || []).map((g) => ({ ...g, tpl: b64ToEmb(g.tpl) })) });
        } catch { /* arquivo corrompido: ignora */ }
      }
    }
  } catch { /* sem dados */ }
  try { const j = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8')); peopleDb = { refs: j.refs || {}, ignored: j.ignored || {}, excluded: j.excluded || [], auto: j.auto || {}, neg: j.neg || {}, answered: j.answered || {}, blocked: j.blocked || {}, notPerson: j.notPerson || {}, nameExcluded: j.nameExcluded || [], nameIgnored: j.nameIgnored || {}, nameRejected: j.nameRejected || {}, compressExcluded: j.compressExcluded || [] }; } catch { /* vazio */ }
})();
async function saveFaceVideo(rel, rec) {
  const file = videoFile(rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await saveJSON(file, { path: rel, key: rec.key, at: rec.at, frames: rec.frames, status: rec.status, v: rec.v || 1,
    faces: rec.faces.map((f) => ({ ...f, emb: embToB64(f.emb) })), groups: (rec.groups || []).map((g) => ({ ...g, tpl: embToB64(g.tpl) })) });
}
const savePeople = () => {
  clusterCache = null; peopleVer++;
  // a base de grupos é refeita por trás, 45 s depois da última mudança (para quem perdeu o nome voltar aos grupos)
  clearTimeout(clusterRebuildTimer);
  clusterRebuildTimer = setTimeout(() => { if (clusterBase && clusterBase.pv !== peopleVer) { clusterBase = null; clusterCache = null; try { faceClusters(); } catch { /* ignora */ } } }, 45000);
  return saveJSON(PEOPLE_FILE, peopleDb);
};
async function peopleTagRenamed(from, to) {
  // respostas ('caminho|tag') e bloqueios ('tag|rosto') acompanham a tag renomeada/juntada
  for (const k of ['answered', 'nameRejected']) {
    for (const key of Object.keys(peopleDb[k])) {
      const i = key.lastIndexOf('|'); if (key.slice(i + 1) !== from) continue;
      const v = peopleDb[k][key]; delete peopleDb[k][key];
      if (to) peopleDb[k][`${key.slice(0, i)}|${to}`] = v;
    }
  }
  for (const key of Object.keys(peopleDb.blocked)) {
    const i = key.lastIndexOf('|'); if (key.slice(0, i) !== from) continue;
    delete peopleDb.blocked[key];
    if (to) peopleDb.blocked[`${to}|${key.slice(i + 1)}`] = 1;
  }
  for (const [id, t] of Object.entries(peopleDb.auto)) if (t === from) { if (to) peopleDb.auto[id] = to; else delete peopleDb.auto[id]; }
  delete peopleDb.notPerson[from];
  if (!peopleDb.refs[from]) { await savePeople(); return; }
  if (to) peopleDb.refs[to] = [...new Set([...(peopleDb.refs[to] || []), ...peopleDb.refs[from]])];
  delete peopleDb.refs[from];
  await savePeople();
}
// renomear/mover/excluir arquivos: os rostos acompanham
async function peopleRelocate(pairs, removed = []) {
  const map = (p) => { for (const [a, b] of pairs) { if (p === a) return b; if (p.startsWith(a + '/')) return b + p.slice(a.length); } return null; };
  let moved = false;
  for (const k of ['excluded', 'nameExcluded', 'compressExcluded']) {
    const ex = peopleDb[k].map((x) => map(x) ?? x).filter((x) => !removed.some((a) => x === a || x.startsWith(a + '/')));
    if (ex.join('\n') !== peopleDb[k].join('\n')) { peopleDb[k] = ex; moved = true; }
  }
  for (const k of ['answered', 'nameRejected']) {
    for (const key of Object.keys(peopleDb[k])) {
      const i = key.lastIndexOf('|'); const p = key.slice(0, i); const n = map(p);
      const gone = removed.some((x) => p === x || p.startsWith(x + '/'));
      if (n === null && !gone) continue;
      const v = peopleDb[k][key]; delete peopleDb[k][key]; moved = true;
      if (n !== null) peopleDb[k][`${n}|${key.slice(i + 1)}`] = v;
    }
  }
  if (moved) await savePeople();
  for (const [rel, rec] of [...faceVideos.entries()]) {
    const n = map(rel);
    const gone = removed.some((a) => rel === a || rel.startsWith(a + '/'));
    if (n === null && !gone) continue;
    fs.rm(videoFile(rel), { force: true }, () => {});
    indexFaces(rel, null);
    if (n !== null) { indexFaces(n, rec); await saveFaceVideo(n, rec); }
  }
}

// ===================================================================== índice de grupos
// Cada "linha" é uma pessoa dentro de um vídeo (o ajudante já agrupa os rostos do mesmo vídeo), com a
// semelhança dela a cada pessoa conhecida guardada em cache. Quando os rostos de referência de UMA pessoa
// mudam, só a coluna dessa pessoa é recalculada — por isso confirmar/recusar é rápido mesmo com milhares de vídeos.
function rowsOf(rel) {
  let r = groupRows.get(rel);
  if (r === undefined) {
    const gs = videoGroups(rel);
    r = gs ? gs.map((g, i) => ({ key: `${rel}#${i}`, rel, ids: g.ids, mean: g.mean, n: g.n, q: g.q, sims: new Map() })) : [];
    groupRows.set(rel, r);
  }
  return r;
}
function allRows() {
  const out = [];
  for (const rel of faceVideos.keys()) if (!faceExcluded(rel) && !inCacheRel(rel)) for (const r of rowsOf(rel)) out.push(r);
  return out;
}
// protótipos de cada pessoa: até 12 rostos de referência bem diferentes entre si (cobre ângulos e idades)
function pickDiverse(embs, k) {
  if (embs.length <= k) return embs;
  const out = [embs[0]]; const near = embs.map((e) => dot(e, embs[0]));
  while (out.length < k) {
    let bi = -1; let bv = 2;
    for (let i = 0; i < embs.length; i++) if (near[i] < bv) { bv = near[i]; bi = i; }
    if (bi < 0 || bv > 0.97) break;
    out.push(embs[bi]);
    for (let i = 0; i < embs.length; i++) { const x = dot(embs[i], embs[bi]); if (x > near[i]) near[i] = x; }
  }
  return out;
}
// Cada pessoa tem: protótipos (rostos de referência bem diferentes entre si), o "centro" dela e exemplos
// negativos (rostos que o usuário disse NÃO serem ela). Rostos de referência que destoam do resto
// (provavelmente marcados errado, ou de baixa qualidade) ficam de fora da comparação.
const protoCache = new Map(); // tag -> { key, pv, fv, ver, embs, center, negs, bad: Set(ids suspeitos) }
function normalized(sum) { let n = 0; for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i]; n = Math.sqrt(n) || 1; return sum.map((x) => x / n); }
function protosOf(tag) {
  let c = protoCache.get(tag);
  if (c && c.pv === peopleVer && c.fv === faceVer) return c;
  const ids = (peopleDb.refs[tag] || []).filter((id) => faceById.has(id));
  const nids = (peopleDb.neg[tag] || []).filter((id) => faceById.has(id));
  const key = ids.join(',') + '|' + nids.join(',');
  if (c && c.key === key) { c.pv = peopleVer; c.fv = faceVer; return c; }
  const faces = ids.map((id) => faceById.get(id).face);
  const negs = pickDiverse(nids.map((id) => faceById.get(id).face.emb), 60);
  const bad = new Set();
  let good = faces;
  if (faces.length >= 3) {
    // centro robusto: média dos rostos mais "concordantes" (cada um comparado com todos os outros)
    const agree = faces.map((f, i) => { const xs = faces.map((g, j) => (i === j ? -1 : dot(f.emb, g.emb))).sort((a, b) => b - a); const k = Math.max(1, Math.ceil((faces.length - 1) / 2)); return xs.slice(0, k).reduce((a, b) => a + b, 0) / k; });
    const sorted = [...agree].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (let i = 0; i < faces.length; i++) {
      const negHit = negs.length ? refSim(faces[i].emb, negs) : -1;
      if (agree[i] < Math.max(0.28, med - 0.18) || negHit >= 0.6) bad.add(faces[i].id);
    }
    if (bad.size < faces.length) good = faces.filter((f) => !bad.has(f.id)); else bad.clear();
  }
  const sum = new Float32Array(512);
  for (const f of good) { const w = Math.max(0.05, f.q != null ? f.q : 0.6) ** 2; for (let i = 0; i < 512; i++) sum[i] += f.emb[i] * w; }
  c = { key, pv: peopleVer, fv: faceVer, ver: ++protoSeq, embs: pickDiverse(good.map((f) => f.emb), 12), center: good.length ? normalized(sum) : null, negs, bad };
  // limite próprio da pessoa: se rostos que você disse NÃO serem ela pontuam alto, a exigência sobe
  // (pessoas com sósias/irmãos ficam mais exigentes; as fáceis continuam no limite padrão)
  c.thr = FACE_MATCH;
  if (negs.length >= 2 && c.embs.length) {
    const ns = negs.map((e) => scoreFor(e, { ...c, negs: [] })).sort((a, b) => a - b);
    const p90 = ns[Math.min(ns.length - 1, Math.floor(ns.length * 0.9))];
    c.thr = Math.min(0.62, Math.max(FACE_MATCH, p90 + 0.03));
  }
  protoCache.set(tag, c);
  return c;
}
const refTags = () => Object.keys(peopleDb.refs).filter((t) => protosOf(t).embs.length);
// Pontuação de um rosto para uma pessoa. Não basta parecer com UM rosto de referência (um único rosto
// errado fazia muita gente diferente "virar" a pessoa): precisa concordar com o segundo mais parecido e com
// o centro dela; e perde se for mais parecido com um exemplo negativo dela.
function scoreFor(mean, p) {
  if (!p.embs.length) return -1;
  // atalho: a pontuação nunca passa de "centro + 0,12"; se nem assim chega perto dos limites usados,
  // não precisa comparar com todos os rostos de referência (deixa tudo ~10x mais rápido)
  if (p.center && p.embs.length > 1) { const c0 = dot(mean, p.center); if (c0 + 0.12 < 0.26) return c0 + 0.12 - 0.3; }
  let s1 = -1; let s2 = -1;
  for (const e of p.embs) { const x = dot(mean, e); if (x > s1) { s2 = s1; s1 = x; } else if (x > s2) s2 = x; }
  let sc;
  if (p.embs.length === 1) sc = s1;
  else {
    const c = p.center ? dot(mean, p.center) : s1;
    sc = Math.min(s1, (s1 + Math.max(s2, -1)) / 2 + 0.06, c + 0.12);
  }
  if (p.negs.length && refSim(mean, p.negs) >= sc - 0.02) sc -= 0.3; // parece mais com quem NÃO é ela
  return sc;
}
function simTo(row, tag) {
  const p = protosOf(tag);
  const c = row.sims.get(tag);
  if (c && c[0] === p.ver) return c[1];
  const v = scoreFor(row.mean, p);
  row.sims.set(tag, [p.ver, v]);
  return v;
}
// melhor pessoa para um rosto, exigindo uma folga sobre a segunda colocada (pessoas parecidas não se confundem)
function bestOf(row, tags) {
  let tag = null; let sim = -1; let second = -1;
  for (const t of tags) { const v = simTo(row, t); if (v > sim) { second = sim; sim = v; tag = t; } else if (v > second) second = v; }
  if (tag && second > 0 && sim - second < 0.05) sim = Math.min(sim, FACE_MATCH - 0.01); // empate: não decide
  return { tag, sim };
}
const allIgnored = (row) => row.ids.every((id) => peopleDb.ignored[id]);


// ===================================================================== compressor
// Deixa os vídeos menores SEM bagunçar a organização: a versão comprimida fica no mesmo lugar, com o mesmo
// nome e a mesma data; tags, rostos, visualizações e favoritos continuam valendo. O original vai para a
// Lixeira (dá para restaurar) — o espaço é liberado ao esvaziar a lixeira.
// O trabalho pesado pode ser feito pelo ajudante no PC (bem mais rápido) ou pelo próprio NAS (devagar).
let lastWorkerSeen = 0; let lastCompressWorker = 0;
const COMPRESS_FILE = path.join(DATA_DIR, 'compress.json');
let compressDb = null;
async function loadCompress() {
  if (!compressDb) {
    compressDb = await loadJSON(COMPRESS_FILE, { items: [] });
    if (!Array.isArray(compressDb.items)) compressDb.items = [];
    for (const it of compressDb.items) if (it.status === 'working') { it.status = 'queued'; it.pct = 0; it.by = null; }
  }
  return compressDb;
}
let compressSaveT = null;
function saveCompress(now = false) {
  clearTimeout(compressSaveT);
  if (now) return saveJSON(COMPRESS_FILE, compressDb);
  compressSaveT = setTimeout(() => saveJSON(COMPRESS_FILE, compressDb).catch(() => {}), 2000);
  return Promise.resolve();
}
// alvo de taxa (bits/s) por altura do vídeo, só para estimar a economia antes de comprimir
const COMPRESS_PRESETS = {
  h264: { nome: 'Compatível (H.264)', codec: 'h264', crf: 23, rate: [[2160, 14e6], [1440, 8e6], [1080, 4.5e6], [720, 2.3e6], [480, 1.2e6], [0, 0.8e6]] },
  h265: { nome: 'Economia (H.265)', codec: 'hevc', crf: 26, rate: [[2160, 7e6], [1440, 4.5e6], [1080, 2.5e6], [720, 1.3e6], [480, 0.75e6], [0, 0.5e6]] },
  av1: { nome: 'Máxima economia (AV1)', codec: 'av1', crf: 32, rate: [[2160, 5e6], [1440, 3.2e6], [1080, 1.8e6], [720, 1e6], [480, 0.55e6], [0, 0.4e6]] },
};
// codificadores que o ffmpeg do NAS tem (AV1 no NAS só se tiver o SVT-AV1; e é bem lento)
let nasEncoders = new Set();
run(FFMPEG, ['-hide_banner', '-encoders'], { timeout: 15000 }).then((b) => {
  nasEncoders = new Set(String(b).split('\n').map((l) => (l.trim().split(/\s+/)[1] || '')).filter(Boolean));
}).catch(() => {});
// níveis de qualidade: nota VMAF alvo (o ajudante do PC mede de verdade em trechos do vídeo e escolhe o ajuste
// mais econômico que atinge a nota; o NAS usa o ajuste típico do nível). 95 ≈ visualmente igual ao original.
const COMPRESS_QUALITY = {
  alta: { nome: 'Visualmente igual', vmaf: 95, crf: { h264: 22, hevc: 25, av1: 32 }, rate: 1 },
  equilibrada: { nome: 'Equilibrada', vmaf: 93, crf: { h264: 24, hevc: 27, av1: 35 }, rate: 0.85 },
  economica: { nome: 'Econômica', vmaf: 90, crf: { h264: 26, hevc: 29, av1: 38 }, rate: 0.7 },
};
const qualityOf = (q) => COMPRESS_QUALITY[q] || COMPRESS_QUALITY.alta;
const targetRate = (preset, h) => (COMPRESS_PRESETS[preset].rate.find(([k]) => h >= k * 0.9) || [0, 0.5e6])[1];
const MP4_AUDIO = ['aac', 'mp3', 'ac3', 'eac3'];
const MKV_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'vorbis', 'dts', 'truehd'];

async function compressPlan(rel, preset, maxh, quality = 'alta', force = false) {
  const abs = resolveSafe(rel); const st = await statSafe(abs);
  const name = path.posix.basename(rel);
  if (!st || !st.isFile() || typeOf(abs) !== 'video') return null;
  let info; try { info = await probe(abs); } catch { return { path: rel, name, size: st.size, skip: 'não consegui ler o vídeo' }; }
  if (!info.video || !info.duration) return { path: rel, name, size: st.size, skip: 'sem vídeo para comprimir' };
  // "altura" para estimar = o lado menor (vídeo deitado ou em pé, 1080p é 1080p)
  const h = Math.min(info.video.width, info.video.height);
  const outH = maxh && h > maxh ? maxh : h;
  const aTracks = Math.min(2, info.audio.length);
  const est = Math.round((targetRate(preset, outH) * qualityOf(quality).rate + aTracks * 0.13e6) * info.duration / 8 * 1.03);
  const plan = { path: rel, name, size: st.size, mtime: st.mtimeMs, duration: Math.round(info.duration), codec: info.video.codec, width: info.video.width, height: info.video.height,
    bitrate: Math.round(info.bitrate || st.size * 8 / info.duration), est: Math.min(est, st.size), outH };
  if (preset === 'h264' && ['hevc', 'av1', 'vp9'].includes(info.video.codec)) plan.skip = 'já usa um formato mais eficiente';
  else if (preset === 'h265' && info.video.codec === 'av1') plan.skip = 'já está em AV1';
  else if (preset === 'av1' && info.video.codec === 'av1' && plan.est >= st.size * 0.8) plan.skip = 'já está em AV1';
  else if (plan.est >= st.size * 0.8) plan.skip = 'já está compacto';
  // "comprimir mesmo se não atingir o padrão": não pula por estimativa (só a troca final exige ficar menor)
  if (force && plan.skip) { plan.note = plan.skip; delete plan.skip; }
  return plan;
}
// receita do ffmpeg (a mesma para o NAS e para o ajudante; o ajudante pode trocar só o codificador de vídeo)
// áudio: copia o que já é eficiente; o que é pesado (sem perda, PCM, DTS, TrueHD…) ou não cabe no MP4 vira Opus
// (eficiente e transparente por volta de 128 kb/s em estéreo)
const HEAVY_AUDIO = /^(pcm_|flac|alac|truehd|mlp|dts|wmav|wmapro|ape|tta|wavpack)/;
function audioArgs(info, mkv) {
  const out = [];
  info.audio.forEach((a, i) => {
    const okBox = (mkv ? MKV_AUDIO : MP4_AUDIO).includes(a.codec);
    const heavy = HEAVY_AUDIO.test(a.codec || '') || (a.bitrate && a.bitrate > Math.max(2, a.channels || 2) * 170000);
    if (okBox && !heavy) { out.push(`-c:a:${i}`, 'copy'); return; }
    const ch = a.channels || 2;
    const br = ch <= 2 ? '128k' : ch <= 6 ? '256k' : '384k';
    out.push(`-c:a:${i}`, 'libopus', `-b:a:${i}`, br);
    if (ch > 2) out.push(`-filter:a:${i}`, 'aformat=channel_layouts=7.1|5.1|stereo', `-mapping_family:a:${i}`, '1');
  });
  return out;
}
function compressSpec(info, rel, preset, maxh, quality = 'alta', measure = false, force = false) {
  const ext = path.extname(rel).toLowerCase();
  const mkv = ext === '.mkv';
  const outExt = mkv ? '.mkv' : '.mp4';
  const maps = ['-map', '0:v:0', '-map', '0:a?'];
  const post = [...audioArgs(info, mkv)];
  if (mkv) { maps.push('-map', '0:s?', '-map', '0:t?'); post.push('-c:s', 'copy', '-c:t', 'copy'); }
  else {
    const textSubs = info.subs.filter((sb) => sb.text);
    for (const sb of textSubs) maps.push('-map', `0:s:${sb.index}`);
    if (textSubs.length) post.push('-c:s', 'mov_text');
    post.push('-movflags', '+faststart');
  }
  post.push('-map_metadata', '0', '-map_chapters', '0');
  // limite de resolução vale para o lado menor (vídeo em pé continua em pé)
  const portrait = info.video.height > info.video.width;
  const h = Math.min(info.video.width, info.video.height); const scale = maxh && h > maxh ? maxh : 0;
  const codec = COMPRESS_PRESETS[preset].codec; const Q = qualityOf(quality);
  // quadro-chave a cada ~10 s (busca rápida no player sem desperdiçar bits)
  const gop = Math.max(24, Math.min(600, Math.round((info.video.fps || 30) * 10)));
  return { outExt, maps, post, v: { codec, crf: Q.crf[codec], vmaf: Q.vmaf, measure: !!measure, force: !!force, gop, scale, portrait, tenbit: /10/.test(info.video.pix_fmt || ''),
    width: info.video.width, height: info.video.height } };
}
function ffArgsFor(spec, input, output) {
  const v = spec.v;
  const vf = []; if (v.scale) vf.push(v.portrait ? `scale=${v.scale}:-2` : `scale=-2:${v.scale}`);
  // velocidade de sempre (presets rápidos); 10 bits só quando o vídeo já é 10 bits (HDR)
  const g = String(v.gop || 240);
  const venc = v.codec === 'av1'
    ? ['-c:v', 'libsvtav1', '-crf', String(v.crf), '-preset', '8', '-g', g, '-pix_fmt', v.tenbit ? 'yuv420p10le' : 'yuv420p', '-svtav1-params', 'tune=0']
    : v.codec === 'hevc'
      ? ['-c:v', 'libx265', '-crf', String(v.crf), '-preset', 'medium', '-tag:v', 'hvc1', '-pix_fmt', v.tenbit ? 'yuv420p10le' : 'yuv420p',
        '-x265-params', `log-level=error:aq-mode=3:no-sao=1:keyint=${g}`]
      : ['-c:v', 'libx264', '-crf', String(v.crf), '-preset', 'medium', '-g', g, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-aq-mode', '3'];
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input, ...spec.maps, ...(vf.length ? ['-vf', vf.join(',')] : []), ...venc, ...spec.post,
    '-progress', 'pipe:1', '-nostats', output];
}
const compressTmp = (abs, id, outExt) => path.join(path.dirname(abs), `.zima-comprimindo-${id}${outExt}`);

// troca segura: confere o arquivo novo, guarda o original na lixeira e põe o novo no mesmo lugar
async function finishCompress(it, tmpAbs) {
  const abs = resolveSafe(it.path);
  const st0 = await statSafe(abs);
  if (!st0) throw new Error('o original não existe mais');
  if (st0.size !== it.origSize) throw new Error('o original mudou durante a compressão');
  const st1 = await statSafe(tmpAbs);
  if (!st1 || !st1.size) throw new Error('o arquivo comprimido não chegou');
  let i0; let i1;
  try { i0 = await probe(abs); i1 = await probe(tmpAbs); } catch { throw new Error('o arquivo comprimido está com defeito'); }
  if (!i1.video || Math.abs(i1.duration - i0.duration) > Math.max(2, i0.duration * 0.01)) throw new Error('o arquivo comprimido ficou incompleto');
  if (st1.size >= st0.size * (it.force ? 1 : 0.92)) { // forçado: basta ficar menor que o original
    await fsp.rm(tmpAbs, { force: true });
    it.status = 'skipped'; it.note = 'não ficou menor — mantive o original'; it.newSize = st1.size; return;
  }
  const outExt = path.extname(tmpAbs);
  let finalAbs = abs;
  if (outExt.toLowerCase() !== path.extname(abs).toLowerCase()) {
    const want = abs.slice(0, -path.extname(abs).length) + outExt;
    finalAbs = (await statSafe(want)) ? path.join(path.dirname(abs), await freeName(path.dirname(abs), path.basename(want))) : want;
  }
  if (it.trash !== false) {
    const tdir = path.join(await mountRoot(abs), TRASH_DIR);
    await fsp.mkdir(tdir, { recursive: true });
    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const stored = path.join(tdir, `${id}-${path.basename(abs)}`);
    await fsp.rename(abs, stored);
    const trash = await loadTrash();
    trash.push({ id, original: relOf(abs), stored: relOf(stored), name: path.basename(abs), dir: false, size: st0.size, deletedAt: Date.now(), saved: {}, note: 'original antes de comprimir' });
    await saveJSON(TRASH_FILE, trash);
  } else await fsp.rm(abs, { force: true });
  await fsp.rename(tmpAbs, finalAbs);
  await fsp.utimes(finalAbs, st0.atime, st0.mtime).catch(() => {}); // mesma data: a ordem por data não muda
  if (finalAbs !== abs) await relocate([[relOf(abs), relOf(finalAbs)]]);
  listCache.clear(); indexBuiltAt = 0;
  it.status = 'done'; it.newSize = st1.size; it.finalPath = relOf(finalAbs); it.pct = 100;
}

async function compressAdd({ paths = [], preset = 'h265', maxh = 0, where = 'auto', trash = true, quality = 'alta', measure = false, force = false }) {
  if (!COMPRESS_PRESETS[preset]) throw new HttpError(400, 'Formato inválido');
  const db = await loadCompress();
  const queued = new Set(db.items.filter((i) => ['queued', 'working'].includes(i.status)).map((i) => i.path));
  let n = 0;
  for (const rel0 of await expandVideos(paths)) {
    if (queued.has(rel0)) continue;
    const plan = await compressPlan(rel0, preset, +maxh || 0, quality, !!force);
    if (!plan || plan.skip) continue;
    db.items.push({ id: crypto.randomBytes(5).toString('hex'), path: rel0, name: plan.name, preset, quality: COMPRESS_QUALITY[quality] ? quality : 'alta', measure: !!measure, force: !!force, maxh: +maxh || 0, where, trash: trash !== false,
      status: 'queued', pct: 0, origSize: plan.size, est: plan.est, duration: plan.duration, added: Date.now() });
    n++;
  }
  await saveCompress(true);
  setTimeout(compressTick, 500);
  return { ok: true, added: n };
}
// pastas viram a lista dos vídeos dentro delas (e das subpastas)
async function expandVideos(paths, stats = {}) {
  const out = new Set(); const idx = await getIndex(); const skipped = new Set();
  const take = (p) => { if (compressExcluded(p)) skipped.add(p); else out.add(p); };
  for (const p of paths) {
    const rel = relOf(resolveSafe(p)); const st = await statSafe(path.join(ROOT, rel));
    if (!st) continue;
    if (st.isDirectory()) { for (const it of idx) if (it.t === 'video' && (rel === '' || it.p.startsWith(rel + '/')) && !inCacheRel(it.p)) take(it.p); }
    else if (typeOf(rel) === 'video') take(rel);
  }
  stats.excluded = skipped.size; // vídeos em pastas excluídas da compressão (ficam de fora)
  return [...out].slice(0, 5000);
}
async function compressEstimate({ paths = [], preset = 'h265', maxh = 0, quality = 'alta', force = false }) {
  const stats = {};
  const list = (await expandVideos(paths, stats)).slice(0, 2000);
  const items = [];
  for (const rel of list) { const pl = await compressPlan(rel, preset, +maxh || 0, quality, !!force); if (pl) items.push(pl); }
  const go = items.filter((x) => !x.skip);
  return { items: items.slice(0, 500), count: items.length, todo: go.length, size: go.reduce((a, x) => a + x.size, 0), est: go.reduce((a, x) => a + x.est, 0), skipped: items.length - go.length,
    excluded: stats.excluded || 0 };
}
async function compressStatus() {
  const db = await loadCompress();
  const done = db.items.filter((i) => i.status === 'done');
  return {
    items: db.items.slice(-400).reverse(),
    saved: done.reduce((a, i) => a + (i.origSize - i.newSize), 0),
    queued: db.items.filter((i) => i.status === 'queued').length,
    working: db.items.filter((i) => i.status === 'working').length,
    pc: Date.now() - lastCompressWorker < 3 * 60000, nas: !!compressLocal, nasAv1: nasEncoders.has('libsvtav1'),
    pcs: ((await loadJSON(WORKER_FILE, { tokens: [] })).tokens || []).filter((x) => x.caps).map((x) => ({ name: x.name, online: Date.now() - (x.lastSeen || 0) < 3 * 60000, caps: x.caps })),
  };
}

// ---- no próprio NAS (quando escolhido, ou quando o ajudante do PC não está ligado)
let compressLocal = null;
async function compressTick() {
  if (compressLocal) return;
  const db = await loadCompress();
  const pcOn = Date.now() - lastCompressWorker < 3 * 60000;
  const canNas = (i) => i.preset !== 'av1' || nasEncoders.has('libsvtav1');
  const it = db.items.find((i) => i.status === 'queued' && canNas(i) && !compressExcluded(i.path) && (i.where === 'nas' || (i.where === 'auto' && !pcOn)));
  if (!it) return;
  const abs = resolveSafe(it.path);
  let info; try { info = await probe(abs); } catch (e) { it.status = 'failed'; it.error = 'não consegui ler o vídeo'; return saveCompress(); }
  const spec = compressSpec(info, it.path, it.preset, it.maxh, it.quality, it.measure, it.force);
  const tmp = compressTmp(abs, it.id, spec.outExt);
  it.status = 'working'; it.by = 'NAS'; it.started = Date.now(); it.pct = 0; saveCompress();
  const args = ffArgsFor(spec, abs, tmp);
  const proc = NICE ? spawn(NICE, ['-n', '19', FFMPEG, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  compressLocal = { it, proc };
  let err = '';
  proc.stdout.on('data', (d) => { const m = /out_time_(?:us|ms)=(\d+)/.exec(String(d)); if (m && it.duration) it.pct = Math.min(99, Math.round(+m[1] / 1e6 / it.duration * 100)); });
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  proc.on('close', async (code) => {
    compressLocal = null;
    try {
      if (it.status === 'cancelled') throw new Error('cancelado');
      if (code !== 0) throw new Error(`ffmpeg: ${err.trim().split('\n').slice(-2).join(' | ') || code}`);
      await finishCompress(it, tmp);
    } catch (e) {
      fsp.rm(tmp, { force: true }).catch(() => {});
      if (it.status !== 'cancelled') { it.status = 'failed'; it.error = String(e.message || e).slice(0, 300); }
    }
    it.finished = Date.now(); await saveCompress(true);
    setTimeout(compressTick, 1000);
  });
}
setInterval(() => compressTick().catch(() => {}), 20000).unref();

// ---- ajudante no PC
async function compressJobForWorker(t) {
  const db = await loadCompress(); const now = Date.now();
  // trabalho que ficou parado (ajudante fechado no meio) volta para a fila
  for (const i of db.items) if (i.status === 'working' && i.by !== 'NAS' && now - (i.beat || 0) > 10 * 60000) { i.status = 'queued'; i.pct = 0; }
  const w = await loadJSON(WORKER_FILE, { tokens: [] });
  const rec = (w.tokens || []).find((x) => x.hash === t.hash);
  const caps = rec && rec.caps;
  const can = (i) => !caps || !caps[COMPRESS_PRESETS[i.preset].codec] || !!caps[COMPRESS_PRESETS[i.preset].codec].enc;
  const it = db.items.find((i) => i.status === 'queued' && !compressExcluded(i.path) && can(i) && (i.where === 'pc' || i.where === 'auto'));
  if (!it) return { none: true };
  const abs = resolveSafe(it.path);
  let info; try { info = await probe(abs); } catch { it.status = 'failed'; it.error = 'não consegui ler o vídeo'; saveCompress(); return { none: true }; }
  const spec = compressSpec(info, it.path, it.preset, it.maxh, it.quality, it.measure, it.force);
  it.status = 'working'; it.by = t.name; it.started = now; it.beat = now; it.pct = 0; await saveCompress(true);
  return { id: it.id, name: it.name, duration: info.duration, size: it.origSize, spec, url: `/api/worker/file?${new URLSearchParams({ path: it.path })}` };
}
async function compressUpload(req, id) {
  const db = await loadCompress();
  const it = db.items.find((i) => i.id === id && i.status === 'working');
  if (!it) { req.resume(); throw new HttpError(409, 'Este trabalho não está mais ativo'); }
  const abs = resolveSafe(it.path);
  const ext = String(req.headers['x-out-ext'] || '.mp4').toLowerCase() === '.mkv' ? '.mkv' : '.mp4';
  const tmp = compressTmp(abs, it.id, ext);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
  });
  if (req.headers['x-vmaf']) it.vmaf = +(+req.headers['x-vmaf']).toFixed(1);
  if (req.headers['x-enc']) it.enc = String(req.headers['x-enc']).slice(0, 60);
  try { await finishCompress(it, tmp); }
  catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); it.status = 'failed'; it.error = String(e.message || e).slice(0, 300); }
  it.finished = Date.now(); await saveCompress(true);
  return { ok: it.status === 'done' || it.status === 'skipped', status: it.status, error: it.error, newSize: it.newSize };
}

// ===================================================================== cruzamento por vídeo
// Pistas que valem para o vídeo inteiro:
//  - cada pessoa aparece no máximo UMA vez por vídeo (o ajudante já juntou as aparições dela);
//  - pessoas diferentes do mesmo vídeo nunca são a mesma pessoa;
//  - o nome de uma pessoa no nome do arquivo deixa o reconhecimento dela um pouco menos exigente ali.
let nameHitCache = { key: '', map: new Map() };
function nameHits(rel) {
  const key = `${tagVer}`;
  if (nameHitCache.key !== key) nameHitCache = { key, map: new Map(), pats: null };
  const c = nameHitCache;
  if (!c.pats) {
    const db = tagDb || { tags: {} };
    c.pats = Object.entries(db.tags).filter(([, v]) => v.person)
      .map(([t, v]) => ({ t, pats: [t, ...(v.aliases || [])].map((x) => normName(x)).filter((x) => x.trim().length >= 3) }));
  }
  if (!c.map.has(rel)) {
    const n = normName(path.posix.basename(rel));
    c.map.set(rel, new Set(c.pats.filter((p) => p.pats.some((x) => n.includes(x))).map((p) => p.t)));
  }
  return c.map.get(rel);
}
const NAME_BONUS = 0.06;
// distribui as pessoas entre os rostos de um vídeo: maior pontuação primeiro, cada pessoa e cada rosto uma vez só
function assignVideo(rows, tags) {
  if (!tags.length || !rows.length) return new Map();
  const hits = nameHits(rows[0].rel);
  const cand = [];
  for (const r of rows) {
    if (allIgnored(r)) continue;
    const sc = tags.map((t) => [t, simTo(r, t)]).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < sc.length && i < 3; i++) {
      const [t, v] = sc[i]; const bonus = hits.has(t) ? NAME_BONUS : 0; const thr = protosOf(t).thr;
      if (v + bonus < thr) continue;
      // empate com outra pessoa (sósias) e sem pista do nome: não decide
      const other = sc.find(([t2]) => t2 !== t);
      if (other && v - other[1] < 0.05 && !bonus) continue;
      cand.push({ r, t, v, adj: v + bonus, thr, bonus });
    }
  }
  cand.sort((a, b) => b.adj - a.adj);
  const usedR = new Set(); const usedT = new Set(); const out = new Map();
  for (const c of cand) {
    if (usedR.has(c.r.key) || usedT.has(c.t)) continue;
    usedR.add(c.r.key); usedT.add(c.t);
    const conf = c.v >= c.thr + 0.1 || (c.bonus && c.v >= c.thr) ? 'alta' : 'media';
    out.set(c.r.key, { tag: c.t, sim: c.v, conf, name: !!c.bonus });
  }
  return out;
}
function rowsByVideo() {
  const by = new Map();
  for (const r of allRows()) { if (!by.has(r.rel)) by.set(r.rel, []); by.get(r.rel).push(r); }
  return by;
}
let assignCache = { key: '', map: null };
function allAssignments() {
  const key = `${faceVer}|${peopleVer}|${tagVer}`;
  if (assignCache.key === key) return assignCache.map;
  const tags = refTags(); const map = new Map();
  for (const rows of rowsByVideo().values()) for (const [k, v] of assignVideo(rows, tags)) map.set(k, v);
  assignCache = { key, map };
  return map;
}

// grupos de rostos sem nome, em duas passadas (como o Apple Fotos descreve):
//  1) gulosa e conservadora (só junta o que é bem parecido) — poucos erros;
//  2) junta grupos inteiros pela média, para recuperar a mesma pessoa em fotos mais difíceis.
// Nunca junta duas pessoas do mesmo vídeo; rostos de qualidade muito baixa não formam grupos.
const CLUSTER_STRICT = 0.55;
function faceClusters() {
  if (clusterCache) return clusterCache;
  if (!clusterBase) clusterBase = buildClusterBase();
  applyClusterChanges();
  // visão atual: tira dos grupos quem já tem nome, foi ignorado ou foi reconhecido (rápido)
  const asg = allAssignments();
  const named = new Set(Object.values(peopleDb.refs).flat());
  clusterCache = clusterBase.clusters.map((c) => {
    const rows = c.rows.filter((r) => !allIgnored(r) && !r.ids.some((id) => named.has(id)) && !asg.has(r.key));
    if (!rows.length) return null;
    const faces = rows.flatMap((r) => r.ids.filter((id) => !peopleDb.ignored[id]));
    const q = Math.max(...rows.map((r) => r.q || 0.6));
    return { id: c.id, faces, sample: rows.slice(0, 8).map((r) => r.ids[0]), count: faces.length, videos: new Set(rows.map((r) => r.rel)).size, q: +q.toFixed(2), _mean: c.mean };
  }).filter((c) => c && c.faces.length).sort((a, b) => b.videos - a.videos || b.q - a.q);
  return clusterCache;
}
function buildClusterBase() {
  const pv = peopleVer;
  const asg = allAssignments();
  const named = new Set(Object.values(peopleDb.refs).flat());
  const pool = allRows().filter((r) => !allIgnored(r) && !r.ids.some((id) => named.has(id)) && !asg.has(r.key) && (r.q == null || r.q >= 0.3));
  pool.sort((a, b) => (b.q || 0.6) * Math.log2(1 + b.n) - (a.q || 0.6) * Math.log2(1 + a.n));
  const clusters = [];
  for (const r of pool) placeRow(clusters, r);
  // 2ª passada: junta grupos (no máximo os 1500 maiores, para o NAS não sofrer)
  const big = clusters.slice().sort((a, b) => b.rows.length - a.rows.length).slice(0, 1500);
  const pairs = [];
  for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
    const x = dot(big[i].mean, big[j].mean);
    if (x >= FACE_CLUSTER - 0.05) pairs.push([x, i, j]);
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const alive = big.map(() => true);
  for (const [, i, j] of pairs) {
    if (!alive[i] || !alive[j]) continue;
    const A = big[i]; const B = big[j];
    if ([...B.videos].some((v) => A.videos.has(v))) continue; // mesma pessoa não aparece duas vezes no vídeo
    if (dot(A.mean, B.mean) < FACE_CLUSTER - 0.05) continue;     // a média mudou depois de outras junções
    for (const r of B.rows) addTo(A, r);
    alive[j] = false;
  }
  const final = big.filter((_, i) => alive[i]).concat(clusters.filter((c) => !big.includes(c)));
  for (const c of final) { c.rows.sort((a, b) => (b.q || 0.6) - (a.q || 0.6)); c.id = c.rows[0].ids[0]; }
  return { pv, clusters: final, dirty: new Set() };
}
function addTo(c, r) {
  const w = Math.max(0.05, r.q || 0.6);
  for (let i = 0; i < 512; i++) c.sum[i] += r.mean[i] * w;
  c.mean = normalized(c.sum); c.rows.push(r); c.videos.add(r.rel);
}
// põe um rosto (grupo do vídeo) no grupo sem nome mais parecido, ou cria um grupo novo
function placeRow(clusters, r) {
  let best = null; let bs = CLUSTER_STRICT;
  for (const c of clusters) { if (c.videos.has(r.rel)) continue; const x = dot(r.mean, c.mean); if (x > bs) { bs = x; best = c; } }
  if (!best) { best = { sum: new Float32Array(512), mean: null, rows: [], videos: new Set(), id: r.ids[0] }; clusters.push(best); }
  addTo(best, r);
}
// vídeo novo (ou refeito) entra nos grupos existentes sem refazer tudo — o servidor não trava a cada vídeo do ajudante
function applyClusterChanges() {
  if (!clusterBase || !clusterBase.dirty.size) return;
  const rels = clusterBase.dirty; clusterBase.dirty = new Set();
  for (const c of clusterBase.clusters) {
    if (![...rels].some((rel) => c.videos.has(rel))) continue;
    const keep = c.rows.filter((r) => !rels.has(r.rel));
    c.rows = []; c.videos = new Set(); c.sum = new Float32Array(512);
    for (const r of keep) addTo(c, r);
  }
  clusterBase.clusters = clusterBase.clusters.filter((c) => c.rows.length);
  const asg = allAssignments();
  const named = new Set(Object.values(peopleDb.refs).flat());
  for (const rel of rels) {
    if (!faceVideos.has(rel) || faceExcluded(rel) || inCacheRel(rel)) continue;
    for (const r of rowsOf(rel)) {
      if (allIgnored(r) || r.ids.some((id) => named.has(id)) || asg.has(r.key) || (r.q != null && r.q < 0.3)) continue;
      placeRow(clusterBase.clusters, r);
    }
  }
}

// sugestões de tags: pessoas reconhecidas em vídeos que ainda não têm a tag
async function faceSuggestions() {
  const db = await loadTags();
  const asg = allAssignments();
  const rowByKey = new Map(allRows().map((r) => [r.key, r]));
  const out = [];
  for (const [k, a] of asg) {
    const r = rowByKey.get(k); if (!r) continue;
    const key = `${r.rel}|${a.tag}`;
    if ((db.items[r.rel] || []).includes(a.tag) || peopleDb.answered[key] === 'none') continue;
    if (r.ids.every((id) => peopleDb.blocked[`${a.tag}|${id}`])) continue;
    out.push({ path: r.rel, name: path.posix.basename(r.rel), tag: a.tag, sim: +a.sim.toFixed(3), conf: a.conf, byName: a.name,
      face: r.ids.find((id) => !peopleDb.ignored[id]) || r.ids[0], faces: r.ids.slice(0, 6), via: 'rosto' });
  }
  return out.sort((a, b) => (a.conf === b.conf ? 0 : a.conf === 'alta' ? -1 : 1) || b.sim - a.sim).slice(0, 2000);
}

// perguntas "é a mesma pessoa?" (como o Google Fotos): grupo sem nome quase parecido com alguém
function sameQuestions() {
  const tags = refTags(); if (!tags.length) return [];
  const out = [];
  for (const c of faceClusters().slice(0, 300)) {
    if (!c._mean) continue;
    let best = null; let bs = -1;
    for (const t of tags) { const v = scoreFor(c._mean, protosOf(t)); if (v > bs) { bs = v; best = t; } }
    const thr = best ? protosOf(best).thr : FACE_MATCH;
    if (best && bs >= thr - 0.12 && bs < thr + 0.05) {
      out.push({ kind: 'same', tag: best, sim: +bs.toFixed(3), faces: c.faces, sample: c.sample.slice(0, 6), videos: c.videos, id: c.id });
    }
    if (out.length >= 30) break;
  }
  return out.sort((a, b) => b.videos - a.videos || b.sim - a.sim);
}

// ---- pelo nome do arquivo
const normName = (s) => ` ${norm(String(s)).replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const NAME_STOP = new Set(('the and com sem para por dos das de da do e o a os as em no na vs feat ft part parte cena scene full hd uhd video '
  + 'clip episodio episode temporada season dublado legendado remastered extended director cut edition version official trailer '
  + 'new best collection compilation bonus behind making uncut original').split(' '));
// distância de edição limitada (para achar erros de digitação em nomes)
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 2] + 1); // letras trocadas
      low = Math.min(low, cur[j]);
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// "Maria Sousa" x "Maria Souza", "Joao Lmia" x "Joao Lima": mesmo número de palavras, diferença pequena
// (1 letra em nomes curtos, 2 em nomes longos) e a primeira letra de cada palavra igual
function typoOf(a, b) {
  if (!a || !b || a === b) return false;
  const wa = a.split(' '); const wb = b.split(' ');
  if (wa.length !== wb.length || a.length < 7) return false;
  if (wa.some((w, i) => w[0] !== wb[i][0])) return false;
  const max = Math.min(a.length, b.length) >= 12 ? 2 : 1;
  return editDist(a, b, max) <= max;
}
// conferir um nome digitado/ajustado: em quantos arquivos aparece, grafias parecidas e pessoa já cadastrada
async function checkName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const key = normName(name).trim();
  if (key.length < 3) throw new HttpError(400, 'Nome muito curto');
  const db = await loadTags();
  const nw = key.split(' ').length;
  const idx = await getIndex();
  const exact = new Set(); const vars = new Map(); // grafia -> Set(arquivos)
  for (const it of idx) {
    if (it.d || it.t !== 'video' || nameExcluded(it.p)) continue;
    const words = normName(path.posix.basename(it.p)).trim().split(' ');
    const n = ` ${words.join(' ')} `;
    if (n.includes(` ${key} `)) exact.add(it.p);
    for (let i = 0; i + nw <= words.length; i++) {
      const g = words.slice(i, i + nw).join(' ');
      if (g !== key && typoOf(g, key)) { if (!vars.has(g)) vars.set(g, new Set()); vars.get(g).add(it.p); }
    }
  }
  // pessoa já cadastrada com este nome (ou apelido) ou com grafia quase igual
  let same = findTag(db, name); let like = null;
  if (!same) {
    for (const [t, v] of Object.entries(db.tags)) {
      if (!v.person) continue;
      if ([t, ...(v.aliases || [])].some((x) => typoOf(normName(x).trim(), key))) { like = t; break; }
    }
  }
  // grafias que já são o nome/apelido de alguma tag não precisam ser oferecidas
  const knownKeys = new Set(Object.entries(db.tags).flatMap(([t, v]) => [t, ...(v.aliases || [])].map((x) => normName(x).trim())));
  const titled = (k) => k.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return {
    name, files: exact.size, sample: [...exact].slice(0, 4).map((p) => path.posix.basename(p)),
    variants: [...vars.entries()].filter(([g]) => !peopleDb.nameIgnored[g] && !knownKeys.has(g)).map(([g, set]) => ({ name: titled(g), files: set.size, sample: path.posix.basename([...set][0]) })).sort((a, b) => b.files - a.files).slice(0, 20),
    same, like,
  };
}
async function nameSuggestions(scope) {
  const db = await loadTags();
  // pessoas e também tags com outros nomes ligados a elas (ex.: um nome que o usuário indicou ser de uma tag)
  const people = Object.entries(db.tags).filter(([, v]) => v.person || (v.aliases || []).length)
    .map(([tag, v]) => ({ tag, pats: [tag, ...(v.aliases || [])].map((x) => normName(x)).filter((x) => x.trim().length >= 3) }));
  const idx = await getIndex();
  let prefix = ''; if (scope) { prefix = relOf(resolveSafe(scope)); if (prefix) prefix += '/'; }
  const sugg = []; const cand = new Map(); // nome possível -> Set(arquivos)
  const known = new Set(Object.keys(db.tags).map((t) => normName(t)));
  const personInside = people.flatMap((pp) => pp.pats).filter((x) => x.trim().includes(' '));
  const knownSeqs = [...known].map((k) => k.trim().split(' ')).filter((ws) => ws[0] && ws.join('').length >= 3);
  for (const [, v] of Object.entries(db.tags)) for (const a of v.aliases || []) known.add(normName(a));
  let skipped = 0;
  for (const it of idx) {
    if (it.d || it.t !== 'video' || (prefix && !it.p.startsWith(prefix))) continue;
    if (nameExcluded(it.p)) { skipped++; continue; }
    const name = path.posix.basename(it.p);
    const n = normName(name);
    const has = new Set(db.items[it.p] || []);
    for (const pp of people) {
      if (has.has(pp.tag) || peopleDb.nameRejected[`${it.p}|${pp.tag}`]) continue;
      const hit = pp.pats.find((x) => n.includes(x));
      if (hit) sugg.push({ path: it.p, name, tag: pp.tag, match: hit.trim(), via: 'nome' });
    }
    // nomes possíveis: 2–3 palavras seguidas com inicial maiúscula (ex.: "Maria Souza"), repetidas em vários arquivos
    const words = name.replace(/\.[A-Za-z0-9]{2,4}$/, '').split(/[\s._\-[\](){},+&@#!]+/).filter(Boolean);
    const isCap = (w) => /^[A-ZÀ-Þ][a-zà-ÿ]{1,}$/.test(w) && !NAME_STOP.has(norm(w));
    // palavras que já fazem parte do nome de uma tag/apelido neste arquivo não formam nomes novos
    // (ex.: com "Bruno Alves" cadastrado, "Bruno Alves Show" não vira a sugestão "Alves Show")
    const wn = words.map((w) => norm(w).replace(/[^a-z0-9]/g, ''));
    const covered = new Set();
    for (const ks of knownSeqs) {
      for (let i = 0; i + ks.length <= wn.length; i++) {
        if (ks.every((w, j) => wn[i + j] === w)) for (let j = 0; j < ks.length; j++) covered.add(i + j);
      }
    }
    for (let i = 0; i < words.length; i++) {
      for (const len of [2, 3]) {
        const seq = words.slice(i, i + len);
        if (seq.length < len || !seq.every(isCap)) continue;
        if (seq.some((_, j) => covered.has(i + j))) continue;
        const k = seq.join(' ');
        const nk = normName(k);
        if (known.has(nk) || peopleDb.nameIgnored[nk.trim()]) continue;
        // já contém o nome de uma pessoa cadastrada (ex.: "Carlos Pereira Show" quando "Carlos Pereira" existe)
        if (personInside.some((x) => nk.includes(x))) continue;
        if (!cand.has(k)) cand.set(k, new Set());
        cand.get(k).add(it.p);
      }
    }
  }
  const all = [...cand.entries()].map(([nameStr, set]) => ({ name: nameStr, key: normName(nameStr).trim(), files: set.size, paths: set, sample: [...set].slice(0, 3).map((p) => path.posix.basename(p)) }));
  // 1) erro de digitação de uma pessoa já cadastrada (vale mesmo se aparece em 1 arquivo só)
  const personKeys = people.flatMap((pp) => pp.pats.map((x) => ({ tag: pp.tag, key: x.trim() })));
  const typos = []; const used = new Set();
  for (const c of all) {
    const hit = personKeys.find((pk) => typoOf(c.key, pk.key));
    if (!hit) continue;
    used.add(c.key);
    typos.push({ name: c.name, files: c.files, sample: c.sample, tag: hit.tag });
  }
  typos.sort((a, b) => b.files - a.files);
  // 2) nomes novos repetidos em 2+ arquivos; grafias parecidas entre si viram um item só (com as variantes)
  let names = all.filter((c) => !used.has(c.key) && c.files >= 2).sort((a, b) => b.files - a.files);
  // nomes de 3 palavras que contêm um de 2 com a mesma contagem: fica só o mais completo
  names = names.filter((x) => !names.some((y) => y !== x && y.name.includes(x.name) && y.files === x.files));
  const singles = all.filter((c) => !used.has(c.key) && c.files === 1);
  const final = [];
  for (const c of names) {
    const home = final.find((f) => typoOf(c.key, f.key));
    if (home) { home.variants.push({ name: c.name, files: c.files }); for (const p of c.paths) home.paths.add(p); continue; }
    final.push({ ...c, paths: new Set(c.paths), variants: [] });
  }
  for (const c of singles) { const home = final.find((f) => typoOf(c.key, f.key)); if (home) { home.variants.push({ name: c.name, files: 1 }); for (const p of c.paths) home.paths.add(p); } }
  const out = final.slice(0, 60).map((f) => ({ name: f.name, files: f.paths.size, sample: f.sample, variants: f.variants }));
  return { suggestions: sugg.slice(0, 2000), names: out, typos: typos.slice(0, 60), skipped, ignored: Object.keys(peopleDb.nameIgnored).length };
}

// aplicar sugestões (pares arquivo → tag)
async function applySuggestions(pairs) {
  const db = await loadTags();
  let n = 0; let learned = false;
  for (const { path: p, tag, face } of pairs || []) {
    const rel = relOf(resolveSafe(p)); const t = cleanTagName(tag);
    if (!db.tags[t]) continue;
    const set = new Set(db.items[rel] || []);
    if (!set.has(t)) { set.add(t); db.items[rel] = [...set].sort(ptSort); n++; }
    // sugestão por rosto confirmada por você: esse rosto vira referência da pessoa (como "confirmar rostos"
    // no Google/Apple Fotos) — a pessoa passa a ser reconhecida em mais ângulos e situações
    if (face && faceById.has(face) && db.tags[t].person) {
      const refs = peopleDb.refs[t] || (peopleDb.refs[t] = []);
      if (!refs.includes(face) && refs.length < 80) { refs.push(face); delete peopleDb.auto[face]; delete peopleDb.ignored[face]; learned = true; }
    }
  }
  if (learned) await savePeople();
  await saveTags();
  return { ok: true, applied: n, ...(await listTags()) };
}
async function ensurePersonTag(name) {
  const db = await loadTags(); const t = findTag(db, cleanTagName(name)) || cleanTagName(name);
  if (!db.tags[t]) db.tags[t] = { color: TAG_COLORS[Object.keys(db.tags).length % TAG_COLORS.length] };
  db.tags[t].person = true;
  await saveTags();
  return t;
}
// dar nome a um grupo de rostos: vira referência da pessoa (e marca os vídeos desses rostos)
async function nameFaces({ faces, name, apply = true }) {
  const t = await ensurePersonTag(name);
  const ids = (faces || []).filter((id) => faceById.has(id));
  // referência: os melhores rostos do grupo, no máximo 3 por vídeo e 24 no total (a tag vai para todos os vídeos)
  const perVid = {};
  const refs = ids.map((id) => faceById.get(id)).sort((a, b) => b.face.score - a.face.score)
    .filter((x) => (perVid[x.path] = (perVid[x.path] || 0) + 1) <= 3).slice(0, 24).map((x) => x.face.id);
  peopleDb.refs[t] = [...new Set([...(peopleDb.refs[t] || []), ...refs])];
  for (const id of ids) { delete peopleDb.ignored[id]; delete peopleDb.blocked[`${t}|${id}`]; }
  await savePeople();
  if (apply) await applySuggestions([...new Set(ids.map((id) => faceById.get(id).path))].map((p) => ({ path: p, tag: t })));
  return { ok: true, tag: t, ...(await listTags()) };
}
async function ignoreFaces({ faces }) {
  for (const id of faces || []) if (faceById.has(id)) peopleDb.ignored[id] = 1;
  await savePeople();
  return { ok: true };
}
// ===================================================================== cruzamento: tags x rostos
// Os vídeos que já têm a tag de uma pessoa (manual ou pelo nome do arquivo) ensinam como ela é:
//  - o rosto que se repete nos vídeos com a tag (e não é de outra pessoa conhecida) é aprendido sozinho;
//  - se o vídeo tem várias pessoas e não dá para saber qual é, vira uma pergunta;
//  - tag comum (não marcada como pessoa) cujos vídeos têm sempre o mesmo rosto: pergunta se é uma pessoa.
const LEARN_SAMPLE = 80;      // vídeos por pessoa usados para comparar
const LEARN_MAX_REFS = 40;    // limite de rostos de referência por pessoa
const LEARN_SURE = 0.56;      // pontuação para reforçar a referência com um vídeo novo
function videoGroups(rel) {
  const rec = faceVideos.get(rel);
  if (!rec || rec.status === 'failed' || !rec.faces.length) return null;
  const meta = new Map((rec.groups || []).map((g) => [g.g, g]));
  const by = new Map();
  for (const f of rec.faces) {
    const k = f.g != null ? 'g' + f.g : f.id;
    if (!by.has(k)) by.set(k, { g: f.g, faces: [], sum: new Float32Array(512), n: 0 });
    const g = by.get(k); g.faces.push(f); g.n = Math.max(g.n, f.n || 1);
    const w = Math.max(0.05, f.q != null ? f.q : 0.6) ** 2; // rostos melhores pesam mais
    for (let i = 0; i < 512; i++) g.sum[i] += f.emb[i] * w;
  }
  const out = [...by.values()].map((g) => {
    const m = g.g != null ? meta.get(g.g) : null;
    // análise nova: o ajudante já manda a assinatura do grupo (todas as aparições, ponderadas pela qualidade)
    const mean = m && m.tpl && m.tpl.length === 512 ? m.tpl : normalized(g.sum);
    g.faces.sort((a, b) => (b.q != null ? b.q : b.score) - (a.q != null ? a.q : a.score));
    const q = m && m.q != null ? m.q : Math.max(...g.faces.map((f) => (f.q != null ? f.q : 0.6)));
    return { g: g.g, faces: g.faces, ids: g.faces.map((f) => f.id), mean, n: m ? m.n : g.n, q, co: m ? m.co || [] : [] };
  });
  return out;
}
const refSim = (mean, embs) => { let m = -1; for (const e of embs) { const x = dot(mean, e); if (x > m) m = x; } return m; };
let learnTimer = null; let learnLast = null;
function scheduleLearn() { clearTimeout(learnTimer); learnTimer = setTimeout(warmPeople, 4000); }
// deixa Pessoas pronta antes de alguém abrir: distribuição das pessoas, grupos sem nome e cruzamento com as tags
async function warmPeople() {
  if (!faceVideos.size) return;
  try { await loadTags(); allAssignments(); faceClusters(); await learnFromTags(); sameQuestions(); } catch (e) { console.error('pessoas', e); }
}
// apoio de cada grupo dentro de uma tag: em quantos OUTROS vídeos com a mesma tag aparece um rosto parecido.
// Só depende dos vídeos da tag e dos rostos (não das respostas), então fica em cache entre as confirmações.
const supportCache = new Map(); // tag -> { key, fv, map: rowKey -> contagem }
function supportFor(tag, vids) {
  const key = vids.join('\n');
  const c = supportCache.get(tag);
  if (c && c.key === key && c.fv === faceVer) return c.map;
  const map = new Map();
  const rows = vids.map((v) => rowsOf(v));
  for (let i = 0; i < vids.length; i++) {
    for (const g of rows[i]) {
      let n = 0;
      for (let j = 0; j < vids.length; j++) {
        if (j === i) continue;
        for (const h of rows[j]) if (dot(g.mean, h.mean) >= FACE_CLUSTER) { n++; break; }
      }
      map.set(g.key, n);
    }
  }
  supportCache.set(tag, { key, fv: faceVer, map });
  return map;
}
let learnKey = '';
async function learnFromTags() {
  const db = await loadTags();
  const k0 = `${faceVer}|${peopleVer}|${tagVer}`;
  if (learnLast && learnKey === k0) return { ...learnLast, learned: 0 };
  const byTag = {};
  for (const [rel, list] of Object.entries(db.items)) {
    if (faceExcluded(rel) || !faceVideos.has(rel)) continue;
    for (const t of list) if (db.tags[t]) (byTag[t] = byTag[t] || []).push(rel);
  }
  const learned = []; const questions = [];
  const addRefs = (tag, g, max) => {
    const cur = new Set(peopleDb.refs[tag] || []);
    if (cur.size >= LEARN_MAX_REFS) return 0;
    let n = 0;
    for (const id of g.ids) {
      if (n >= max || cur.size >= LEARN_MAX_REFS) break;
      if (cur.has(id) || peopleDb.ignored[id] || peopleDb.blocked[`${tag}|${id}`]) continue;
      cur.add(id); peopleDb.auto[id] = tag; n++;
    }
    peopleDb.refs[tag] = [...cur];
    return n;
  };
  const persons = Object.keys(byTag).filter((t) => db.tags[t].person);
  // duas passadas: a primeira aprende o que é certo; a segunda usa o aprendido para resolver o resto
  for (let pass = 0; pass < 2; pass++) {
    peopleVer++; // os rostos aprendidos na passada anterior já valem como referência
    const known = refTags();
    for (const tag of persons) {
      const vids = byTag[tag].filter((r) => rowsOf(r).length).slice(-LEARN_SAMPLE);
      if (!vids.length) continue;
      const others = known.filter((t) => t !== tag);
      const mineKnown = known.includes(tag);
      let support = null;
      for (const rel of vids) {
        if (peopleDb.answered[`${rel}|${tag}`]) continue; // usuário já respondeu
        // tira rostos que são claramente de outra pessoa conhecida ou que o usuário disse não ser esta
        const cand = rowsOf(rel).filter((g) => {
          if (g.ids.every((id) => peopleDb.ignored[id] || peopleDb.blocked[`${tag}|${id}`])) return false;
          if (!others.length) return true;
          const mine = mineKnown ? simTo(g, tag) : -1;
          const o = bestOf(g, others).sim;
          return !(o >= FACE_MATCH && o > mine);
        });
        if (!cand.length) continue;
        // 1) já conhece a pessoa: confere qual rosto é ela
        if (mineKnown) {
          const sims = cand.map((g) => simTo(g, tag));
          const bi = sims.indexOf(Math.max(...sims));
          if (sims[bi] >= protosOf(tag).thr) {
            const has = cand[bi].ids.some((id) => (peopleDb.refs[tag] || []).includes(id));
            if (!has && sims[bi] >= LEARN_SURE && pass === 0 && addRefs(tag, cand[bi], 1)) learned.push({ tag, path: rel });
            continue;
          }
        }
        // 2) não conhece (ou não achou): o rosto que se repete nos outros vídeos com a mesma tag
        if (!support) support = supportFor(tag, vids);
        const sup = cand.map((g) => support.get(g.key) || 0);
        const order = cand.map((g, i) => i).sort((a, b) => sup[b] - sup[a] || cand[b].n - cand[a].n);
        const top = order[0]; const second = order[1];
        // só aprende sozinho quando o mesmo rosto se repete em outros vídeos com a tag (um vídeo só não basta:
        // o nome no arquivo pode estar errado ou a pessoa nem aparecer)
        const sure = cand.length === 1
          ? sup[top] >= 1
          : sup[top] >= 2 && sup[top] > (second != null ? sup[second] : -1) * 2;
        if (sure && pass === 0) {
          if (addRefs(tag, cand[top], 2)) learned.push({ tag, path: rel });
        } else if (!sure && pass === 1) {
          questions.push({
            kind: 'who', tag, path: rel, name: path.posix.basename(rel),
            reason: cand.length > 1 ? `Há ${cand.length} pessoas neste vídeo e não sei qual é ${tag}` : `Não tenho certeza se este rosto é ${tag}`,
            options: order.slice(0, 6).map((i) => ({ faces: cand[i].ids.slice(0, 4), all: cand[i].ids, n: cand[i].n, seen: sup[i] })),
          });
        }
      }
    }
  }
  // tags comuns cujos vídeos têm sempre o mesmo rosto: talvez seja uma pessoa
  const known = refTags();
  for (const [tag, vids0] of Object.entries(byTag)) {
    if (db.tags[tag].person || peopleDb.notPerson[tag]) continue;
    const vids = vids0.filter((r) => rowsOf(r).length).slice(-LEARN_SAMPLE);
    if (vids.length < 3) continue;
    const support = supportFor(tag, vids);
    let best = null;
    for (const rel of vids) {
      for (const g of rowsOf(rel)) {
        const c = (support.get(g.key) || 0) + 1;
        if (best && (c < best.c || (c === best.c && g.n <= best.g.n))) continue;
        if (known.length && bestOf(g, known).sim >= FACE_MATCH) continue; // já é outra pessoa
        best = { c, g, rel };
      }
    }
    if (best && best.c >= Math.max(3, Math.ceil(vids.length * 0.6))) {
      questions.push({ kind: 'isperson', tag, path: best.rel, name: path.posix.basename(best.rel), reason: `O mesmo rosto aparece em ${best.c} de ${vids.length} vídeos com a tag “${tag}”`, options: [{ faces: best.g.ids.slice(0, 4), all: best.g.ids, n: best.g.n, seen: best.c }] });
    }
  }
  if (learned.length) await savePeople();
  learnLast = { at: Date.now(), learned: learned.length, questions };
  learnKey = `${faceVer}|${peopleVer}|${tagVer}`;
  return learnLast;
}
// resposta do usuário a uma pergunta: { tag, path, faces } = este rosto é a pessoa; { none } = não aparece; { notPerson } = a tag não é pessoa
// exemplos negativos: rostos que o usuário disse não serem a pessoa (ensina o que NÃO é ela)
function addNeg(tag, ids) {
  const cur = new Set(peopleDb.neg[tag] || []);
  for (const id of ids || []) if (faceById.has(id) && !(peopleDb.refs[tag] || []).includes(id)) { cur.add(id); peopleDb.blocked[`${tag}|${id}`] = 1; }
  peopleDb.neg[tag] = [...cur].slice(-300);
}
async function answerQuestion({ tag, path: p, faces, none, notPerson, others }) {
  const db = await loadTags();
  if (!db.tags[tag]) throw new HttpError(404, 'Tag não encontrada');
  const rel = p ? relOf(resolveSafe(p)) : '';
  if (notPerson) { peopleDb.notPerson[tag] = 1; await savePeople(); return { ok: true }; }
  if (none) { peopleDb.answered[`${rel}|${tag}`] = 'none'; addNeg(tag, (others || []).slice(0, 30)); await savePeople(); return { ok: true }; }
  const ids = (faces || []).filter((id) => faceById.has(id));
  if (!ids.length) throw new HttpError(400, 'Escolha um rosto');
  if (!db.tags[tag].person) { db.tags[tag].person = true; await saveTags(); }
  const best = ids.map((id) => faceById.get(id).face).sort((a, b) => b.score - a.score).slice(0, 3).map((f) => f.id);
  peopleDb.refs[tag] = [...new Set([...(peopleDb.refs[tag] || []), ...best])];
  for (const id of best) { delete peopleDb.ignored[id]; delete peopleDb.auto[id]; delete peopleDb.blocked[`${tag}|${id}`]; }
  if (rel) peopleDb.answered[`${rel}|${tag}`] = 'faces';
  addNeg(tag, (others || []).filter((id) => !ids.includes(id)).slice(0, 30)); // as outras opções do vídeo não são ela
  await savePeople();
  return { ok: true, ...(await listTags()) };
}

async function peopleStatus() {
  const idx = await getIndex();
  const all = idx.filter((it) => it.t === 'video');
  const vids = all.filter((it) => !faceExcluded(it.p));
  let done = 0; let failed = 0; let faces = 0;
  let old = 0;
  for (const it of vids) { const r = faceVideos.get(it.p); if (r) { if (r.status === 'failed') failed++; else { done++; if ((r.v || 1) < 2) old++; } faces += r.faces.length; } }
  const w = await loadJSON(WORKER_FILE, { tokens: [] });
  return {
    videos: vids.length, old, skipped: all.length - vids.length, excluded: peopleDb.excluded, analyzed: done, failed, faces, people: Object.keys(peopleDb.refs).length,
    workers: (w.tokens || []).map((t) => ({ name: t.name, created: t.created, lastSeen: t.lastSeen || 0, info: t.info || '' })),
  };
}

// ---- download do ajudante: a pasta worker/ compactada num .zip (sem dependências)
async function sendWorkerZip(res) {
  const dir = path.join(__dirname, 'worker');
  const names = (await fsp.readdir(dir)).filter((n) => !n.startsWith('.') && !n.startsWith('__') && /\.(py|pyw|txt|bat|md|json)$/.test(n));
  const parts = []; const central = []; let offset = 0;
  const dosTime = (() => { const d = new Date(); return { t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
  for (const n of names) {
    let data = await fsp.readFile(path.join(dir, n));
    if (n.endsWith('.bat')) data = Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n')); // .bat precisa de CRLF no Windows
    const crc = zlib.crc32(data); const comp = zlib.deflateRawSync(data);
    const name = Buffer.from('ZimaVideo-Ajudante/' + n);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(dosTime.t, 10); h.writeUInt16LE(dosTime.d, 12); h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime.t, 12); c.writeUInt16LE(dosTime.d, 14); c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...parts, cd, end]);
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': 'attachment; filename="ZimaVideo-Ajudante.zip"', 'Cache-Control': 'no-store' });
  res.end(zip);
}

// ---- ajudante (PC): autenticado por código próprio (Bearer), não pela senha de administrador
const workerJobs = new Map(); // path -> até quando está reservado para um ajudante
const workerFails = new Map();
async function createWorkerToken(name) {
  const w = await loadJSON(WORKER_FILE, { tokens: [] });
  const token = crypto.randomBytes(24).toString('base64url');
  w.tokens = (w.tokens || []).filter((t) => t.name !== name);
  w.tokens.push({ name: String(name || 'PC').slice(0, 40), hash: sha1('zv-worker|' + token), created: Date.now() });
  await saveJSON(WORKER_FILE, w);
  return { token };
}
async function revokeWorker(name) {
  const w = await loadJSON(WORKER_FILE, { tokens: [] });
  w.tokens = (w.tokens || []).filter((t) => t.name !== name);
  await saveJSON(WORKER_FILE, w);
  return { ok: true };
}
let workerSeenSave = 0;
async function requireWorker(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Código do ajudante ausente');
  const hash = sha1('zv-worker|' + h.slice(7).trim());
  const w = await loadJSON(WORKER_FILE, { tokens: [] });
  const t = (w.tokens || []).find((x) => x.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(hash)));
  if (!t) throw new HttpError(401, 'Código do ajudante inválido (gere outro no app)');
  t.lastSeen = Date.now(); lastWorkerSeen = Date.now();
  if (req.headers['x-worker-compress']) lastCompressWorker = Date.now();
  if (req.headers['x-worker-info']) t.info = String(req.headers['x-worker-info']).slice(0, 120);
  if (Date.now() - workerSeenSave > 30000) { workerSeenSave = Date.now(); await saveJSON(WORKER_FILE, w); }
  return t;
}
let workerInfoV = 0;
async function nextWorkerJob() {
  const idx = await getIndex();
  const now = Date.now();
  for (const it of idx) {
    if (it.t !== 'video') continue;
    if (faceVideos.has(it.p) || faceExcluded(it.p)) continue;
    if ((workerJobs.get(it.p) || 0) > now) continue;
    if ((workerFails.get(it.p) || 0) >= 3) continue;
    const abs = path.join(ROOT, it.p);
    const st = await statSafe(abs); if (!st) continue;
    let duration = 0; try { duration = (await probe(abs)).duration; } catch { workerFails.set(it.p, (workerFails.get(it.p) || 0) + 1); continue; }
    workerJobs.set(it.p, now + 15 * 60000);
    return { path: it.p, key: `${st.size}|${st.mtimeMs}`, duration, url: `/api/worker/file?${new URLSearchParams({ path: it.p })}` };
  }
  // tudo analisado: refaz com a análise nova (mais precisa) os vídeos analisados pela versão antiga do ajudante,
  // começando pelos que têm tag de pessoa (são os que mais ajudam o reconhecimento)
  const wantV = +(workerInfoV || 0);
  if (wantV >= 2) {
    const db = await loadTags();
    const personTags = new Set(Object.entries(db.tags).filter(([, v]) => v.person).map(([t]) => t));
    const old = idx.filter((it) => it.t === 'video' && !faceExcluded(it.p) && faceVideos.has(it.p) && (faceVideos.get(it.p).v || 1) < wantV
      && faceVideos.get(it.p).status !== 'failed' && !((workerJobs.get(it.p) || 0) > now) && (workerFails.get(it.p) || 0) < 3);
    old.sort((a, b) => ((db.items[b.p] || []).some((t) => personTags.has(t)) ? 1 : 0) - ((db.items[a.p] || []).some((t) => personTags.has(t)) ? 1 : 0));
    for (const it of old.slice(0, 20)) {
      const abs = path.join(ROOT, it.p);
      const st = await statSafe(abs); if (!st) continue;
      let duration = 0; try { duration = (await probe(abs)).duration; } catch { workerFails.set(it.p, (workerFails.get(it.p) || 0) + 1); continue; }
      workerJobs.set(it.p, now + 15 * 60000);
      return { path: it.p, key: `${st.size}|${st.mtimeMs}`, duration, upgrade: true, url: `/api/worker/file?${new URLSearchParams({ path: it.p })}` };
    }
  }
  // vídeos que deram erro (ex.: falha da placa de vídeo no PC, já contornada nas versões novas do ajudante):
  // tenta de novo sozinho, até 2 vezes por vez que o servidor liga, depois de 10 minutos
  for (const it of idx) {
    if (it.t !== 'video' || faceExcluded(it.p)) continue;
    const rec = faceVideos.get(it.p);
    if (!rec || rec.status !== 'failed' || now - (rec.at || 0) < 10 * 60000) continue;
    if ((workerJobs.get(it.p) || 0) > now || (workerRetry.get(it.p) || 0) >= 2) continue;
    const abs = path.join(ROOT, it.p);
    const st = await statSafe(abs); if (!st) continue;
    let duration = 0; try { duration = (await probe(abs)).duration; } catch { continue; }
    workerRetry.set(it.p, (workerRetry.get(it.p) || 0) + 1);
    workerJobs.set(it.p, now + 15 * 60000);
    return { path: it.p, key: `${st.size}|${st.mtimeMs}`, duration, retry: true, url: `/api/worker/file?${new URLSearchParams({ path: it.p })}` };
  }
  return { none: true, wait: 60 };
}
const workerRetry = new Map();
// reanálise de um vídeo: cada rosto antigo marcado (referência, negativo, ignorado...) passa para o rosto
// novo mais parecido do mesmo vídeo (se for claramente o mesmo), para não perder o que o usuário ensinou
function migrateFaceIdentity(oldFaces, newFaces) {
  if (!newFaces.length) return;
  const mapId = new Map();
  for (const o of oldFaces) {
    let best = null; let bs = 0.55;
    for (const n of newFaces) { const x = dot(o.emb, n.emb); if (x > bs) { bs = x; best = n; } }
    if (best) mapId.set(o.id, best.id);
  }
  if (!mapId.size) return;
  const swap = (list) => [...new Set(list.map((id) => mapId.get(id) || id))];
  for (const t of Object.keys(peopleDb.refs)) peopleDb.refs[t] = swap(peopleDb.refs[t]);
  for (const t of Object.keys(peopleDb.neg)) peopleDb.neg[t] = swap(peopleDb.neg[t]);
  for (const k of ['ignored', 'auto']) {
    for (const [id, v] of Object.entries(peopleDb[k])) { const n = mapId.get(id); if (n) { delete peopleDb[k][id]; peopleDb[k][n] = v; } }
  }
  for (const key of Object.keys(peopleDb.blocked)) {
    const i = key.lastIndexOf('|'); const n = mapId.get(key.slice(i + 1));
    if (n) { delete peopleDb.blocked[key]; peopleDb.blocked[`${key.slice(0, i)}|${n}`] = 1; }
  }
  savePeople();
}
// recortes de rosto na memória (os mais usados), para a tela Pessoas abrir rápido
const cropMem = new Map(); let cropMemBytes = 0;
async function cropBytes(id) {
  if (cropMem.has(id)) { const b = cropMem.get(id); cropMem.delete(id); cropMem.set(id, b); return b; }
  let b; try { b = await fsp.readFile(path.join(PEOPLE_DIR, 'c', id.slice(0, 2), id + '.jpg')); } catch { return null; }
  cropMem.set(id, b); cropMemBytes += b.length;
  while (cropMemBytes > 48 * 1024 * 1024 && cropMem.size) { const [k, v] = cropMem.entries().next().value; cropMem.delete(k); cropMemBytes -= v.length; }
  return b;
}
async function workerResult(body) {
  const rel = relOf(resolveSafe(body.path));
  if (!(await statSafe(path.join(ROOT, rel)))) throw new HttpError(404, 'Arquivo não existe mais');
  const faces = [];
  for (const f of (body.faces || []).slice(0, 200)) {
    if (!f.emb) continue;
    const emb = b64ToEmb(f.emb); if (emb.length !== 512) continue;
    const id = crypto.randomBytes(6).toString('hex');
    if (f.crop) {
      const cf = path.join(PEOPLE_DIR, 'c', id.slice(0, 2), id + '.jpg');
      await fsp.mkdir(path.dirname(cf), { recursive: true });
      await fsp.writeFile(cf, Buffer.from(f.crop, 'base64'));
    }
    faces.push({ id, t: +f.t || 0, score: +f.score || 0, n: +f.n || 1, g: f.group != null ? +f.group : null, emb, ...(f.q != null ? { q: +f.q } : {}) });
  }
  const groups = [];
  for (const g of (body.groups || []).slice(0, 100)) {
    const tpl = g.tpl ? b64ToEmb(g.tpl) : null; if (!tpl || tpl.length !== 512) continue;
    groups.push({ g: +g.g, tpl, q: +g.q || 0, n: +g.n || 1, tracks: +g.tracks || 1, co: (g.co || []).map(Number).slice(0, 50) });
  }
  const rec = { key: body.key, at: Date.now(), frames: +body.frames || 0, status: body.error ? 'failed' : 'ok', v: +body.v || 1, faces, groups };
  // substitui análise antiga (apaga recortes antigos). O que você já ensinou sobre os rostos antigos
  // (rostos de referência, "não é ela", ignorados) passa para os rostos novos equivalentes.
  const old = faceVideos.get(rel);
  if (old && !body.error) migrateFaceIdentity(old.faces, faces);
  if (old) for (const f of old.faces) fs.rm(path.join(PEOPLE_DIR, 'c', f.id.slice(0, 2), f.id + '.jpg'), { force: true }, () => {});
  indexFaces(rel, rec);
  await saveFaceVideo(rel, rec);
  workerJobs.delete(rel);
  scheduleLearn();
  return { ok: true, faces: faces.length };
}

// ---------------------------------------------------------------- static
const staticGz = new Map();
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const abs = path.resolve(PUBLIC, '.' + path.posix.normalize(rel));
  if (!abs.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Proibido');
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Não encontrado');
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  const headers = {
    'Content-Type': MIME[extOf(abs)] || 'application/octet-stream', ETag: etag, Vary: 'Accept-Encoding',
    'Cache-Control': abs.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=604800' : 'no-cache',
  };
  // texto (js, css, html, svg): envia comprimido (gzip) e guarda a versão comprimida em memória
  if (/^(js|css|html|svg|json|webmanifest)$/.test(extOf(abs)) && acceptsGzip(req)) {
    const k = `${abs}|${st.mtimeMs}`;
    let gz = staticGz.get(k);
    if (!gz) { gz = zlib.gzipSync(await fsp.readFile(abs), { level: 9 }); staticGz.set(k, gz); }
    headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------- auth
function checkAuth(req, res) {
  if (!AUTH_USER) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    const a = Buffer.from(`${u}:${p.join(':')}`); const b = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Zima Video", charset="UTF-8"' });
  res.end('Autenticação necessária');
  return false;
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/api/worker/') && !checkAuth(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    const p = u.pathname;
    if (!p.startsWith('/api/')) return await serveStatic(req, res, p);

    switch (p) {
      case '/api/list': lastUserActivity = Date.now(); return sendJSON(res, await listDir(q.get('path') || ''));
      case '/api/views': {
        if (q.get('clear')) { await requireAdmin(req); return sendJSON(res, await clearViews(q.get('path') || '')); }
        return sendJSON(res, await addView(req, q.get('path') || ''));
      }
      case '/api/search': return sendJSON(res, await search(q.get('q') || '', q.get('scope') || '', q.get('media') !== '0'));
      case '/api/reindex': await buildIndex(); return sendJSON(res, { ok: true, count: index.length });
      case '/api/info': {
        const abs = resolveSafe(q.get('path'));
        const [info, sidecar] = await Promise.all([probe(abs), sidecarSubs(abs)]);
        return sendJSON(res, { ...info, sidecar, hwaccel: HWACCEL });
      }
      case '/api/file': return await serveFile(req, res, resolveSafe(q.get('path')), { download: q.get('download') === '1' });
      case '/api/remux-plan': {
        const abs = resolveSafe(q.get('path'));
        return sendJSON(res, await remuxPlan(abs, Math.max(0, parseFloat(q.get('t') || '0') || 0)));
      }
      case '/api/stream': return await serveProgressive(req, res, resolveSafe(q.get('path')), q);
      case '/api/hls/index.m3u8': {
        const body = await hlsPlaylist(resolveSafe(q.get('path')), q);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      case '/api/hls/seg.ts': return await hlsSegment(req, res, q);
      case '/api/preview': {
        if (!PREVIEWS) throw new HttpError(404, 'Prévias desativadas');
        lastUserActivity = Date.now();
        const file = await previewClip(resolveSafe(q.get('path')));
        return await serveFile(req, res, file, { cache: true, immutable: !!q.get('v') });
      }
      case '/api/storyboard': {
        lastUserActivity = Date.now();
        const abs = resolveSafe(q.get('path'));
        if (q.get('n')) {
          const { dir } = await storyboardInfo(abs);
          const n = Math.max(1, parseInt(q.get('n'), 10) || 1);
          return await serveFile(req, res, path.join(dir, `sb_${n}.jpg`), { cache: true, immutable: !!q.get('v') });
        }
        // primeira consulta: começa a gerar e responde na hora (o player pergunta de novo depois)
        return sendJSON(res, await storyboard(abs, { wait: false }).catch(() => ({ ready: false, failed: true })));
      }
      case '/api/pregen': return sendJSON(res, { enabled: pregen.enabled, mode: PREGEN, running: pregen.running, total: pregen.total, done: pregen.done, current: pregen.current });
      case '/api/thumb': {
        if (!THUMBNAILS && !q.get('t')) throw new HttpError(404, 'Miniaturas desativadas');
        const abs = resolveSafe(q.get('path'));
        const t = q.get('t');
        // exact=1: quadro grande no momento pedido (ampliar um rosto encontrado pela análise)
        const exact = !!q.get('exact') && t != null;
        const w = Math.min(exact ? 1280 : 640, Math.max(80, parseInt(q.get('w') || '320', 10) || 320));
        lastUserActivity = Date.now();
        const tt = t == null ? 'auto' : exact ? (Math.round(parseFloat(t) * 10) / 10).toFixed(1) : String(Math.round(parseFloat(t) / 5) * 5);
        const job = thumbnail(abs, tt, w, { hq: exact });
        // se não fica pronta logo, responde "tente de novo" em vez de segurar a conexão: o navegador só abre
        // ~6 conexões por servidor, e miniaturas esperando travavam a navegação entre pastas
        const file = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), 400))]);
        if (!file) {
          // imagem de 1×1 = "ainda gerando" (uma <img> não consegue ler o status HTTP); o app tenta de novo
          job.catch(() => {});
          res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'X-Pending': '1', 'Content-Length': PENDING_GIF.length });
          return res.end(PENDING_GIF);
        }
        return await serveFile(req, res, file, { cache: true, immutable: !!q.get('v') });
      }
      case '/api/subtitle': {
        const vtt = await subtitle(q);
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
        return res.end(vtt);
      }
      case '/api/admin/login': return sendJSON(res, await adminLogin(req, res));
      case '/api/admin/logout':
        res.setHeader('Set-Cookie', 'zv_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return sendJSON(res, { ok: true });
      case '/api/admin/status': return sendJSON(res, {
        enabled: await adminEnabled(), logged: await isAdmin(req), fromEnv: !!ADMIN_PASSWORD, readonly: readonlyMounts(),
      });
      case '/api/admin/setup': return sendJSON(res, await adminSetup(req, res));
      case '/api/admin/password': return sendJSON(res, await adminChangePassword(req));
      case '/api/fs': { await requireAdmin(req); return sendJSON(res, await fsAction(q.get('action'), await readBody(req))); }
      case '/api/tags': {
        if (req.method === 'POST') {
          await requireAdmin(req); const body = await readBody(req);
          const act = q.get('action');
          return sendJSON(res, act === 'edit' ? await editTag(body) : act === 'merge' ? await mergeTags(body) : await assignTags(body));
        }
        if (q.get('similar')) { await requireAdminGet(req); return sendJSON(res, await similarTags()); }
        if (q.get('tag')) return sendJSON(res, await itemsWithTag(q.get('tag')));
        return sendJSON(res, await listTags());
      }
      // ---- pessoas (administrador)
      case '/api/people/status': await requireAdminGet(req); return sendJSON(res, await peopleStatus());
      case '/api/people/name-check': await requireAdmin(req); return sendJSON(res, await checkName((await readBody(req)).name));
      case '/api/people/names': await requireAdmin(req); return sendJSON(res, await nameSuggestions((await readBody(req)).scope || ''));
      case '/api/people/persons': {
        // todas as pessoas de uma vez (para a barra lateral): rosto para o avatar e números
        await requireAdminGet(req);
        const db = await loadTags();
        const count = {};
        for (const list of Object.values(db.items)) for (const t of list) count[t] = (count[t] || 0) + 1;
        const sugg = {}; for (const x of await faceSuggestions()) sugg[x.tag] = (sugg[x.tag] || 0) + 1;
        const out = Object.entries(db.tags).filter(([, v]) => v.person).map(([t, v]) => {
          const ids = (peopleDb.refs[t] || []).filter((id) => faceById.has(id));
          const p = ids.length ? protosOf(t) : null;
          const best = ids.filter((id) => !(p && p.bad.has(id))).sort((a, b) => ((faceById.get(b).face.q || 0.6) - (faceById.get(a).face.q || 0.6)))[0] || ids[0] || null;
          return { tag: t, color: v.color, count: count[t] || 0, refs: ids.length, bad: p ? p.bad.size : 0, face: best, sugg: sugg[t] || 0, thr: p ? +p.thr.toFixed(2) : FACE_MATCH };
        }).sort((a, b) => ptSort(a.tag, b.tag));
        return sendJSON(res, { persons: out });
      }
      case '/api/people/apply': await requireAdmin(req); return sendJSON(res, await applySuggestions((await readBody(req)).pairs));
      case '/api/people/questions': {
        await requireAdminGet(req);
        const r = await learnFromTags();
        // uma pergunta por pessoa (a mais fácil): a resposta costuma resolver os outros vídeos dela sozinha
        const one = new Map();
        for (const qq of r.questions) {
          const k = qq.kind + '|' + qq.tag; const cur = one.get(k);
          if (!cur) one.set(k, { ...qq, more: 0 });
          else { cur.more++; if (qq.options.length < cur.options.length) one.set(k, { ...qq, more: cur.more }); }
        }
        return sendJSON(res, { learned: r.learned, questions: [...one.values()].slice(0, 100), total: r.questions.length, auto: Object.keys(peopleDb.auto).length, same: sameQuestions() });
      }
      case '/api/people/answer': await requireAdmin(req); return sendJSON(res, await answerQuestion(await readBody(req)));
      case '/api/people/clusters': await requireAdminGet(req); return sendJSON(res, { clusters: faceClusters().slice(0, 400).map(({ _mean, ...c }) => c) });
      case '/api/people/suggestions': await requireAdminGet(req); return sendJSON(res, { suggestions: await faceSuggestions() });
      case '/api/people/name': await requireAdmin(req); return sendJSON(res, await nameFaces(await readBody(req)));
      case '/api/people/ignore': await requireAdmin(req); return sendJSON(res, await ignoreFaces(await readBody(req)));
      case '/api/people/person': {
        await requireAdminGet(req);
        const t = q.get('tag') || '';
        const ids = (peopleDb.refs[t] || []).filter((id) => faceById.has(id)).slice(0, 60);
        const bad = protosOf(t).bad;
        // suspeitos primeiro, para revisar
        ids.sort((a, b) => (bad.has(b) ? 1 : 0) - (bad.has(a) ? 1 : 0));
        return sendJSON(res, { tag: t, faces: ids, auto: ids.filter((id) => peopleDb.auto[id]), bad: ids.filter((id) => bad.has(id)), neg: (peopleDb.neg[t] || []).length });
      }
      case '/api/people/reject': {
        // { tag, faces, path }: "não é esta pessoa" — vira exemplo negativo dela (não some para as outras pessoas)
        await requireAdmin(req); const b = await readBody(req);
        const t = cleanTagName(b.tag);
        addNeg(t, b.faces);
        if (b.path) peopleDb.answered[`${relOf(resolveSafe(b.path))}|${t}`] = 'none';
        await savePeople(); return sendJSON(res, { ok: true });
      }
      case '/api/people/reset-auto': {
        // { tag, only: 'bad' | 'auto' }: tira os suspeitos, ou tudo que foi aprendido sozinho (e não reaprende)
        await requireAdmin(req); const b = await readBody(req);
        const t = cleanTagName(b.tag);
        const bad = protosOf(t).bad;
        const drop = (peopleDb.refs[t] || []).filter((id) => (b.only === 'bad' ? bad.has(id) : peopleDb.auto[id]));
        peopleDb.refs[t] = (peopleDb.refs[t] || []).filter((id) => !drop.includes(id));
        for (const id of drop) { peopleDb.blocked[`${t}|${id}`] = 1; delete peopleDb.auto[id]; }
        // respostas automáticas baseadas nesses rostos são refeitas
        await savePeople(); return sendJSON(res, { ok: true, removed: drop.length });
      }
      case '/api/people/unlink': {
        await requireAdmin(req); const b = await readBody(req);
        peopleDb.refs[b.tag] = (peopleDb.refs[b.tag] || []).filter((id) => !(b.faces || []).includes(id));
        // não reaprender este rosto para esta pessoa
        for (const id of b.faces || []) { peopleDb.blocked[`${b.tag}|${id}`] = 1; delete peopleDb.auto[id]; }
        addNeg(b.tag, b.faces); // ensina que esse rosto não é a pessoa
        await savePeople(); return sendJSON(res, { ok: true });
      }
      case '/api/people/face': {
        // de onde veio um rosto: vídeo e momento (para ampliar e abrir o vídeo naquele ponto)
        await requireAdminGet(req);
        const f = faceById.get(q.get('id') || '');
        if (!f) throw new HttpError(404, 'Rosto não encontrado');
        return sendJSON(res, { id: f.face.id, path: f.path, name: path.posix.basename(f.path), t: f.face.t, score: f.face.score });
      }
      case '/api/people/crops': {
        // vários rostos de uma vez (a tela pede em lotes: bem mais rápido que um pedido por rosto)
        await requireAdminGet(req);
        const ids = String(q.get('ids') || '').split(',').map((x) => x.replace(/[^a-f0-9]/g, '')).filter(Boolean).slice(0, 120);
        const out = {};
        await Promise.all(ids.map(async (id) => { const b = await cropBytes(id); if (b) out[id] = b.toString('base64'); }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=86400' });
        return res.end(JSON.stringify(out));
      }
      case '/api/people/crop': {
        await requireAdminGet(req);
        const id = String(q.get('id') || '').replace(/[^a-f0-9]/g, '');
        return await serveFile(req, res, path.join(PEOPLE_DIR, 'c', id.slice(0, 2), id + '.jpg'), { cache: true, immutable: true });
      }
      case '/api/people/worker-token': await requireAdmin(req); return sendJSON(res, await createWorkerToken((await readBody(req)).name));
      case '/api/people/worker-revoke': await requireAdmin(req); return sendJSON(res, await revokeWorker((await readBody(req)).name));
      case '/api/people/worker.zip': await requireAdminGet(req); return await sendWorkerZip(res);
      case '/api/people/exclude': {
        // GET: listas; POST { path, on, kind }: tira (on=true) ou devolve (on=false) uma pasta da análise
        // de rosto (kind 'faces') ou da busca pelo nome do arquivo (kind 'names')
        if (req.method === 'GET') { await requireAdminGet(req); return sendJSON(res, { excluded: peopleDb.excluded, names: peopleDb.nameExcluded, compress: peopleDb.compressExcluded }); }
        await requireAdmin(req); const b = await readBody(req);
        const list = b.kind === 'names' ? 'nameExcluded' : b.kind === 'compress' ? 'compressExcluded' : 'excluded';
        const r = relOf(resolveSafe(b.path || ''));
        const st = await statSafe(path.join(ROOT, r));
        if (b.on && (!r || !st || !st.isDirectory())) throw new HttpError(400, r ? 'Pasta não encontrada' : 'Escolha uma pasta');
        const set = new Set(peopleDb[list]);
        if (b.on) set.add(r); else set.delete(r);
        peopleDb[list] = [...set].sort(ptSort);
        await savePeople();
        let cancelled = 0;
        if (list === 'compressExcluded' && b.on) {
          // o que ainda estava na fila dessa pasta sai da fila
          const db = await loadCompress();
          for (const i of db.items) if (i.status === 'queued' && compressExcluded(i.path)) { i.status = 'cancelled'; i.note = 'pasta excluída da compressão'; cancelled++; }
          if (cancelled) await saveCompress(true);
        }
        return sendJSON(res, { ok: true, excluded: peopleDb.excluded, names: peopleDb.nameExcluded, compress: peopleDb.compressExcluded, cancelled });
      }
      case '/api/people/name-ignore': {
        // GET: nomes marcados como "não é nome de pessoa"; POST { names: [...], on }: marca/desmarca
        if (req.method === 'GET') { await requireAdminGet(req); return sendJSON(res, { names: Object.values(peopleDb.nameIgnored).sort(ptSort) }); }
        await requireAdmin(req); const b = await readBody(req);
        for (const n of b.names || []) { const k = normName(n).trim(); if (!k) continue; if (b.on === false) delete peopleDb.nameIgnored[k]; else peopleDb.nameIgnored[k] = String(n).slice(0, 80); }
        await savePeople(); return sendJSON(res, { ok: true });
      }
      case '/api/people/name-reject': {
        // { pairs: [{ path, tag }] }: o nome encontrado neste arquivo não é esta pessoa (não sugerir de novo)
        await requireAdmin(req); const b = await readBody(req);
        for (const x of b.pairs || []) peopleDb.nameRejected[`${relOf(resolveSafe(x.path))}|${cleanTagName(x.tag)}`] = 1;
        await savePeople(); return sendJSON(res, { ok: true });
      }
      case '/api/people/alias': {
        // { tag, alias }: outra grafia do nome da pessoa (ex.: erro de digitação nos arquivos)
        await requireAdmin(req); const b = await readBody(req);
        const db = await loadTags(); const t = cleanTagName(b.tag);
        if (!db.tags[t]) throw new HttpError(404, 'Tag não encontrada');
        const al = new Set(db.tags[t].aliases || []); al.add(String(b.alias || '').replace(/\s+/g, ' ').trim().slice(0, 60));
        al.delete(''); db.tags[t].aliases = [...al].slice(0, 30);
        if (b.person) db.tags[t].person = true;
        await saveTags(); return sendJSON(res, { ok: true, ...(await listTags()) });
      }
      case '/api/people/reanalyze': {
        await requireAdmin(req); const b = await readBody(req);
        for (const p of b.paths || []) { const r = relOf(resolveSafe(p)); fs.rm(videoFile(r), { force: true }, () => {}); indexFaces(r, null); workerFails.delete(r); }
        if (b.failed) for (const [r, rec] of [...faceVideos]) if (rec.status === 'failed') { fs.rm(videoFile(r), { force: true }, () => {}); indexFaces(r, null); }
        return sendJSON(res, { ok: true });
      }
      // ---- ajudante (PC)
      case '/api/worker/hello': { const t = await requireWorker(req); return sendJSON(res, { ok: true, name: t.name }); }
      case '/api/worker/job': {
        await requireWorker(req);
        workerInfoV = +(req.headers['x-worker-v'] || 0); // versão da análise que este ajudante faz
        const job = await nextWorkerJob();
        const st = await peopleStatus(); // para a janela do ajudante mostrar "X de Y vídeos analisados"
        return sendJSON(res, { ...job, progress: { done: st.analyzed, total: st.videos, failed: st.failed } });
      }
      case '/api/worker/result': await requireWorker(req); return sendJSON(res, await workerResult(await readBody(req, 64 * 1024 * 1024)));
      case '/api/worker/compress-job': { const t = await requireWorker(req); return sendJSON(res, await compressJobForWorker(t)); }
      case '/api/worker/compress-caps': {
        // o que este PC consegue comprimir (testado lá): o app mostra, e o servidor não manda o que ele não consegue
        const t = await requireWorker(req); const b = await readBody(req);
        const caps = {};
        for (const c of ['av1', 'hevc', 'h264']) if (b[c]) caps[c] = { enc: b[c].enc ? String(b[c].enc).slice(0, 40) : null, label: b[c].label ? String(b[c].label).slice(0, 60) : null, error: b[c].error ? String(b[c].error).slice(0, 300) : null };
        const w = await loadJSON(WORKER_FILE, { tokens: [] });
        const rec = (w.tokens || []).find((x) => x.hash === t.hash);
        if (rec) { rec.caps = caps; rec.capsAt = Date.now(); await saveJSON(WORKER_FILE, w); }
        return sendJSON(res, { ok: true });
      }
      case '/api/worker/compress-progress': {
        await requireWorker(req); const b = await readBody(req);
        const it = (await loadCompress()).items.find((i) => i.id === b.id);
        if (!it || it.status !== 'working') return sendJSON(res, { cancel: true });
        it.pct = Math.max(0, Math.min(99, +b.pct || 0)); it.beat = Date.now(); if (b.speed) it.speed = String(b.speed).slice(0, 20);
        it.stage = b.stage ? String(b.stage).slice(0, 60) : null; saveCompress();
        return sendJSON(res, { ok: true });
      }
      case '/api/worker/compress-fail': {
        await requireWorker(req); const b = await readBody(req);
        const it = (await loadCompress()).items.find((i) => i.id === b.id);
        if (it && it.status === 'working') {
          if (b.skip) { it.status = 'skipped'; it.note = String(b.note || 'não compensa').slice(0, 200); it.vmaf = b.vmaf || null; it.finished = Date.now(); }
          else { it.status = b.retry ? 'queued' : 'failed'; it.error = String(b.error || '').slice(0, 300); it.pct = 0; }
          await saveCompress(true);
        }
        return sendJSON(res, { ok: true });
      }
      case '/api/worker/compress-upload': { await requireWorker(req); return sendJSON(res, await compressUpload(req, q.get('id') || '')); }
      case '/api/compress': {
        if (req.method === 'GET') { await requireAdminGet(req); return sendJSON(res, await compressStatus()); }
        await requireAdmin(req); const b = await readBody(req);
        const act = q.get('action');
        if (act === 'estimate') return sendJSON(res, await compressEstimate(b));
        if (act === 'add') return sendJSON(res, await compressAdd(b));
        const db = await loadCompress();
        if (act === 'cancel') {
          for (const i of db.items) if ((b.all || (b.ids || []).includes(i.id)) && ['queued', 'working'].includes(i.status)) {
            i.status = 'cancelled';
            if (compressLocal && compressLocal.it === i) compressLocal.proc.kill('SIGKILL');
          }
        } else if (act === 'retry') {
          for (const i of db.items) if ((b.ids || []).includes(i.id) && ['failed', 'cancelled'].includes(i.status) && !compressExcluded(i.path)) { i.status = 'queued'; i.pct = 0; i.error = null; i.note = null; }
          setTimeout(compressTick, 500);
        } else if (act === 'clear') db.items = db.items.filter((i) => ['queued', 'working'].includes(i.status));
        await saveCompress(true);
        return sendJSON(res, await compressStatus());
      }
      case '/api/worker/file': await requireWorker(req); return await serveFile(req, res, resolveSafe(q.get('path')));
      case '/api/favorites': {
        if (req.method === 'POST') return sendJSON(res, await setFavorite(q.get('path') || '', q.get('on') !== '0'));
        return sendJSON(res, await listFavorites());
      }
      case '/api/config': return sendJSON(res, { thumbnails: THUMBNAILS, previews: PREVIEWS, hwaccel: HWACCEL, segment: SEG });
      default: throw new HttpError(404, 'Rota não encontrada');
    }
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error('[erro]', req.url, e.message);
    if (!res.headersSent) sendJSON(res, { error: e.message }, code);
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Zima Video em http://0.0.0.0:${PORT}  (mídia: ${ROOT}, cache: ${CACHE}, hwaccel: ${HWACCEL})`);
  getIndex().catch((e) => console.warn('[busca] falha ao indexar:', e.message));
  setTimeout(warmPeople, 5000); // calcula Pessoas logo depois de ligar (a primeira abertura fica rápida)
  loadTags().catch(() => {});
  loadViews().catch(() => {});
  adminEnabled().then((on) => console.log(on ? 'Modo administrador: ativado' : 'Modo administrador: sem senha (crie pelo menu ⋮ do app)'));
  const ro = readonlyMounts(); if (ro.length) console.log('Somente leitura:', ro.join(', '));
});

process.on('SIGTERM', () => {
  for (const job of hlsJobs.values()) if (job.proc) job.proc.kill('SIGKILL');
  process.exit(0);
});
