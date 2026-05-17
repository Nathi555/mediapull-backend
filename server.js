const express   = require('express');
const cors      = require('cors');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT     = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const TTL_MS   = 30 * 60 * 1000;
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Invidious Instanzen ───────────────────────────────────
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.privacydev.net',
  'https://yt.artemislena.eu',
  'https://invidious.flossboxin.org.in',
  'https://invidious.nerdvpn.de',
  'https://iv.ggtyler.dev',
  'https://invidious.io',
];

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MediaPull/1.0)' },
      timeout: 12000
    }, res => {
      // Redirect folgen
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`[http] ${url.slice(0,60)} → ${res.statusCode} (${d.length}b)`);
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0,80)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getStreams(videoId, quality, isAudio) {
  const maxHeight = quality === 'max' ? 9999 : parseInt(quality);
  for (const base of INVIDIOUS) {
    try {
      console.log('[inv] versuche', base);
      const data = await get(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams,title`);
      if (!data) continue;

      const adaptive = data.adaptiveFormats || [];
      const formats  = data.formatStreams  || [];

      // Bester Audio-Stream
      const audioStream = adaptive
        .filter(f => f.type && f.type.startsWith('audio/') && f.url)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0))[0];

      if (isAudio) {
        if (audioStream) { console.log('[inv] audio gefunden bei', base); return { audio: audioStream.url, title: data.title }; }
        continue;
      }

      // Bester Video-only Stream (adaptiveFormats) bis maxHeight
      const videoOnly = adaptive
        .filter(f => f.type && f.type.startsWith('video/') && f.url && !f.type.includes('audio'))
        .map(f => ({ ...f, h: parseInt(f.resolution || f.qualityLabel || '0') }))
        .filter(f => f.h > 0 && f.h <= maxHeight)
        .sort((a, b) => b.h - a.h)[0];

      // Fallback: kombinierter Stream (formatStreams, max 720p)
      const combined = formats
        .map(f => ({ ...f, h: parseInt(f.resolution || '0') }))
        .filter(f => f.h <= maxHeight)
        .sort((a, b) => b.h - a.h)[0];

      if (videoOnly && audioStream) {
        console.log(`[inv] video ${videoOnly.h}p + audio bei`, base);
        return { video: videoOnly.url, audio: audioStream.url, title: data.title, q: videoOnly.h };
      }
      if (combined) {
        console.log(`[inv] kombiniert ${combined.h}p bei`, base);
        return { combined: combined.url, title: data.title, q: combined.h };
      }
    } catch(e) {
      console.log('[inv]', base, '→', e.message);
    }
  }
  return null;
}

function dlFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        return dlFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

function ffmpeg(...args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', d => err += d);
    ff.on('close', code => { if (code === 0) resolve(); else reject(new Error(`ffmpeg: ${err.slice(-200)}`)); });
    ff.on('error', reject);
  });
}

// ── POST /api/download ────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { url, downloadMode = 'auto', videoQuality = 'max' } = req.body;
  if (!url || !/^https?:\/\//i.test(url))
    return res.status(400).json({ status: 'error', message: 'Ungültige URL' });

  const isAudio = downloadMode === 'audio';
  const id      = uuidv4();
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Keine gültige YouTube-URL' });

  console.log(`[req] ${videoId} mode=${downloadMode} quality=${videoQuality}`);

  try {
    const streams = await getStreams(videoId, videoQuality, isAudio);
    if (!streams) return res.status(500).json({ status: 'error', message: 'Kein Stream verfügbar. Alle Invidious-Server nicht erreichbar.' });

    if (isAudio) {
      const raw = path.join(TEMP_DIR, `${id}_raw`);
      const mp3 = path.join(TEMP_DIR, `${id}.mp3`);
      await dlFile(streams.audio, raw);
      await ffmpeg('-i', raw, '-vn', '-ab', '192k', '-ar', '44100', '-y', mp3);
      fs.unlink(raw, () => {});
      return send(res, mp3, 'audio/mpeg', 'download.mp3');
    }

    if (streams.combined) {
      const out = path.join(TEMP_DIR, `${id}.mp4`);
      await dlFile(streams.combined, out);
      return send(res, out, 'video/mp4', 'download.mp4');
    }

    // Video + Audio separat → merge
    const vf  = path.join(TEMP_DIR, `${id}_v`);
    const af  = path.join(TEMP_DIR, `${id}_a`);
    const out = path.join(TEMP_DIR, `${id}.mp4`);
    console.log('[dl] lade Video + Audio parallel...');
    await Promise.all([dlFile(streams.video, vf), dlFile(streams.audio, af)]);
    console.log('[ffmpeg] merge...');
    await ffmpeg('-i', vf, '-i', af, '-c:v', 'copy', '-c:a', 'aac', '-y', out);
    fs.unlink(vf, () => {}); fs.unlink(af, () => {});
    return send(res, out, 'video/mp4', 'download.mp4');

  } catch(e) {
    console.error('[error]', e.message);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: e.message });
  }
});

function send(res, file, mime, name) {
  if (!fs.existsSync(file)) return res.status(500).json({ status: 'error', message: 'Datei fehlt' });
  const size = fs.statSync(file).size;
  console.log('[send]', name, size, 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', size);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  const s = fs.createReadStream(file);
  s.pipe(res);
  s.on('end', () => setTimeout(() => fs.unlink(file, () => {}), 5000));
  s.on('error', () => { if (!res.headersSent) res.status(500).end(); });
}

// Cleanup
try { const n=Date.now(); fs.readdirSync(TEMP_DIR).forEach(f=>{const fp=path.join(TEMP_DIR,f);if(n-fs.statSync(fp).mtimeMs>TTL_MS)fs.unlinkSync(fp);}); } catch(e) {}

app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
