FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN npm config set registry ${NPM_REGISTRY} \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm install --no-audit --no-fund

COPY . .

ARG VITE_API_BASE=
ARG VITE_ADMIN_PATH_KEY=

ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_ADMIN_PATH_KEY=${VITE_ADMIN_PATH_KEY}

RUN npm run build


FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
