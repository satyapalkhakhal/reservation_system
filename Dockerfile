# syntax=docker/dockerfile:1

# ---- base: Node LTS + pnpm (via corepack, version pinned by package.json) ----
FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- build: full deps + TypeScript compile ----
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: runtime dependencies only ----
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json docker-entrypoint.sh ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
