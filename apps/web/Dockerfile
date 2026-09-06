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
ARG VITE_API_BOUNDARY_ENABLED=false
ARG VITE_ARC_OBSERVATION_ENABLED=false
ARG VITE_AGENT_REGISTRY_ENABLED=false
ENV VITE_COMMIT_SHA=${COMMIT_SHA}
ENV VITE_ENCRYPTED_WORKSPACE_ENABLED=${VITE_ENCRYPTED_WORKSPACE_ENABLED}
ENV VITE_API_BOUNDARY_ENABLED=${VITE_API_BOUNDARY_ENABLED}
ENV VITE_ARC_OBSERVATION_ENABLED=${VITE_ARC_OBSERVATION_ENABLED}
ENV VITE_AGENT_REGISTRY_ENABLED=${VITE_AGENT_REGISTRY_ENABLED}
ARG VITE_AGENT_JOBS_ENABLED=false
ENV VITE_AGENT_JOBS_ENABLED=${VITE_AGENT_JOBS_ENABLED}
ARG VITE_GATEWAY_EVIDENCE_ENABLED=false
ENV VITE_GATEWAY_EVIDENCE_ENABLED=${VITE_GATEWAY_EVIDENCE_ENABLED}
ARG VITE_GENERIC_AGENT_IMPORT_ENABLED=false
ARG VITE_INVESTIGATIONS_ENABLED=false
ENV VITE_INVESTIGATIONS_ENABLED=${VITE_INVESTIGATIONS_ENABLED}
RUN if [ "${VITE_INVESTIGATIONS_ENABLED}" = "true" ] && [ "${VITE_ENCRYPTED_WORKSPACE_ENABLED}" != "true" ]; then exit 1; fi
ENV VITE_GENERIC_AGENT_IMPORT_ENABLED=${VITE_GENERIC_AGENT_IMPORT_ENABLED}
RUN if [ "${VITE_GENERIC_AGENT_IMPORT_ENABLED}" = "true" ] && [ "${VITE_ENCRYPTED_WORKSPACE_ENABLED}" != "true" ]; then exit 1; fi
RUN if [ "${VITE_GATEWAY_EVIDENCE_ENABLED}" = "true" ] && [ "${VITE_AGENT_JOBS_ENABLED}" != "true" ]; then exit 1; fi
RUN if [ "${VITE_AGENT_JOBS_ENABLED}" = "true" ] && [ "${VITE_AGENT_REGISTRY_ENABLED}" != "true" ]; then exit 1; fi
RUN if [ "${VITE_AGENT_REGISTRY_ENABLED}" = "true" ] && [ "${VITE_ARC_OBSERVATION_ENABLED}" != "true" ]; then exit 1; fi
RUN pnpm --filter @openarc/shared build && pnpm --filter @openarc/web build

FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS runtime

RUN apk add --no-cache \
    c-ares=1.34.8-r0 \
    curl=8.22.0-r0 \
    libcrypto3=3.5.8-r0 \
    libcurl=8.22.0-r0 \
    libexpat=2.8.4-r0 \
    libssl3=3.5.8-r0 \
    libuuid=2.41.6-r1 \
    libxml2=2.13.9-r1 \
    nghttp2-libs=1.69.0-r0

ARG VITE_API_BOUNDARY_ENABLED=false
ARG VITE_ARC_OBSERVATION_ENABLED=false
ARG VITE_AGENT_REGISTRY_ENABLED=false
COPY apps/web/nginx.conf apps/web/nginx-api.conf apps/web/nginx-arc.conf apps/web/proxy_params apps/web/validate-m04-runtime-env.sh /tmp/openarc-nginx/
RUN set -eu; \
    if [ "${VITE_API_BOUNDARY_ENABLED}" = "true" ]; then \
      mkdir -p /etc/nginx/templates; \
      if [ "${VITE_AGENT_REGISTRY_ENABLED}" = "true" ] && [ "${VITE_ARC_OBSERVATION_ENABLED}" != "true" ]; then exit 1; fi; \
      if [ "${VITE_ARC_OBSERVATION_ENABLED}" = "true" ]; then \
        cp /tmp/openarc-nginx/nginx-arc.conf /etc/nginx/templates/default.conf.template; \
        cp /tmp/openarc-nginx/validate-m04-runtime-env.sh /docker-entrypoint.d/05-openarc-m04-env.sh; \
        chmod 755 /docker-entrypoint.d/05-openarc-m04-env.sh; \
      else \
        cp /tmp/openarc-nginx/nginx-api.conf /etc/nginx/templates/default.conf.template; \
      fi; \
      cp /tmp/openarc-nginx/proxy_params /etc/nginx/proxy_params; \
      rm -f /etc/nginx/conf.d/default.conf; \
    else \
      cp /tmp/openarc-nginx/nginx.conf /etc/nginx/conf.d/default.conf; \
    fi; \
    rm -rf /tmp/openarc-nginx
ENV API_TRUST_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    NGINX_ENVSUBST_FILTER=^(API_(UPSTREAM_(HOST|SNI)|TRUST_BUNDLE)|SOURCE_PROXY_SECRET)$
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
