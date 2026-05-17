FROM node:20-slim

# ffmpeg + python (für yt-dlp) installieren
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# yt-dlp installieren
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p temp

EXPOSE 3000
CMD ["node", "server.js"]
