FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/shared packages/shared
COPY packages/config packages/config
RUN pnpm --filter @openarc/shared build && pnpm --filter @openarc/api build
RUN pnpm --filter @openarc/api deploy --prod /prod/api

FROM node:22-alpine AS runtime

RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && addgroup -S openarc \
    && adduser -S -G openarc openarc
WORKDIR /app

ARG COMMIT_SHA=local
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    COMMIT_SHA=${COMMIT_SHA}

COPY --from=build --chown=openarc:openarc /prod/api ./

USER openarc
EXPOSE 3000
CMD ["node", "dist/server.js"]
