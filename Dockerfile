FROM node:24-alpine AS assets
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app-src ./app-src
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
COPY tools/configure-nas.mjs tools/pair-code.mjs ./tools/
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
