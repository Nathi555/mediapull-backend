const express  = require('express');
const cors     = require('cors');
const { exec } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT     = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const TTL_MS   = 30 * 60 * 1000;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
  // \r\n -> \n normalisieren (Railway kodiert manchmal anders)
  const cookieData = process.env.YOUTUBE_COOKIES.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  fs.writeFileSync(COOKIES_FILE, cookieData, 'utf8');
  console.log('[cookies] geladen (' + cookieData.length + ' Zeichen, ' + cookieData.split('\n').length + ' Zeilen)');
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({
  ok: true,
  cookies: fs.existsSync(COOKIES_FILE) ? 'geladen' : 'fehlen',
  ytdlp: require('child_process').execSync('yt-dlp --version').toString().trim()
}));

// ── Invidious: direkter Stream ────────────────────────────
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.io',
  'https://iv.ggtyler.dev',
];

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers:{'User-Agent':'mediapull/1.0'}, timeout:8000 }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function invidiousStream(videoId, isAudio, res) {
  for (const base of INVIDIOUS) {
    try {
      console.log('[invidious] versuche', base);
      const data = await fetchJson(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams,title`);
      if (!data) continue;

      let streamUrl = null;
      let mime = 'video/mp4';

      if (isAudio) {
        const audio = (data.adaptiveFormats || [])
          .filter(f => f.type && f.type.includes('audio'))
          .sort((a,b) => (b.bitrate||0) - (a.bitrate||0))[0];
        if (audio?.url) { streamUrl = audio.url; mime = 'audio/webm'; }
      } else {
        const video = (data.formatStreams || [])
          .sort((a,b) => (parseInt(b.resolution)||0) - (parseInt(a.resolution)||0))[0];
        if (video?.url) { streamUrl = video.url; mime = 'video/mp4'; }
      }

      if (!streamUrl) continue;

      console.log('[invidious] stream URL gefunden, pipe startet...');
      const client2 = streamUrl.startsWith('https') ? https : http;
      const ext     = isAudio ? 'webm' : 'mp4';
      const fname   = `download.${ext}`;

      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

      client2.get(streamUrl, { headers:{'User-Agent':'mediapull/1.0'} }, stream => {
        if (stream.headers['content-length']) {
          res.setHeader('Content-Length', stream.headers['content-length']);
        }
        stream.pipe(res);
        stream.on('error', e => {
          console.error('[stream pipe]', e);
          if (!res.headersSent) res.status(500).json({status:'error',message:'Stream-Fehler'});
        });
      }).on('error', e => {
        console.error('[invidious pipe]', e);
        if (!res.headersSent) res.status(500).json({status:'error',message:'Stream-Verbindungsfehler'});
      });
      return true;
    } catch(e) {
      console.log('[invidious] ' + base + ' fehlgeschlagen:', e.message);
    }
  }
  return false;
}

// ── POST /api/download ────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { url, downloadMode='auto', videoQuality='1080', audioFormat='mp3' } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ status:'error', message:'Ungültige URL' });
  }

  const isAudio = downloadMode === 'audio';
  const ext     = isAudio ? audioFormat : 'mp4';
  const id      = uuidv4();
  const outFile = path.join(TEMP_DIR, `${id}.${ext}`);
  const cookies = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  const ytdlp   = process.env.YTDLP_PATH || 'yt-dlp';

  let args;
  if (isAudio) {
    args = `-x --audio-format ${audioFormat} --audio-quality 0 --extractor-args "youtube:player_client=android,web,tv_embedded" --js-runtimes node ${cookies} -o "${outFile}" --no-playlist "${url}"`;
  } else {
    const fmt = videoQuality === 'max'
      ? 'bestvideo*+bestaudio/b'
      : `bestvideo*[height<=${videoQuality}]+bestaudio/bestvideo[height<=${videoQuality}]+bestaudio/b[height<=${videoQuality}]`;
    args = `-f "${fmt}" --merge-output-format mp4 --extractor-args "youtube:player_client=android,web,tv_embedded" --js-runtimes node ${cookies} -o "${outFile}" --no-playlist "${url}"`;
  }

  console.log('[cmd] yt-dlp', args.slice(0, 120));

  exec(`${ytdlp} ${args}`, { timeout: 5 * 60 * 1000 }, async (err, _stdout, stderr) => {
    const blocked = err && stderr && (
      stderr.includes('Sign in to confirm') ||
      stderr.includes('cookies are no longer valid')
    );

    if (blocked) {
      console.log('[blocked] YouTube blockt — Cookies abgelaufen oder ungültig');
      // Invidious nur für Audio-Fallback, nicht für Video (zu schlechte Qualität)
      if (isAudio) {
        const videoId = extractVideoId(url);
        if (videoId) {
          const ok = await invidiousStream(videoId, true, res);
          if (ok) return;
        }
      }
      return res.status(500).json({ status:'error', message:'YouTube blockt den Server. Bitte Cookies in Railway neu exportieren.' });
    }

    if (err) {
      console.error('[err]', (stderr||'').slice(-300));
      return res.status(500).json({ status:'error', message:'Download fehlgeschlagen', detail:(stderr||'').slice(-300) });
    }

    // Datei finden — nach ID-Prefix oder neuester Datei (letzte 90s)
    let finalFile = outFile;
    if (!fs.existsSync(finalFile)) {
      const now = Date.now();
      const found = fs.readdirSync(TEMP_DIR)
        .map(f => ({ f, fp: path.join(TEMP_DIR, f), st: fs.statSync(path.join(TEMP_DIR, f)) }))
        .filter(x => x.st.isFile() && (x.f.startsWith(id) || (now - x.st.mtimeMs) < 90000))
        .sort((a,b) => b.st.mtimeMs - a.st.mtimeMs)[0];
      if (found) finalFile = found.fp;
    }
    console.log('[file]', finalFile, fs.existsSync(finalFile) ? 'gefunden' : 'FEHLT');
    if (!finalFile || !fs.existsSync(finalFile)) {
      return res.status(500).json({ status:'error', message:'Datei nicht gefunden nach Download' });
    }

    const realExt = path.extname(finalFile).slice(1) || ext;
    const mime    = isAudio ? 'audio/mpeg' : 'video/mp4';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="download.${realExt}"`);
    res.setHeader('Content-Length', fs.statSync(finalFile).size);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);
    stream.on('end', () => setTimeout(() => fs.unlink(finalFile, ()=>{}), 5000));
    stream.on('error', e => { if (!res.headersSent) res.status(500).json({status:'error',message:'Stream-Fehler'}); });
  });
});

// Cleanup
try { const n=Date.now(); fs.readdirSync(TEMP_DIR).forEach(f=>{const fp=path.join(TEMP_DIR,f);if(n-fs.statSync(fp).mtimeMs>TTL_MS)fs.unlinkSync(fp);}); } catch(e){}

app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
