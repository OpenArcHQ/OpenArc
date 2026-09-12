FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/shared packages/shared
COPY packages/config packages/config
COPY packages/db packages/db
RUN pnpm --filter @openarc/db build && pnpm --filter @openarc/shared build && pnpm --filter @openarc/api build
RUN pnpm --filter @openarc/api deploy --prod /prod/api

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

RUN apk add --no-cache \
        libcrypto3=3.5.8-r0 \
        libssl3=3.5.8-r0 \
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
