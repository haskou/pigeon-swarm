# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.15-bullseye

FROM ${NODE_IMAGE} AS sources
ARG PIGEON_SWARM_NODE_REF=main
ARG PIGEON_SWARM_NODE_REPOSITORY=https://github.com/haskou/pigeon-swarm-node.git
ARG PIGEON_SWARM_UI_REF=main
ARG PIGEON_SWARM_UI_REPOSITORY=https://github.com/haskou/pigeon-swarm-ui.git
WORKDIR /sources
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=github_token,required=false <<'EOF'
set -eu

github_token="$(cat /run/secrets/github_token 2>/dev/null || true)"
github_auth_header=""

if [ -n "${github_token}" ]; then
  github_auth_header="$(printf 'x-access-token:%s' "${github_token}" | base64 | tr -d '\n')"
fi

clone_repository() {
  repository="$1"
  ref="$2"
  destination="$3"

  echo "Cloning ${repository} at ${ref}"

  if [ -n "${github_auth_header}" ]; then
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${github_auth_header}" \
      clone --depth 1 --single-branch --branch "${ref}" "${repository}" "${destination}"
  else
    git clone --depth 1 --single-branch --branch "${ref}" "${repository}" "${destination}"
  fi
}

clone_repository "${PIGEON_SWARM_NODE_REPOSITORY}" "${PIGEON_SWARM_NODE_REF}" pigeon-swarm-node
clone_repository "${PIGEON_SWARM_UI_REPOSITORY}" "${PIGEON_SWARM_UI_REF}" pigeon-swarm-ui
EOF

FROM ${NODE_IMAGE} AS frontend-deps
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /build/frontend
COPY --from=sources /sources/pigeon-swarm-ui/package.json /sources/pigeon-swarm-ui/yarn.lock ./
RUN --mount=type=cache,target=/tmp/yarn-cache \
  YARN_CACHE_FOLDER=/tmp/yarn-cache yarn --frozen-lockfile --ignore-engines

FROM frontend-deps AS frontend-build
COPY --from=sources /sources/pigeon-swarm-ui/ ./
RUN printf "export const API_SERVER_URL = import.meta.env.VITE_API_SERVER_URL ?? '/api';\n" > src/config.ts
ARG VITE_API_SERVER_URL=/api
RUN VITE_API_SERVER_URL="${VITE_API_SERVER_URL}" yarn build

FROM ${NODE_IMAGE} AS backend-deps
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /build/backend
COPY --from=sources /sources/pigeon-swarm-node/package.json /sources/pigeon-swarm-node/yarn.lock ./
RUN --mount=type=cache,target=/tmp/yarn-cache \
  YARN_CACHE_FOLDER=/tmp/yarn-cache yarn --frozen-lockfile --ignore-engines

FROM backend-deps AS backend-build
COPY --from=sources /sources/pigeon-swarm-node/src ./src
COPY --from=sources /sources/pigeon-swarm-node/config ./config
COPY --from=sources /sources/pigeon-swarm-node/tsconfig.json /sources/pigeon-swarm-node/tsconfig.build.json ./
ENV NODE_ENV=build
RUN yarn build

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY --from=sources /sources/pigeon-swarm-node/package.json /sources/pigeon-swarm-node/yarn.lock ./
RUN --mount=type=cache,target=/tmp/yarn-cache \
  YARN_CACHE_FOLDER=/tmp/yarn-cache yarn --frozen-lockfile --ignore-engines --production

FROM ${NODE_IMAGE} AS production
WORKDIR /app
ARG IMAGE_SOURCE=https://github.com/haskou/pigeon-swarm
LABEL org.opencontainers.image.title="Pigeon Swarm" \
      org.opencontainers.image.description="Combined Pigeon Swarm backend and frontend image" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
COPY --chown=node:node --from=sources /sources/pigeon-swarm-node/package.json ./
COPY --chown=node:node --from=production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=backend-build /build/backend/config ./config
COPY --chown=node:node --from=backend-build /build/backend/dist ./dist
COPY --chown=node:node --from=frontend-build /build/frontend/dist ./public
ENV NODE_ENV=production \
    API_PORT=8080 \
    PORT=8080 \
    ROUTE_PREFIX=/api \
    LOG_LEVEL=info \
    LOG_URL=/logs \
    SERVICE_NAME=pigeon-swarm \
    PM2_HOME=/data/pm2 \
    MONGO_URL=mongodb://mongodb:27017 \
    MONGO_DATABASE=pigeon-swarm \
    MONGO_SERVER_SELECTION_TIMEOUT_MS=1000 \
    IPFS_STORAGE_PATH=/data/ipfs \
    IPFS_CONTENT_TIMEOUT_MS=3000 \
    PUBSUB_TOPIC_PREFIX=pigeon-swarm \
    STARTUP_SYNC_PEER_WAIT_MS=10000 \
    TRANSPORT_DSN=libp2p-gossipsub:// \
    TRANSPORT_MAX_RETRIES=3 \
    TRANSPORT_RETRY_DELAY=1000
RUN install -d -o node -g node /logs /data/ipfs /data/pm2
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.API_PORT || process.env.PORT || '8080') + '/').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["./node_modules/.bin/pm2-runtime", "start", "dist/index.js"]
