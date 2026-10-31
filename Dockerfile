FROM node:24-alpine AS assets
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app-src ./app-src
COPY lib/playback-tracks.mjs ./lib/playback-tracks.mjs
COPY third-party ./third-party
COPY tools/build-assets.mjs ./tools/build-assets.mjs
RUN node tools/build-assets.mjs

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs ./
COPY lib ./lib
COPY app ./app
COPY --from=assets /build/app/qr.js ./app/qr.js
COPY --from=assets /build/app/playback.js ./app/playback.js
COPY --from=assets /build/app/heif-assets.js ./app/heif-assets.js
COPY --from=assets /build/app/licenses ./app/licenses
COPY tools/configure-nas.mjs tools/pair-code.mjs ./tools/
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
