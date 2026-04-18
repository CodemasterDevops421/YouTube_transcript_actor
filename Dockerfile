FROM node:20-bullseye

WORKDIR /usr/src/app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --upgrade yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
CMD ["npm", "start"]
