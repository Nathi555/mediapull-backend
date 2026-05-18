const express   = require('express');
const cors      = require('cors');
const { exec }  = require('child_process');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT     = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const TTL_MS   = 30 * 60 * 1000;
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
  const data = process.env.YOUTUBE_COOKIES.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  fs.writeFileSync(COOKIES_FILE, data, 'utf8');
  console.log('[cookies] geschrieben:', data.split('\n').length, 'Zeilen');
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());
app.get('/health', (_req, res) => {
  exec('yt-dlp --version', (e, v) =>
    res.json({ ok:true, ytdlp: v?.trim(), cookies: fs.existsSync(COOKIES_FILE) })
  );
});

function send(res, file, mime, name) {
  if (!fs.existsSync(file)) return res.status(500).json({ status:'error', message:'Datei fehlt' });
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

app.get('/api/formats', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url fehlt' });
  const cookies = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  exec(`yt-dlp --list-formats --extractor-args "youtube:player_client=mweb,web,tv_embedded" ${cookies} "${url}" 2>&1`, { timeout: 30000 }, (err, out) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(out || err?.message);
  });
});

app.post('/api/download', (req, res) => {
  const { url, downloadMode='auto', videoQuality='max' } = req.body;
  if (!url) return res.status(400).json({ status:'error', message:'Keine URL' });

  const isAudio = downloadMode === 'audio';
  const id      = uuidv4();
  const ext     = isAudio ? 'mp3' : 'mp4';
  const outFile = path.join(TEMP_DIR, `${id}.${ext}`);
  const cookies = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';

  const fmt = isAudio
    ? '-x --audio-format mp3 --audio-quality 0'
    : videoQuality === 'max'
      ? '-f "bestvideo+bestaudio/best" --merge-output-format mp4'
      : "-f best";

  // web client + cookies = PO-Token wird von yt-dlp generiert (via node JS runtime aus config)
  const cmd = `yt-dlp ${fmt} --extractor-args "youtube:player_client=mweb,tv_embedded,ios" ${cookies} --no-playlist --verbose -o "${outFile}" "${url}" 2>&1`;
  console.log('[cmd]', cmd.slice(0, 150));

  exec(cmd, { timeout: 5*60*1000 }, (err, out) => {
    // Verbose output loggen (PO-Token Zeilen)
    console.log('[yt-dlp full]\n' + (out||'').slice(-1500));

    if (err) {
      const detail = (out||'').slice(-500);
      console.error('[err]', detail);
      return res.status(500).json({ status:'error', message: detail.includes('Sign in') ? 'Bot-Block: PO-Token fehlgeschlagen' : 'Download fehlgeschlagen', detail });
    }

    // Datei suchen
    let final = outFile;
    if (!fs.existsSync(final)) {
      const found = fs.readdirSync(TEMP_DIR)
        .map(f => ({ f, fp: path.join(TEMP_DIR,f), mt: fs.statSync(path.join(TEMP_DIR,f)).mtimeMs }))
        .filter(x => x.f.startsWith(id) || Date.now()-x.mt < 90000)
        .sort((a,b) => b.mt-a.mt)[0];
      if (found) final = found.fp;
    }
    send(res, final, isAudio ? 'audio/mpeg' : 'video/mp4', `download.${ext}`);
  });
});

try { const n=Date.now(); fs.readdirSync(TEMP_DIR).forEach(f=>{const fp=path.join(TEMP_DIR,f);if(n-fs.statSync(fp).mtimeMs>TTL_MS)fs.unlinkSync(fp);}); } catch(e) {}
app.listen(PORT, () => console.log(`MediaPull läuft auf Port ${PORT}`));
