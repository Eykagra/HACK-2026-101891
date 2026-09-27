# ---------------------------------------------------------------------------
# Single-stage build.
#
# There is no bundler, no transpile step and no runtime dependency to install,
# so the usual builder/runtime split would add a layer and save nothing. Node
# 24 strips the TypeScript types at load time.
#
# `npm ci --omit=dev` exists only to produce an empty node_modules
# deterministically; the app imports nothing outside the standard library.
# ---------------------------------------------------------------------------
FROM node:24-alpine

# tini reaps zombies and forwards SIGTERM, which is what makes the graceful
# shutdown in src/main.ts actually run and checkpoint the WAL.
RUN apk add --no-cache tini

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

COPY src ./src
COPY web ./web
COPY scripts ./scripts

# The database lives on a volume, not in the image.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME /app/data

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/taskflow.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.ts"]
