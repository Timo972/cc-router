# ── Build stage ───────────────────────────────────────────────────────────────
# Pinned by digest (immutable) — a moving tag could ship unexpected/compromised
# content. Update deliberately: `crane digest node:22-alpine`.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Port defaults — overridden by docker-compose environment section
ENV PORT=3456
ENV ACCOUNTS_PATH=/app/accounts.json

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Drop root: the node:alpine base already ships an unprivileged `node` user (uid
# 1000). Any RCE in the process is then non-root with no write access outside
# the app dir. NOTE (Linux hosts): the mounted accounts.json must be
# readable/writable by uid 1000, or set `user:` in docker-compose to match the
# host owner — otherwise token-refresh writes will fail.
RUN chown -R node:node /app
USER node

EXPOSE 3456

# accounts.json is expected to be mounted at runtime via docker-compose volume
# The container will exit with a clear error if it's not present
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]
