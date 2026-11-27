# syntax=docker/dockerfile:1.7
# Build from the repository root (the UI imports the TypeScript SDK's sources):
#   docker build -f server/api/Dockerfile -t grad-server .
# Dockerfile.dockerignore next to this file keeps the context to what it copies.

FROM node:22-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS ui
WORKDIR /src/server/ui
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

COPY server/ui/package.json server/ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY sdks/typescript/src /src/sdks/typescript/src
COPY server/ui/index.html server/ui/vite.config.ts server/ui/tsconfig.json ./
COPY server/ui/public ./public
COPY server/ui/src ./src
RUN pnpm exec vite build

FROM node:22-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

COPY server/api/package.json server/api/pnpm-lock.yaml server/api/tsconfig.json server/api/tsconfig.build.json ./
RUN pnpm install --frozen-lockfile

COPY server/api/src ./src
COPY server/api/migrations ./migrations
RUN pnpm build && pnpm prune --prod

FROM node:22-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/migrations ./migrations
# The web UI, served at / (UI_ENABLED=false turns it off).
COPY --from=ui --chown=node:node /src/server/ui/dist ./ui

RUN mkdir -p /var/lib/grad && chown node:node /var/lib/grad
USER node
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
