FROM node:20-alpine AS build
WORKDIR /app

COPY frontend/package*.json ./

RUN npm install --no-audit --no-fund

COPY frontend/ ./
COPY backend/ /tmp/backend/

ARG VITE_API_BASE=
ARG VITE_ADMIN_PATH_KEY=

RUN set -eux; \
    if [ -z "${VITE_ADMIN_PATH_KEY}" ] && [ -f /tmp/backend/.env ]; then \
      VITE_ADMIN_PATH_KEY="$(grep '^ADMIN_PATH_KEY=' /tmp/backend/.env | head -n1 | cut -d= -f2-)"; \
    fi; \
    export VITE_API_BASE="${VITE_API_BASE}"; \
    export VITE_ADMIN_PATH_KEY="${VITE_ADMIN_PATH_KEY}"; \
    npm run build


FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
