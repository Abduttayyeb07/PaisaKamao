# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 - build
# Compiles both TypeScript projects:
#   build:server   -> dist/
#   build:frontend -> public/app.js
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install every dependency, devDependencies included, so tsc is available.
COPY package.json package-lock.json ./
RUN npm ci

# Sources consumed by the two tsc projects.
COPY tsconfig.json ./
COPY frontend/ ./frontend/
COPY src/ ./src/
COPY public/ ./public/

RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server plus the dashboard assets it serves from ./public.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# The dashboard defaults to 127.0.0.1, which is unreachable from outside the
# container. Bind it to all interfaces instead.
ENV DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_PORT=3030

# The bot resolves these paths against the working directory. Point them at a
# mountable directory so trade history and zone state survive a container swap.
ENV TRADE_LOG_FILE=data/trade-history.log \
    TRADE_CSV_FILE=data/trade-actions.csv \
    ZONE_STATE_FILE=data/zone-state.json \
    SUBSCRIBERS_FILE=data/subscribers.csv

RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node

EXPOSE 3030

# Node 22 ships a global fetch, so no extra tooling is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DASHBOARD_PORT||3030)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/ws-ratio.js"]
