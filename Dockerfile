FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs ./
COPY lib ./lib
COPY app ./app
COPY tools/configure-nas.mjs tools/pair-code.mjs ./tools/
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
