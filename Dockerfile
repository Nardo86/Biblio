# syntax=docker/dockerfile:1

# ---- dependencies ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Unprivileged user: the app never needs root, libraries are mounted read-only.
RUN groupadd --gid 10001 biblioteca \
 && useradd --uid 10001 --gid biblioteca --no-create-home --shell /usr/sbin/nologin biblioteca

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY tools ./tools
COPY public ./public
COPY sample-library ./sample-library

# pdf.js is served from the app itself (no CDN at runtime).
RUN node tools/vendor.mjs

RUN mkdir -p /data && chown -R biblioteca:biblioteca /data /app
USER biblioteca

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
