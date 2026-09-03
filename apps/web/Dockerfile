FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared
COPY packages/config packages/config
COPY assets assets

ARG COMMIT_SHA=local
ARG VITE_ENCRYPTED_WORKSPACE_ENABLED=false
ENV VITE_COMMIT_SHA=${COMMIT_SHA}
ENV VITE_ENCRYPTED_WORKSPACE_ENABLED=${VITE_ENCRYPTED_WORKSPACE_ENABLED}
RUN pnpm --filter @openarc/shared build && pnpm --filter @openarc/web build

FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS runtime

RUN apk add --no-cache \
    c-ares=1.34.8-r0 \
    curl=8.20.0-r0 \
    libcrypto3=3.5.8-r0 \
    libcurl=8.20.0-r0 \
    libexpat=2.8.4-r0 \
    libssl3=3.5.8-r0 \
    libxml2=2.13.9-r1 \
    nghttp2-libs=1.69.0-r0

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
