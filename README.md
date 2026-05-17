# MediaPull Backend

Self-hosted Download-Backend mit yt-dlp + ffmpeg. Deploybar auf Railway oder Render.

---

## Railway Deployment (empfohlen, kostenlos)

### 1. Repo vorbereiten
```bash
git init
git add .
git commit -m "init"
```
GitHub-Repo erstellen und pushen:
```bash
git remote add origin https://github.com/DEIN-NAME/mediapull-backend
git push -u origin main
```

### 2. Railway
1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub Repo**
2. Dein Repo auswählen — Railway erkennt das `Dockerfile` automatisch
3. **Variables** Tab → folgende Umgebungsvariablen setzen:

| Variable | Wert |
|---|---|
| `BASE_URL` | `https://DEIN-PROJEKT.up.railway.app` |
| `ALLOWED_ORIGIN` | `https://deine-seite.rf.gd` |

4. Deploy abwarten (~2 Min)
5. Unter **Settings → Domains** die öffentliche URL kopieren

### 3. Frontend anpassen
In `index.html` die Konstante `BACKEND` auf deine Railway-URL setzen:
```js
var BACKEND = 'https://dein-projekt.up.railway.app';
```

---

## Render Deployment (Alternative)

1. [render.com](https://render.com) → **New Web Service**
2. GitHub-Repo verbinden
3. **Environment** → Docker
4. Umgebungsvariablen wie oben setzen
5. Plan: **Free** reicht für den Start

---

## Lokal testen

```bash
npm install
cp .env.example .env   # BASE_URL auf http://localhost:3000 lassen
node server.js
```

Testen:
```bash
curl -X POST http://localhost:3000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtube.com/watch?v=dQw4w9WgXcQ","downloadMode":"audio","audioFormat":"mp3"}'
```

---

## API

### POST `/api/download`
```json
{
  "url": "https://youtube.com/watch?v=...",
  "downloadMode": "auto",
  "videoQuality": "1080",
  "audioFormat": "mp3"
}
```
`downloadMode`: `"auto"` (Video+Audio) oder `"audio"` (nur MP3)

**Response:**
```json
{
  "status": "success",
  "url": "https://dein-projekt.up.railway.app/temp/uuid.mp4",
  "filename": "video.mp4",
  "expiresIn": "30 Minuten"
}
```

### GET `/health`
Gibt `{ "ok": true }` zurück — für Uptime-Monitoring.
