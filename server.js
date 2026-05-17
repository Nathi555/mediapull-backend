const express  = require('express');
const cors     = require('cors');
const { exec } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT     = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const TTL_MS   = 30 * 60 * 1000;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Cookies aus Env-Variable in Datei schreiben
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
  console.log('[cookies] cookies.txt geschrieben');
}
function cookiesArg() {
  return fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// POST /api/download — lädt herunter und streamt direkt zurück
app.post('/api/download', (req, res) => {
  const { url, downloadMode='auto', videoQuality='1080', audioFormat='mp3' } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ status:'error', message:'Ungültige URL' });
  }

  const id      = uuidv4();
  const isAudio = downloadMode === 'audio';
  const ext     = isAudio ? audioFormat : 'mp4';
  const outFile = path.join(TEMP_DIR, `${id}.${ext}`);

  let fmt, args;
  if (isAudio) {
    args = `-x --audio-format ${audioFormat} --audio-quality 0 --extractor-args "youtube:player_client=ios,web" --js-runtimes nodejs ${cookiesArg()} -o "${outFile}" --no-playlist "${url}"`;
  } else {
    fmt = `bestvideo[height<=${videoQuality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${videoQuality}][ext=mp4]/best[height<=${videoQuality}]`;
    args = `-f "${fmt}" --merge-output-format mp4 --extractor-args "youtube:player_client=ios,web" --js-runtimes nodejs ${cookiesArg()} -o "${outFile}" --no-playlist "${url}"`;
  }

  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  const cmd   = `${ytdlp} ${args}`;
  console.log('[cmd]', cmd);

  exec(cmd, { timeout: 5 * 60 * 1000 }, (err, _stdout, stderr) => {
    if (err) {
      console.error('[err]', stderr || err.message);
      return res.status(500).json({ status:'error', message:'Download fehlgeschlagen', detail: (stderr||'').slice(-300) });
    }

    // Datei finden (yt-dlp ändert manchmal Extension)
    let finalFile = outFile;
    if (!fs.existsSync(finalFile)) {
      const found = fs.readdirSync(TEMP_DIR)
        .filter(f => f.startsWith(id))
        .map(f => path.join(TEMP_DIR, f))
        .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (found) finalFile = found;
    }

    if (!finalFile || !fs.existsSync(finalFile)) {
      return res.status(500).json({ status:'error', message:'Datei nicht gefunden nach Download' });
    }

    const filename = `download.${path.extname(finalFile).slice(1)||ext}`;
    const mime     = isAudio ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', fs.statSync(finalFile).size);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);
    stream.on('end', () => {
      setTimeout(() => fs.unlink(finalFile, ()=>{}), 5000);
    });
    stream.on('error', (e) => {
      console.error('[stream error]', e);
      if (!res.headersSent) res.status(500).json({ status:'error', message:'Stream-Fehler' });
    });
  });
});

// Cleanup beim Start
(function cleanup() {
  const now = Date.now();
  fs.readdirSync(TEMP_DIR).forEach(f => {
    const fp = path.join(TEMP_DIR, f);
    if (Date.now() - fs.statSync(fp).mtimeMs > TTL_MS) fs.unlinkSync(fp);
  });
})();

app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
