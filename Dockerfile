# AI Video Editor — Cloud Run image
FROM node:22-slim

# FFmpeg for video processing (found first by services/ffmpeg.js PATH resolver).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps with a cached layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY server ./server
COPY public ./public
COPY assets ./assets

ENV NODE_ENV=production
# Cloud Run sets PORT (8080); config.js reads it. JOBS_DIR defaults to /tmp.
EXPOSE 8080
CMD ["node", "server/index.js"]
