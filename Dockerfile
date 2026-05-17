FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    --no-install-recommends && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# yt-dlp Config: Node.js als JS-Runtime + iOS-Client als Standard
RUN mkdir -p /root/.config/yt-dlp && cat > /root/.config/yt-dlp/config << 'YTCONF'
--js-runtimes nodejs:/usr/local/bin/node
--extractor-args youtube:player_client=ios,web
YTCONF

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p temp

EXPOSE 3000
CMD ["node", "server.js"]
