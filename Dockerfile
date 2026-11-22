
# ---------- build stage ----------
# Compiles the TypeScript runtime and the native poke-whitelist addon.
FROM node:24-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---------- runtime stage ----------
# Ships the built runtime only. The QQNT installation itself is NOT included
# (Tencent binaries are not redistributable): mount an extracted AppImage at
# /qq and a data volume at /data (see README "Docker").
FROM node:24-bookworm-slim

# Shared libraries required by QQ's bundled Electron/Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates fonts-noto-cjk xvfb xauth \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-6 libxcb1 \
        libxext6 libxrender1 libxi6 libxtst6 libglib2.0-0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/dist /opt/katheryne
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# HOME=/data keeps QQ's account/login records on the mounted volume.
ENV HOME=/data \
    KATHERYNE_QQ_ROOT=/qq \
    KATHERYNE_CONFIG=/data/config.json

VOLUME ["/data"]
EXPOSE 5700 6700 6099
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
