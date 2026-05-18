const express   = require('express');
const cors      = require('cors');
const ytdl      = require('@distube/ytdl-core');
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

// ── Cookies parsen ────────────────────────────────────────
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
let agent = null;
if (process.env.YOUTUBE_COOKIES) {
  const data = process.env.YOUTUBE_COOKIES.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  fs.writeFileSync(COOKIES_FILE, data, 'utf8');
  try {
    const cookies = data.split('\n')
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const p = l.split('\t');
        if (p.length < 7) return null;
        return { name: p[5], value: p[6], domain: p[0], path: p[2], expires: parseInt(p[4]) || 0, httpOnly: false, secure: p[3] === 'TRUE' };
      }).filter(Boolean);
    agent = ytdl.createAgent(cookies);
    console.log('[cookies] agent erstellt mit', cookies.length, 'cookies');
  } catch(e) {
    console.error('[cookies] parse error:', e.message);
  }
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, cookies: !!agent }));

function dlStream(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        return dlStream(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function ffmpeg(...args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', d => err += d);
    ff.on('close', code => { if (code === 0) resolve(); else reject(new Error(err.slice(-300))); });
    ff.on('error', reject);
  });
}

function send(res, file, mime, name) {
  if (!fs.existsSync(file)) return res.status(500).json({ status: 'error', message: 'Datei fehlt' });
  console.log('[send]', name, fs.statSync(file).size, 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', fs.statSync(file).size);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  const s = fs.createReadStream(file);
  s.pipe(res);
  s.on('end', () => setTimeout(() => fs.unlink(file, () => {}), 5000));
  s.on('error', () => { if (!res.headersSent) res.status(500).end(); });
}

// ── POST /api/download ────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { url, downloadMode = 'auto', videoQuality = 'max' } = req.body;
  if (!url || !/^https?:\/\//i.test(url))
    return res.status(400).json({ status: 'error', message: 'Ungültige URL' });

  const isAudio = downloadMode === 'audio';
  const id = uuidv4();
  console.log(`[req] ${url} mode=${downloadMode} quality=${videoQuality}`);

  try {
    const opts = agent ? { agent } : {};
    const info = await ytdl.getInfo(url, opts);
    const title = info.videoDetails.title;
    console.log('[info] Titel:', title);

    if (isAudio) {
      const fmt = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
      const raw = path.join(TEMP_DIR, `${id}_raw`);
      const mp3 = path.join(TEMP_DIR, `${id}.mp3`);
      console.log('[audio] format:', fmt.mimeType, fmt.audioBitrate, 'kbps');
      await dlStream(fmt.url, raw);
      await ffmpeg('-i', raw, '-vn', '-ab', '192k', '-ar', '44100', '-y', mp3);
      fs.unlink(raw, () => {});
      return send(res, mp3, 'audio/mpeg', 'download.mp3');
    }

    // Video: beste Qualität bis maxHeight
    const maxH = videoQuality === 'max' ? 9999 : parseInt(videoQuality);
    const videoFmts = info.formats
      .filter(f => f.hasVideo && !f.hasAudio && f.height && f.height <= maxH)
      .sort((a, b) => b.height - a.height);
    const audioFmt = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    const out = path.join(TEMP_DIR, `${id}.mp4`);

    if (videoFmts.length > 0) {
      const vf = path.join(TEMP_DIR, `${id}_v`);
      const af = path.join(TEMP_DIR, `${id}_a`);
      console.log(`[video] ${videoFmts[0].height}p + audio parallel laden`);
      await Promise.all([dlStream(videoFmts[0].url, vf), dlStream(audioFmt.url, af)]);
      await ffmpeg('-i', vf, '-i', af, '-c:v', 'copy', '-c:a', 'aac', '-y', out);
      fs.unlink(vf, () => {}); fs.unlink(af, () => {});
    } else {
      // Fallback: kombinierter Stream
      const combo = ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
      console.log('[video] kombiniert fallback:', combo.height + 'p');
      await dlStream(combo.url, out);
    }
    return send(res, out, 'video/mp4', 'download.mp4');

  } catch(e) {
    console.error('[error]', e.message);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: e.message });
  }
});

// Cleanup
try { const n=Date.now(); fs.readdirSync(TEMP_DIR).forEach(f=>{const fp=path.join(TEMP_DIR,f);if(n-fs.statSync(fp).mtimeMs>TTL_MS)fs.unlinkSync(fp);}); } catch(e) {}

app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
