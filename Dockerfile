# ---------- build: brickyard app (vite), builder server (tsc), scanner frontend (vite)
FROM node:22-alpine AS build
WORKDIR /repo/builder
COPY builder/package.json package.json
COPY builder/app/package.json app/package.json
COPY builder/server/package.json server/package.json
RUN npm install --no-audit --no-fund
COPY builder/app ./app
COPY builder/server ./server
RUN mkdir -p server/cache && echo '[]' > server/cache/colors.json
RUN npm run build
WORKDIR /repo/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- runtime: python (fastapi, front door :8000) + node 22 (brickyard :8787)
FROM node:22-bookworm-slim AS nodert
FROM python:3.12-slim
# node:sqlite needs Node >= 22.13; Debian's nodejs is too old -> copy the official binary
COPY --from=nodert /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATA_DIR=/data STATIC_DIR=/app/static BUILDER_DIST=/app/builder BUILDER_URL=http://127.0.0.1:8787 \
    LDRAW_DIR=/app/brickyard-server/ldraw/ldraw PORT=8787
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=build /repo/frontend/dist ./static
COPY --from=build /repo/builder/app/dist ./builder
COPY --from=build /repo/builder/server/dist ./brickyard-server/dist
COPY --from=build /repo/builder/node_modules ./brickyard-server/node_modules
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
VOLUME ["/data", "/app/brickyard-server/ldraw", "/app/brickyard-server/cache"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=10 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1
CMD ["/docker-entrypoint.sh"]
