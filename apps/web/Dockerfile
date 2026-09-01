FROM node:22-alpine AS build

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
ENV VITE_COMMIT_SHA=${COMMIT_SHA}
RUN pnpm --filter @openarc/shared build && pnpm --filter @openarc/web build

FROM nginx:1.29-alpine AS runtime

RUN apk upgrade --no-cache
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
