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

// Cookies aus Env in Datei schreiben
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
  console.log('[cookies] cookies.txt geschrieben (' + process.env.YOUTUBE_COOKIES.length + ' Zeichen)');
} else {
  console.log('[cookies] keine YOUTUBE_COOKIES Variable gefunden');
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

// Health
app.get('/health', (_req, res) => res.json({
  ok: true,
  cookies: fs.existsSync(COOKIES_FILE) ? 'geladen' : 'fehlen',
  ytdlp: require('child_process').execSync('yt-dlp --version').toString().trim()
}));

// Invidious-Instanzen als Fallback
const INVIDIOUS = [
  'https://invidious.io',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
];

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'mediapull/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function getInvidiousUrl(videoId, isAudio) {
  for (const base of INVIDIOUS) {
    try {
      const data = await fetchJson(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`);
      if (!data || (!data.adaptiveFormats && !data.formatStreams)) continue;

      if (isAudio) {
        const audio = (data.adaptiveFormats || [])
          .filter(f => f.type && f.type.startsWith('audio/'))
          .sort((a,b) => (b.bitrate||0) - (a.bitrate||0))[0];
        if (audio?.url) return audio.url;
      } else {
        // Video mit Audio bevorzugen
        const video = (data.formatStreams || [])
          .sort((a,b) => (parseInt(b.resolution)||0) - (parseInt(a.resolution)||0))[0];
        if (video?.url) return video.url;
      }
    } catch(e) {
      console.log('[invidious] ' + base + ' fehlgeschlagen:', e.message);
    }
  }
  return null;
}

// POST /api/download
app.post('/api/download', async (req, res) => {
  const { url, downloadMode='auto', videoQuality='1080', audioFormat='mp3' } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ status:'error', message:'Ungültige URL' });
  }

  const id      = uuidv4();
  const isAudio = downloadMode === 'audio';
  const ext     = isAudio ? audioFormat : 'mp4';
  const outFile = path.join(TEMP_DIR, `${id}.${ext}`);
  const cookies = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  const ytdlp   = process.env.YTDLP_PATH || 'yt-dlp';

  // yt-dlp Kommando
  let args;
  if (isAudio) {
    args = `-x --audio-format ${audioFormat} --audio-quality 0 --extractor-args "youtube:player_client=ios,web" --js-runtimes nodejs ${cookies} -o "${outFile}" --no-playlist "${url}"`;
  } else {
    const fmt = `bestvideo[height<=${videoQuality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${videoQuality}][ext=mp4]/best[height<=${videoQuality}]`;
    args = `-f "${fmt}" --merge-output-format mp4 --extractor-args "youtube:player_client=ios,web" --js-runtimes nodejs ${cookies} -o "${outFile}" --no-playlist "${url}"`;
  }

  const cmd = `${ytdlp} ${args}`;
  console.log('[cmd]', cmd);

  exec(cmd, { timeout: 5 * 60 * 1000 }, async (err, _stdout, stderr) => {
    const botBlocked = stderr && stderr.includes('Sign in to confirm');

    if (err && botBlocked) {
      // Fallback: Invidious
      console.log('[fallback] yt-dlp geblockt, versuche Invidious...');
      const videoId = extractVideoId(url);
      if (videoId) {
        try {
          const streamUrl = await getInvidiousUrl(videoId, isAudio);
          if (streamUrl) {
            console.log('[invidious] Stream-URL gefunden, leite weiter...');
            // Mit yt-dlp direkt von Invidious-URL laden
            const fallbackCmd = `${ytdlp} ${isAudio ? `-x --audio-format ${audioFormat}` : `-f best`} -o "${outFile}" --no-playlist "${streamUrl}"`;
            console.log('[fallback cmd]', fallbackCmd);
            exec(fallbackCmd, { timeout: 5 * 60 * 1000 }, (err2, _s2, stderr2) => {
              if (err2) {
                console.error('[fallback err]', stderr2);
                return res.status(500).json({ status:'error', message:'Download fehlgeschlagen (auch Fallback)', detail:(stderr2||'').slice(-300) });
              }
              streamFile(res, outFile, ext, isAudio, audioFormat);
            });
            return;
          }
        } catch(fe) {
          console.error('[invidious error]', fe.message);
        }
      }
    }

    if (err) {
      console.error('[err]', stderr || err.message);
      return res.status(500).json({ status:'error', message:'Download fehlgeschlagen', detail:(stderr||'').slice(-400) });
    }

    streamFile(res, outFile, ext, isAudio, audioFormat);
  });
});

function streamFile(res, outFile, ext, isAudio, audioFormat) {
  let finalFile = outFile;
  if (!fs.existsSync(finalFile)) {
    const dir = path.dirname(outFile);
    const id  = path.basename(outFile, '.' + ext);
    const found = fs.readdirSync(dir)
      .filter(f => f.startsWith(id))
      .map(f => path.join(dir, f))
      .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (found) finalFile = found;
  }

  if (!finalFile || !fs.existsSync(finalFile)) {
    return res.status(500).json({ status:'error', message:'Datei nicht gefunden nach Download' });
  }

  const realExt = path.extname(finalFile).slice(1) || ext;
  const mime    = isAudio ? 'audio/mpeg' : 'video/mp4';
  const fname   = `download.${realExt}`;

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Length', fs.statSync(finalFile).size);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  const stream = fs.createReadStream(finalFile);
  stream.pipe(res);
  stream.on('end', () => setTimeout(() => fs.unlink(finalFile, ()=>{}), 5000));
  stream.on('error', e => {
    console.error('[stream]', e);
    if (!res.headersSent) res.status(500).json({ status:'error', message:'Stream-Fehler' });
  });
}

// Cleanup
(function() {
  const now = Date.now();
  try {
    fs.readdirSync(TEMP_DIR).forEach(f => {
      const fp = path.join(TEMP_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > TTL_MS) fs.unlinkSync(fp);
    });
  } catch(e) {}
})();

app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
