# Build from repo root: docker build -t homerail-worker:latest -f homerail_worker/Dockerfile .
FROM node:22-slim AS secret-guard-build

# Optional public Debian mirror overrides for Worker image builds. Unset
# values keep the base image defaults; the helper rewrites the deb822
# sources stanza by stanza before the first apt-get update.
ARG HOMERAIL_WORKER_BUILD_APT_MIRROR
ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR
COPY homerail_worker/scripts/configure-apt-sources.mjs /opt/homerail/scripts/configure-apt-sources.mjs
RUN node /opt/homerail/scripts/configure-apt-sources.mjs

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY homerail_worker/native/codex-secret-guard.c /tmp/codex-secret-guard.c
RUN gcc -O2 -Wall -Wextra -Werror -fPIC -shared \
  -o /homerail-codex-secret-guard.so /tmp/codex-secret-guard.c

FROM node:22-slim

# Optional public Debian mirror overrides for Worker image builds. ARG
# declarations are stage-scoped, so they are repeated in this stage.
ARG HOMERAIL_WORKER_BUILD_APT_MIRROR
ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR
# Optional public npm registry override. Build-only: Docker exposes the ARG
# to every RUN npm operation in this stage without persisting a runtime ENV.
ARG NPM_CONFIG_REGISTRY

COPY homerail_worker/scripts/configure-apt-sources.mjs /opt/homerail/scripts/configure-apt-sources.mjs
RUN node /opt/homerail/scripts/configure-apt-sources.mjs

WORKDIR /app
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV HOMERAIL_CODEX_PROC_GUARD="/usr/local/lib/homerail-codex-secret-guard.so"
ARG HOMERAIL_WORKER_VERSION
ARG HOMERAIL_WORKER_PROTOCOL_VERSION
ARG HOMERAIL_WORKER_SOURCE_FINGERPRINT=unknown
ARG HOMERAIL_WORKER_IMAGE_REVISION=unknown
ENV HOMERAIL_WORKER_VERSION="${HOMERAIL_WORKER_VERSION}" \
    HOMERAIL_WORKER_PROTOCOL_VERSION="${HOMERAIL_WORKER_PROTOCOL_VERSION}" \
    HOMERAIL_WORKER_SOURCE_FINGERPRINT="${HOMERAIL_WORKER_SOURCE_FINGERPRINT}" \
    HOMERAIL_WORKER_IMAGE_REVISION="${HOMERAIL_WORKER_IMAGE_REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11.6.2
COPY --from=secret-guard-build /homerail-codex-secret-guard.so /usr/local/lib/homerail-codex-secret-guard.so

# Copy homerail_protocol to /homerail_protocol (parallel to /app) so that
# file:../homerail_protocol in homerail_worker/package.json resolves correctly.
COPY homerail_protocol/package.json homerail_protocol/package-lock.json* /homerail_protocol/
COPY homerail_protocol/src /homerail_protocol/src
COPY homerail_protocol/tsconfig.json /homerail_protocol/
RUN cd /homerail_protocol && npm ci
RUN cd /homerail_protocol && npm run build

# Copy homerail_worker
COPY homerail_worker/package.json homerail_worker/package-lock.json* ./
# --ignore-scripts skips postinstall since homerail_protocol is already built above
RUN npm ci --ignore-scripts
RUN command -v kimi
RUN command -v codex && codex --version

# Auto Fix coding Workers run without network access. Keep a trusted dependency
# cache in the image for the HomeRail packages exercised by implementation and
# validation. Worker projects it only when the dependency-relevant normalized
# package.json + package-lock.json metadata matches these image-owned copies.
RUN mkdir -p /opt/homerail-dependency-cache \
  && ln -s /homerail_protocol /opt/homerail-dependency-cache/homerail_protocol \
  && ln -s /app /opt/homerail-dependency-cache/homerail_worker
COPY homerail_plugin_sdk/package.json homerail_plugin_sdk/package-lock.json* /opt/homerail-dependency-cache/homerail_plugin_sdk/
RUN cd /opt/homerail-dependency-cache/homerail_plugin_sdk && npm ci
COPY homerail_manager/package.json homerail_manager/package-lock.json* /opt/homerail-dependency-cache/homerail_manager/
RUN cd /opt/homerail-dependency-cache/homerail_manager && npm ci
COPY homerail_node/package.json homerail_node/package-lock.json* /opt/homerail-dependency-cache/homerail_node/
RUN cd /opt/homerail-dependency-cache/homerail_node && npm ci
COPY homerail_cli/package.json homerail_cli/package-lock.json* /opt/homerail-dependency-cache/homerail_cli/
RUN cd /opt/homerail-dependency-cache/homerail_cli && npm ci
COPY agent-ui/package.json agent-ui/package-lock.json* /opt/homerail-dependency-cache/agent-ui/
RUN cd /opt/homerail-dependency-cache/agent-ui && npm ci --ignore-scripts

COPY homerail_worker/tsconfig.json ./
COPY homerail_worker/src ./src
RUN npm run build

RUN mkdir -p /workspace && chown -R node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["env", "LD_PRELOAD=/usr/local/lib/homerail-codex-secret-guard.so", "node", "/app/dist/index.js"]
