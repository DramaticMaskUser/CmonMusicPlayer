FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MEDIA_ROOT=/umbrel-home

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /data /umbrel-home && chown node:node /data

USER node
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
