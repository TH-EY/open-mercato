FROM node:24-alpine AS source

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml turbo.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY scripts/ ./scripts/
COPY newrelic.js ./
COPY jest.config.cjs jest.setup.ts jest.dom.setup.ts ./
COPY eslint.config.mjs ./

FROM node:24-alpine AS pruner

WORKDIR /app

RUN apk add --no-cache python3 make g++ ca-certificates openssl \
 && corepack enable \
 && npm install -g turbo@2.7.5

COPY --from=source /app /app

RUN turbo prune @open-mercato/app --docker --out-dir /app/out

FROM node:24-alpine AS installer

ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN apk add --no-cache python3 make g++ ca-certificates openssl
RUN corepack enable

COPY --from=pruner /app/out/json/ ./

RUN yarn install

FROM node:24-alpine AS builder

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN apk add --no-cache python3 make g++ ca-certificates openssl
RUN corepack enable

COPY --from=installer /app/ ./
COPY --from=pruner /app/out/full/ ./
COPY --from=source /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=source /app/tsconfig.json ./tsconfig.json
COPY --from=source /app/scripts ./scripts
COPY --from=source /app/newrelic.js ./newrelic.js
COPY --from=source /app/jest.config.cjs ./jest.config.cjs
COPY --from=source /app/jest.setup.ts ./jest.setup.ts
COPY --from=source /app/jest.dom.setup.ts ./jest.dom.setup.ts
COPY --from=source /app/eslint.config.mjs ./eslint.config.mjs

ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN yarn build

# Dev stage: install + build packages only, no production build; run dev server with watch
FROM node:24-alpine AS dev

ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN apk add --no-cache python3 make g++ ca-certificates openssl
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml turbo.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY scripts/ ./scripts/
RUN yarn install

COPY newrelic.js ./
COPY jest.config.cjs jest.setup.ts jest.dom.setup.ts ./
COPY eslint.config.mjs ./

RUN yarn build:packages

COPY docker/scripts/dev-entrypoint.sh /app/docker/scripts/dev-entrypoint.sh
COPY docker/scripts/init-or-migrate.sh /app/docker/scripts/init-or-migrate.sh
RUN chmod +x /app/docker/scripts/dev-entrypoint.sh
RUN chmod +x /app/docker/scripts/init-or-migrate.sh

EXPOSE 3000
CMD ["/bin/sh", "/app/docker/scripts/dev-entrypoint.sh"]

FROM node:24-alpine AS prod-deps

ARG CONTAINER_PORT=3000

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=${CONTAINER_PORT}

WORKDIR /app

RUN apk add --no-cache ca-certificates openssl
RUN corepack enable

COPY --from=pruner /app/out/json/ ./

RUN yarn workspaces focus @open-mercato/app --production

# Production stage
FROM node:24-alpine AS runner

ARG CONTAINER_PORT=3000

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=${CONTAINER_PORT}

WORKDIR /app

RUN apk add --no-cache ca-certificates openssl sudo
RUN corepack enable

COPY --from=prod-deps /app/ ./

# Copy built workspace files required at runtime
COPY --from=builder /app/packages/ ./packages/

# Copy built Next.js application
COPY --from=builder /app/apps/mercato/.mercato/next ./apps/mercato/.mercato/next
COPY --from=builder /app/apps/mercato/public ./apps/mercato/public
COPY --from=builder /app/apps/mercato/next.config.ts ./apps/mercato/
COPY --from=builder /app/apps/mercato/components.json ./apps/mercato/
COPY --from=builder /app/apps/mercato/tsconfig.json ./apps/mercato/
COPY --from=builder /app/apps/mercato/postcss.config.mjs ./apps/mercato/

# Copy generated files and other runtime necessities
COPY --from=builder /app/apps/mercato/.mercato ./apps/mercato/.mercato
COPY --from=builder /app/apps/mercato/src ./apps/mercato/src
COPY --from=builder /app/apps/mercato/types ./apps/mercato/types

# Copy runtime configuration files
COPY --from=builder /app/newrelic.js ./

# Copy Railway entrypoint script
COPY docker/scripts/railway-entrypoint.sh /app/docker/scripts/railway-entrypoint.sh
COPY docker/scripts/init-or-migrate.sh /app/docker/scripts/init-or-migrate.sh
RUN chmod +x /app/docker/scripts/railway-entrypoint.sh
RUN chmod +x /app/docker/scripts/init-or-migrate.sh

# Prepare storage directory for Railway volume mount
RUN mkdir -p /app/apps/mercato/storage

# Create non-root user and grant passwordless sudo for chown only
RUN adduser -D -u 1001 omuser \
 && chown -R omuser:omuser /app \
 && echo "omuser ALL=(root) NOPASSWD: /bin/chown" > /etc/sudoers.d/omuser \
 && chmod 0440 /etc/sudoers.d/omuser

USER omuser

EXPOSE ${CONTAINER_PORT}

WORKDIR /app/apps/mercato
CMD ["yarn", "start"]
