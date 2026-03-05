FROM node:20-alpine
WORKDIR /app

COPY package.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY} \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY nodes.json ./

EXPOSE 38081
CMD ["node", "server.js"]
