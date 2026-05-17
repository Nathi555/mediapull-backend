const express   = require('express');
const cors      = require('cors');
const { exec }  = require('child_process');
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

app.get('/health', (_req, res) => res.json({ ok: true, method: 'piped+ytdlp' }));

// ── Piped API Instanzen ───────────────────────────────────
const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://piped-api.privacy.com.de',
  'https://api.piped.projectsegfau.lt',
];

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getPipedStreams(videoId, quality, isAudio) {
  for (const base of PIPED) {
    try {
      console.log('[piped] versuche', base);
      const data = await get(`${base}/streams/${videoId}`);
      if (!data || !data.videoStreams) continue;

      // Audio: besten Stream wählen
      const audioStream = (data.audioStreams || [])
        .filter(s => s.mimeType && s.mimeType.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (isAudio) {
        if (audioStream) return { audio: audioStream.url, title: data.title };
        continue;
      }

      // Video: passende Qualität wählen
      const maxHeight = quality === 'max' ? 9999 : parseInt(quality);
      const videoStream = (data.videoStreams || [])
        .filter(s => s.videoOnly && s.quality && parseInt(s.quality) <= maxHeight)
        .sort((a, b) => parseInt(b.quality) - parseInt(a.quality))[0]
        || (data.videoStreams || [])
        .filter(s => !s.videoOnly)
        .sort((a, b) => parseInt(b.quality) - parseInt(a.quality))[0];

      if (videoStream && audioStream) {
        console.log(`[piped] Video: ${videoStream.quality}, Audio: ${audioStream.bitrate}bps`);
        return { video: videoStream.url, audio: audioStream.url, title: data.title, quality: videoStream.quality };
      }
    } catch(e) {
      console.log('[piped]', base, 'fehler:', e.message);
    }
  }
  return null;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

function mergeWithFfmpeg(videoFile, audioFile, outFile) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoFile,
      '-i', audioFile,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-strict', 'experimental',
      '-y', outFile
    ];
    console.log('[ffmpeg] merge startet');
    const ff = spawn('ffmpeg', args);
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
    ff.on('error', reject);
  });
}

function convertToMp3(inputFile, outFile) {
  return new Promise((resolve, reject) => {
    const args = ['-i', inputFile, '-vn', '-ab', '192k', '-ar', '44100', '-y', outFile];
    const ff = spawn('ffmpeg', args);
    ff.on('close', code => { if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}`)); });
    ff.on('error', reject);
  });
}

// ── POST /api/download ────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { url, downloadMode = 'auto', videoQuality = 'max', audioFormat = 'mp3' } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ status: 'error', message: 'Ungültige URL' });
  }

  const isAudio  = downloadMode === 'audio';
  const id       = uuidv4();
  const videoId  = extractVideoId(url);

  if (!videoId) {
    return res.status(400).json({ status: 'error', message: 'Keine gültige YouTube-URL' });
  }

  console.log(`[request] videoId=${videoId} mode=${downloadMode} quality=${videoQuality}`);

  try {
    const streams = await getPipedStreams(videoId, videoQuality, isAudio);

    if (!streams) {
      return res.status(500).json({ status: 'error', message: 'Kein Stream gefunden. Bitte später erneut versuchen.' });
    }

    if (isAudio) {
      // Audio direkt herunterladen + zu MP3 konvertieren
      const rawAudio = path.join(TEMP_DIR, `${id}_audio_raw`);
      const mp3File  = path.join(TEMP_DIR, `${id}.mp3`);
      console.log('[audio] lade herunter...');
      await downloadFile(streams.audio, rawAudio);
      console.log('[audio] konvertiere zu MP3...');
      await convertToMp3(rawAudio, mp3File);
      fs.unlink(rawAudio, () => {});
      streamToClient(res, mp3File, 'audio/mpeg', 'download.mp3');
    } else {
      // Video + Audio herunterladen und mergen
      const videoFile = path.join(TEMP_DIR, `${id}_video`);
      const audioFile = path.join(TEMP_DIR, `${id}_audio`);
      const outFile   = path.join(TEMP_DIR, `${id}.mp4`);
      console.log(`[video] lade Video (${streams.quality}) und Audio herunter...`);
      await Promise.all([
        downloadFile(streams.video, videoFile),
        downloadFile(streams.audio, audioFile),
      ]);
      console.log('[video] merge mit ffmpeg...');
      await mergeWithFfmpeg(videoFile, audioFile, outFile);
      fs.unlink(videoFile, () => {});
      fs.unlink(audioFile, () => {});
      streamToClient(res, outFile, 'video/mp4', 'download.mp4');
    }
  } catch(e) {
    console.error('[error]', e.message);
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: 'Fehler: ' + e.message });
    }
  }
});

function streamToClient(res, filePath, mime, filename) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ status: 'error', message: 'Datei nicht gefunden nach Download' });
  }
  console.log('[stream]', filename, fs.statSync(filePath).size, 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', fs.statSync(filePath).size);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => setTimeout(() => fs.unlink(filePath, () => {}), 5000));
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
}

// Cleanup
try {
  const n = Date.now();
  fs.readdirSync(TEMP_DIR).forEach(f => {
    const fp = path.join(TEMP_DIR, f);
    if (n - fs.statSync(fp).mtimeMs > TTL_MS) fs.unlinkSync(fp);
  });
} catch(e) {}

app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
