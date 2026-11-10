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
const INDEX_TTL = parseInt(process.env.SEARCH_INDEX_TTL || '600', 10) * 1000;
const SEG = 6; // duração dos segmentos HLS (s)
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

function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function run(cmd, args, { timeout = 120000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
function makeQueue(concurrency, maxWaiting = Infinity) {
  let active = 0; const waiting = [];
  const next = () => {
    if (active >= concurrency || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    // fila cheia: descarta os pedidos mais antigos (o usuário já rolou a tela para outro lugar)
    while (waiting.length > maxWaiting) waiting.shift().reject(new HttpError(503, 'Fila cheia'));
    next();
  });
}
const thumbQueue = makeQueue(parseInt(process.env.THUMB_CONCURRENCY || '2', 10));
const previewQueue = makeQueue(2);
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

async function listDir(rel) {
  const abs = resolveSafe(rel);
  const st = await statSafe(abs);
  if (!st) throw new HttpError(404, 'Pasta não encontrada');
  if (!st.isDirectory()) throw new HttpError(400, 'Não é uma pasta');
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
  return { path: relOf(abs), entries };
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
    return { path: it.p, name: path.posix.basename(it.p), type: it.t, size: s && !it.d ? s.size : 0, mtime: s ? s.mtimeMs : 0 };
  }));
  return { results: withStat, total, indexedAt: indexBuiltAt };
}

// ---------------------------------------------------------------- probe
const probeCache = new Map();

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
    const info = {
      duration: parseFloat((j.format && j.format.duration) || (v && v.duration) || 0) || 0,
      format: (j.format && j.format.format_name) || '',
      bitrate: parseInt((j.format && j.format.bit_rate) || 0, 10),
      title: (j.format && j.format.tags && (j.format.tags.title || j.format.tags.TITLE)) || '',
      start: parseFloat((j.format && j.format.start_time) || 0) || 0,
      video: v ? { codec: v.codec_name, profile: v.profile || '', level: v.level || 0, width: v.width, height: v.height, pix_fmt: v.pix_fmt || '', fps,
        start: parseFloat(v.start_time || (j.format && j.format.start_time) || 0) || 0 } : null,
      audio, subs,
    };
    probeCache.set(key, info);
    if (probeCache.size > 2000) probeCache.delete(probeCache.keys().next().value);
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
async function serveFile(req, res, abs, { download = false, cache = false } = {}) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const type = MIME[extOf(abs)] || 'application/octet-stream';
  const headers = {
    'Content-Type': type, 'Accept-Ranges': 'bytes',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'Cache-Control': cache ? 'public, max-age=86400' : 'private, max-age=0, must-revalidate',
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
  res.on('close', () => stream.destroy());
}

// ---------------------------------------------------------------- transcodificação
function targetSize(info, h) {
  const v = info.video;
  if (!v || !v.width || !v.height) return null;
  const th = Math.min(h || v.height, v.height);
  const ev = (x) => Math.max(2, Math.round(x / 2) * 2);
  return { w: ev((v.width * th) / v.height), h: ev(th) };
}

function videoEncodeArgs(info, h, hw, keyint) {
  const size = targetSize(info, h);
  const bitrate = { 2160: 16000, 1440: 10000, 1080: 6000, 720: 3500, 480: 1600, 360: 900 };
  const th = size ? size.h : 720;
  const maxrate = (Object.entries(bitrate).find(([k]) => th >= +k) || [0, 900])[1];
  const args = [];
  if (hw === 'vaapi') {
    args.push('-vf', `format=nv12|vaapi,hwupload,scale_vaapi=w=${size ? size.w : -2}:h=${th}`);
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
  res.on('close', () => { closed = true; if (proc) proc.kill('SIGKILL'); });
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
async function thumbnail(abs, t, width) {
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
  const key = sha1(`${abs}|${st.size}|${st.mtimeMs}|${t}|${width}`);
  const out = path.join(CACHE, 'thumbs', key.slice(0, 2), key + '.jpg');
  if (await exists(out)) return out;
  const failMark = out + '.fail';
  if (await exists(failMark)) throw new HttpError(404, 'Sem miniatura');
  const queue = t === 'auto' ? thumbQueue : previewQueue;
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
    const attempt = (ss) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(ss > 0 ? ['-ss', ss.toFixed(2)] : []), '-i', abs,
      '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:-2:flags=bilinear`, '-q:v', t === 'auto' ? '4' : '7', '-y', tmp], { timeout: 30000 });
    try {
      await attempt(at);
      if (!(await exists(tmp))) await attempt(0);
      if (!(await exists(tmp))) throw new Error('sem frame');
      await fsp.rename(tmp, out);
      return out;
    } catch (e) {
      fsp.rm(tmp, { force: true }).catch(() => {});
      if (t === 'auto') await fsp.writeFile(failMark, String(e.message)).catch(() => {});
      throw new HttpError(404, 'Sem miniatura');
    }
  }));
}

// ---------------------------------------------------------------- prévia em vídeo (estilo YouTube)
/**
 * Clipe curto e mudo (≈10s) com trechos de vários pontos do vídeo, em 16:9 pequeno.
 * Gerado uma vez e guardado no cache.
 */
async function previewClip(abs) {
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
      await run(FFMPEG, args, { timeout: 120000 });
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
      size: st && !dir ? st.size : 0, mtime: st ? st.mtimeMs : 0, added: f.added, missing: !st };
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

// ---------------------------------------------------------------- static
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const abs = path.resolve(PUBLIC, '.' + path.posix.normalize(rel));
  if (!abs.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Proibido');
  const st = await statSafe(abs);
  if (!st || !st.isFile()) throw new HttpError(404, 'Não encontrado');
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  res.writeHead(200, {
    'Content-Type': MIME[extOf(abs)] || 'application/octet-stream', 'Content-Length': st.size, ETag: etag,
    'Cache-Control': abs.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=604800' : 'no-cache',
  });
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
      case '/api/list': return sendJSON(res, await listDir(q.get('path') || ''));
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
        const file = await previewClip(resolveSafe(q.get('path')));
        return await serveFile(req, res, file, { cache: true });
      }
      case '/api/thumb': {
        if (!THUMBNAILS && !q.get('t')) throw new HttpError(404, 'Miniaturas desativadas');
        const abs = resolveSafe(q.get('path'));
        const t = q.get('t');
        const w = Math.min(640, Math.max(80, parseInt(q.get('w') || '320', 10) || 320));
        const file = await thumbnail(abs, t == null ? 'auto' : String(Math.round(parseFloat(t) / 5) * 5), w);
        return await serveFile(req, res, file, { cache: true });
      }
      case '/api/subtitle': {
        const vtt = await subtitle(q);
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
        return res.end(vtt);
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
});

process.on('SIGTERM', () => {
  for (const job of hlsJobs.values()) if (job.proc) job.proc.kill('SIGKILL');
  process.exit(0);
});
