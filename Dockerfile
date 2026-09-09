# syntax=docker/dockerfile:1.7

ARG NODE_BUILD_IMAGE=node:24.15-bookworm
ARG NODE_RUNTIME_IMAGE=node:24.15-bookworm-slim

FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS sources
ARG PIGEON_SWARM_NODE_REF=main
ARG PIGEON_SWARM_NODE_REPOSITORY=https://github.com/haskou/pigeon-swarm-node.git
ARG PIGEON_SWARM_NODE_SHA=
ARG PIGEON_SWARM_UI_REF=main
ARG PIGEON_SWARM_UI_REPOSITORY=https://github.com/haskou/pigeon-swarm-ui.git
ARG PIGEON_SWARM_UI_SHA=
WORKDIR /sources
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/apt/*
RUN --mount=type=secret,id=github_token,required=false <<'EOF'
set -eu

github_token="$(cat /run/secrets/github_token 2>/dev/null || true)"
github_auth_header=""

if [ -n "${github_token}" ]; then
  github_auth_header="$(printf 'x-access-token:%s' "${github_token}" | base64 | tr -d '\n')"
fi

git_with_auth() {
  if [ -n "${github_auth_header}" ]; then
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${github_auth_header}" "$@"
  else
    git "$@"
  fi
}

clone_repository() {
  repository="$1"
  ref="$2"
  sha="$3"
  destination="$4"

  echo "Cloning ${repository} at ${sha:-${ref}}"

  if [ -n "${sha}" ]; then
    git_with_auth init "${destination}"
    git -C "${destination}" remote add origin "${repository}"
    git_with_auth -C "${destination}" fetch --depth 1 origin "${sha}"
    git -C "${destination}" checkout --detach FETCH_HEAD
  else
    git_with_auth clone --depth 1 --single-branch --branch "${ref}" "${repository}" "${destination}"
  fi

  rm -rf "${destination}/.git"
}

clone_repository "${PIGEON_SWARM_NODE_REPOSITORY}" "${PIGEON_SWARM_NODE_REF}" "${PIGEON_SWARM_NODE_SHA}" pigeon-swarm-node
clone_repository "${PIGEON_SWARM_UI_REPOSITORY}" "${PIGEON_SWARM_UI_REF}" "${PIGEON_SWARM_UI_SHA}" pigeon-swarm-ui
mkdir -p pigeon-swarm-node/scripts
EOF

FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS frontend-deps
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /build/frontend
COPY --from=sources /sources/pigeon-swarm-ui/package.json /sources/pigeon-swarm-ui/yarn.lock ./
RUN --mount=type=cache,id=pigeon-swarm-frontend-yarn,target=/tmp/yarn-cache,sharing=locked \
  YARN_CACHE_FOLDER=/tmp/yarn-cache yarn --frozen-lockfile --ignore-engines

FROM frontend-deps AS frontend-build
COPY --from=sources /sources/pigeon-swarm-ui/ ./
ARG VITE_API_SERVER_URL=/api
RUN VITE_API_SERVER_URL="${VITE_API_SERVER_URL}" yarn build

FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS backend-deps
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /build/backend
COPY --from=sources /sources/pigeon-swarm-node/package.json /sources/pigeon-swarm-node/yarn.lock ./
COPY --from=sources /sources/pigeon-swarm-node/scripts ./scripts
RUN --mount=type=cache,id=pigeon-swarm-backend-yarn,target=/tmp/yarn-cache,sharing=locked \
  YARN_CACHE_FOLDER=/tmp/yarn-cache yarn --frozen-lockfile --ignore-engines

FROM backend-deps AS backend-build
COPY --from=sources /sources/pigeon-swarm-node/src ./src
COPY --from=sources /sources/pigeon-swarm-node/config ./config
COPY --from=sources /sources/pigeon-swarm-node/tsconfig.json /sources/pigeon-swarm-node/tsconfig.build.json ./
ENV NODE_ENV=build
RUN yarn build
RUN set -eu; \
  find src/apps/apis -type f \( -name 'open-api.yaml' -o -name 'swagger.yaml' -o -name 'swagger.yml' \) \
  -exec sh -c 'for file do target="/build/backend/api-specs/${file}"; mkdir -p "$(dirname "${target}")"; cp "${file}" "${target}"; done' sh {} +

FROM ${NODE_BUILD_IMAGE} AS production-deps
WORKDIR /app
COPY --from=sources /sources/pigeon-swarm-node/package.json /sources/pigeon-swarm-node/yarn.lock ./
COPY --from=sources /sources/pigeon-swarm-node/scripts ./scripts
RUN --mount=type=cache,id=pigeon-swarm-production-yarn,target=/tmp/yarn-cache,sharing=locked \
  YARN_CACHE_FOLDER=/tmp/yarn-cache yarn --frozen-lockfile --ignore-engines --production

FROM ${NODE_RUNTIME_IMAGE} AS coturn-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git build-essential pkg-config libevent-dev libssl-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build/coturn
RUN git init \
  && git remote add origin https://github.com/coturn/coturn.git \
  && git fetch --depth=1 origin 97fd597fcb64861392b399ac824b044a2f0f5786 \
  && git checkout --detach FETCH_HEAD \
  && ./configure --prefix=/usr/local --disable-rpath \
  && make -j2 \
  && install -D bin/turnserver /out/usr/local/bin/turnserver \
  && install -D bin/turnutils_stunclient /out/usr/local/bin/turnutils_stunclient \
  && install -D docker/coturn/rootfs/usr/local/bin/detect-external-ip.sh /out/usr/local/bin/detect-external-ip \
  && install -Dm644 LICENSE /out/usr/local/share/licenses/coturn/LICENSE

FROM ${NODE_RUNTIME_IMAGE} AS production
WORKDIR /app
ARG IMAGE_SOURCE=https://github.com/haskou/pigeon-swarm
LABEL org.opencontainers.image.title="Pigeon Swarm" \
  org.opencontainers.image.description="Combined Pigeon Swarm backend and frontend image" \
  org.opencontainers.image.source="${IMAGE_SOURCE}" \
  org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu tini dnsutils libevent-2.1-7 libevent-core-2.1-7 libevent-extra-2.1-7 libevent-openssl-2.1-7 libevent-pthreads-2.1-7 libssl3 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/apt/*
COPY --from=coturn-build /out/ /
COPY --chmod=755 scripts/run-turn-from-runtime-config.sh scripts/check-turn-runtime.sh scripts/turn-peer-policy.conf /opt/pigeon/
COPY scripts/supervise-runtime.cjs scripts/check-app-runtime.cjs /usr/local/lib/pigeon/
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/prepare-turn-secret.cjs /usr/local/lib/pigeon/prepare-turn-secret.cjs
COPY --chown=node:node --from=sources /sources/pigeon-swarm-node/package.json ./
COPY --chown=node:node --from=production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=backend-build /build/backend/config ./config
COPY --chown=node:node --from=backend-build /build/backend/dist ./dist
COPY --chown=node:node --from=backend-build /build/backend/api-specs/src ./src
COPY --chown=node:node --from=frontend-build /build/frontend/dist ./public
ENV NODE_ENV=production \
  API_PORT=8080 \
  PORT=8080 \
  ROUTE_PREFIX=/api \
  LOG_LEVEL=info \
  LOG_URL=logs \
  SERVICE_NAME=pigeon-swarm \
  IPFS_STORAGE_PATH=/data/ipfs \
  IPFS_CONTENT_TIMEOUT_MS=3000 \
  PIGEON_LOCAL_DB_PATH=/data/local_storage \
  PIGEON_TURN_RUNTIME_CONFIG_PATH=/run/pigeon/calls-turn-runtime.conf \
  PIGEON_RELAY_DATA_LIMIT_BYTES=67108864 \
  LINK_PREVIEW_RATE_LIMIT_PER_MINUTE=30 \
  PUBSUB_TOPIC_PREFIX=pigeon-swarm \
  STARTUP_SYNC_PEER_WAIT_MS=10000 \
  TRANSPORT_DSN=libp2p-gossipsub:// \
  TRANSPORT_MAX_RETRIES=3 \
  TRANSPORT_RETRY_DELAY=1000
RUN install -d -o node -g node /app/logs /data/ipfs /data/local_storage /run/pigeon /run/pigeon-turn \
  && chmod 700 /run/pigeon-turn
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/usr/local/lib/pigeon/check-app-runtime.cjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
