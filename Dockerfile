FROM node:20-bookworm

WORKDIR /usr/src/app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp==2026.3.17 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid 1001 --no-create-home appuser \
    && chown -R appuser:appuser /usr/src/app

USER appuser

CMD ["npm", "start"]
