const express  = require('express');
const cors     = require('cors');
const { exec } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── Config ────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const BASE_URL  = process.env.BASE_URL || `http://localhost:${PORT}`;
const TEMP_DIR  = path.join(__dirname, 'temp');
const TTL_MS    = 30 * 60 * 1000; // 30 min

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── App ───────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// Temp-Dateien statisch ausliefern
app.use('/temp', express.static(TEMP_DIR));

// ── Hilfsfunktionen ───────────────────────────────────────
function sanitize(str) {
  return String(str || '').replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 80);
}

function deleteLater(filepath) {
  setTimeout(() => {
    fs.unlink(filepath, () => {});
    console.log(`[cleanup] gelöscht: ${path.basename(filepath)}`);
  }, TTL_MS);
}

function ytDlpPath() {
  // Railway/Render: yt-dlp liegt im PATH
  return process.env.YTDLP_PATH || 'yt-dlp';
}

function ffmpegAvailable() {
  return new Promise(resolve => {
    exec('ffmpeg -version', err => resolve(!err));
  });
}

// ── POST /api/download ────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const {
    url,
    downloadMode = 'auto',
    videoQuality  = '1080',
    audioFormat   = 'mp3',
  } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ status: 'error', message: 'Ungültige URL' });
  }

  const id      = uuidv4();
  const isAudio = downloadMode === 'audio';
  const ext     = isAudio ? audioFormat : 'mp4';
  const outFile = path.join(TEMP_DIR, `${id}.${ext}`);
  const hasFfmpeg = await ffmpegAvailable();

  // yt-dlp Argumente aufbauen
  let args = [];

  if (isAudio) {
    args = [
      '-x',
      hasFfmpeg ? `--audio-format ${audioFormat}` : '',
      '--audio-quality 0',
      `-o "${outFile}"`,
    ];
  } else {
    // Video: beste verfügbare Qualität bis videoQuality
    const fmt = hasFfmpeg
      ? `bestvideo[height<=${videoQuality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${videoQuality}][ext=mp4]/best[height<=${videoQuality}]`
      : `best[height<=${videoQuality}][ext=mp4]/best[height<=${videoQuality}]`;

    args = [
      `-f "${fmt}"`,
      hasFfmpeg ? '--merge-output-format mp4' : '',
      `-o "${outFile}"`,
    ];
  }

  args.push('--no-playlist');
  args.push('--no-warnings');
  args.push(`"${url}"`);

  const cmd = `${ytDlpPath()} ${args.filter(Boolean).join(' ')}`;
  console.log(`[download] ${cmd}`);

  exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[error]', stderr || err.message);
      return res.status(500).json({
        status: 'error',
        message: 'Download fehlgeschlagen',
        detail: stderr ? stderr.slice(-400) : err.message,
      });
    }

    // yt-dlp schreibt manchmal mit anderer Extension
    let finalFile = outFile;
    if (!fs.existsSync(finalFile)) {
      const found = fs.readdirSync(TEMP_DIR)
        .filter(f => f.startsWith(id))
        .map(f => path.join(TEMP_DIR, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (found) finalFile = found;
    }

    if (!finalFile || !fs.existsSync(finalFile)) {
      return res.status(500).json({ status: 'error', message: 'Ausgabedatei nicht gefunden' });
    }

    const filename   = path.basename(finalFile);
    const downloadUrl = `${BASE_URL}/temp/${filename}`;

    deleteLater(finalFile);

    return res.json({
      status:   'success',
      url:      downloadUrl,
      filename: sanitize(filename),
      expiresIn: '30 Minuten',
    });
  });
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, temp: fs.readdirSync(TEMP_DIR).length }));

// ── Cleanup alter Temp-Dateien beim Start ─────────────────
(function cleanupOnStart() {
  const now = Date.now();
  fs.readdirSync(TEMP_DIR).forEach(f => {
    const fp  = path.join(TEMP_DIR, f);
    const age = now - fs.statSync(fp).mtimeMs;
    if (age > TTL_MS) { fs.unlinkSync(fp); console.log(`[startup-cleanup] ${f}`); }
  });
})();

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MediaPull Backend läuft auf Port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
