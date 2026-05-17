FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    --no-install-recommends && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Node.js Pfad für yt-dlp als JS-Runtime registrieren
RUN node_path=$(which node) && \
    mkdir -p /root/.config/yt-dlp && \
    echo "--js-runtimes nodejs:${node_path}" > /root/.config/yt-dlp/config

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p temp

EXPOSE 3000
CMD ["node", "server.js"]
