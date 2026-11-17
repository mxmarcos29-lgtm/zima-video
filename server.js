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
      entries.push({ name: d.name, type: dir ? 'dir' : typeOf(d.name), size: dir ? 0 : s.size, mtime: s.mtimeMs });
    });
  }
  return entries;
}

// ---------------------------------------------------------------- search index
let index = null; let indexBuiltAt = 0; let indexBuilding = null;

async function buildIndex() {
  const t0 = Date.now();
  const out = [];
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
      out.push({ p: rel, n: norm(d.name), d: isDir, t: isDir ? 'dir' : typeOf(d.name) });
      if (isDir) stack.push(abs);
    }
  }
  index = out; indexBuiltAt = Date.now();
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
      index: i, codec: s.codec_name, profile: s.profile || '', channels: s.channels || 0,
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
async function thumbnail(abs, t, width, { bg = false } = {}) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const key = sha1(`${abs}|${st.size}|${st.mtimeMs}|${t}|${width}`);
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
      '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:-2:flags=bilinear`, '-q:v', t === 'auto' ? '4' : '7', '-y', tmp], { timeout: 30000, bg });
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
async function loadTags() {
  if (!tagDb) {
    tagDb = await loadJSON(TAG_FILE, null);
    if (!tagDb || typeof tagDb !== 'object') tagDb = {};
    tagDb.tags = tagDb.tags || {}; tagDb.items = tagDb.items || {};
  }
  return tagDb;
}
const saveTags = () => saveJSON(TAG_FILE, tagDb);
const tagsOf = (rel) => (tagDb && tagDb.items[rel]) || undefined;
const ptCollator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const ptSort = (a, b) => ptCollator.compare(a, b);
function cleanTagName(n) {
  n = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) throw new HttpError(400, 'Nome de tag vazio');
  return n;
}
async function listTags() {
  const db = await loadTags();
  const count = {};
  for (const list of Object.values(db.items)) for (const t of list) count[t] = (count[t] || 0) + 1;
  const tags = Object.entries(db.tags).map(([name, v]) => ({ name, color: v.color, count: count[name] || 0 }))
    .sort((a, b) => ptSort(a.name, b.name));
  return { tags };
}
async function assignTags({ paths, add = [], remove = [] }) {
  const db = await loadTags();
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nenhum item selecionado');
  add = add.map(cleanTagName); remove = remove.map(cleanTagName);
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
async function editTag({ name, newName, color, remove }) {
  const db = await loadTags();
  name = cleanTagName(name);
  if (!db.tags[name]) throw new HttpError(404, 'Tag não encontrada');
  if (remove) {
    delete db.tags[name];
    for (const [k, list] of Object.entries(db.items)) { const l = list.filter((t) => t !== name); if (l.length) db.items[k] = l; else delete db.items[k]; }
  } else {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) db.tags[name].color = color;
    if (newName && cleanTagName(newName) !== name) {
      const nn = cleanTagName(newName);
      if (db.tags[nn]) throw new HttpError(409, 'Já existe uma tag com esse nome');
      db.tags[nn] = db.tags[name]; delete db.tags[name];
      for (const [k, list] of Object.entries(db.items)) db.items[k] = [...new Set(list.map((t) => (t === name ? nn : t)))].sort(ptSort);
    }
  }
  await saveTags();
  return listTags();
}
async function itemsWithTag(tag) {
  const db = await loadTags();
  const out = [];
  for (const [rel, list] of Object.entries(db.items)) {
    if (!list.includes(tag)) continue;
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
    if (!checkAuth(req, res)) return;
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
        const w = Math.min(640, Math.max(80, parseInt(q.get('w') || '320', 10) || 320));
        lastUserActivity = Date.now();
        const job = thumbnail(abs, t == null ? 'auto' : String(Math.round(parseFloat(t) / 5) * 5), w);
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
          return sendJSON(res, q.get('action') === 'edit' ? await editTag(body) : await assignTags(body));
        }
        if (q.get('tag')) return sendJSON(res, await itemsWithTag(q.get('tag')));
        return sendJSON(res, await listTags());
      }
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
  loadTags().catch(() => {});
  loadViews().catch(() => {});
  adminEnabled().then((on) => console.log(on ? 'Modo administrador: ativado' : 'Modo administrador: sem senha (crie pelo menu ⋮ do app)'));
  const ro = readonlyMounts(); if (ro.length) console.log('Somente leitura:', ro.join(', '));
});

process.on('SIGTERM', () => {
  for (const job of hlsJobs.values()) if (job.proc) job.proc.kill('SIGKILL');
  process.exit(0);
});
