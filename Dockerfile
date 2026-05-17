FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    --no-install-recommends && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

# Prüfe ffmpeg
RUN ffmpeg -version | head -1

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# yt-dlp Config
RUN mkdir -p /root/.config/yt-dlp && printf \
    '--js-runtimes node:/usr/local/bin/node\n--extractor-args youtube:player_client=tv_embedded,ios,web\n' \
    > /root/.config/yt-dlp/config

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p temp

EXPOSE 3000
CMD ["node", "server.js"]
