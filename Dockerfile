FROM node:20-bullseye

WORKDIR /usr/src/app

# Install ffmpeg (required for subtitle format conversion) and fetch the latest
# yt-dlp standalone binary directly from GitHub releases so the image always
# ships with the most current YouTube-compatible version.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
CMD ["npm", "start"]
