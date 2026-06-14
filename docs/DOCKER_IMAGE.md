# Docker Image

This repository publishes one Docker image with the full Pigeon Swarm app:

- the backend service from [`pigeon-swarm-node`](https://github.com/haskou/pigeon-swarm-node)
- the frontend app from [`pigeon-swarm-ui`](https://github.com/haskou/pigeon-swarm-ui)

The image is published to [GitHub Container Registry](https://github.com/haskou/pigeon-swarm/pkgs/container/pigeon-swarm):

```text
ghcr.io/haskou/pigeon-swarm:latest
ghcr.io/haskou/pigeon-swarm:<branch>
ghcr.io/haskou/pigeon-swarm:sha-<commit>
```

Published tags are multi-architecture images for `linux/amd64` and `linux/arm64`.

## Quick Start

Start the example stack:

```bash
docker compose up
```

Open:

```text
http://localhost:8080
```

The included [`docker-compose.yml`](../docker-compose.yml) is intentionally small. It does not build the image. It pulls `ghcr.io/haskou/pigeon-swarm:latest` and persists both IPFS data and the node-local embedded database.

## Configuration

The image works with defaults. Copy [`.env.example`](../.env.example) to `.env` only when you want to change something:

```bash
cp .env.example .env
```

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port exposed on your machine by Docker Compose. |
| `IPFS_STORAGE_HOST_PATH` | `./ipfs_storage` | Host folder used by Docker Compose for IPFS storage. |
| `LOCAL_STORAGE_HOST_PATH` | `./local_storage` | Host folder used by Docker Compose for the embedded node-local database. |
| `LINK_PREVIEW_RATE_LIMIT_PER_MINUTE` | `30` | Maximum link preview requests per minute. Set `0` to disable the limit. |
| `PIGEON_RELAY_ENABLED` | empty | Optional relay override. Leave empty for defaults. Set `true` to force the public relay server. Set `false`, `0`, `no`, or `off` to disable relay servers. |
| `PIGEON_PRIVATE_RELAY_PORT_START` | empty | First TCP port in the optional private network relay range. |
| `PIGEON_PRIVATE_RELAY_PORT_END` | empty | Last TCP port in the optional private network relay range. |
| `PIGEON_RELAY_DATA_LIMIT_BYTES` | `67108864` | Per-reservation private relay data limit. Default is `64 MiB`. |
| `PIGEON_PUBLIC_HOST` | empty | Public DNS name or IP advertised by reachable private relay nodes. Required only when this node relays private networks. |
| `PUSH_VAPID_PUBLIC_KEY` | empty | Web Push public key. |
| `PUSH_VAPID_PRIVATE_KEY` | empty | Web Push private key. Keep it secret. |
| `PUSH_VAPID_SUBJECT` | empty | Contact used by browser push providers. |
| `LOG_LEVEL` | `info` | Application log level. |

Node-to-node transport is also configured by default. The image uses `libp2p-gossipsub://` without requiring anything in `.env`.

The frontend is built into the image and already talks to the backend through `/api`. You do not need to configure frontend URLs or route prefixes.

## Storage

The image does not require MongoDB. The backend stores node-local state in an embedded LevelDB database and replicated application state through OrbitDB/IPFS.

The Compose example persists:

| Path | Purpose |
| --- | --- |
| `/data/ipfs` | IPFS, libp2p and OrbitDB replicated data. |
| `/data/local_storage` | Embedded node-local database. |

The example Compose file uses host folders by default:

```text
./ipfs_storage
./local_storage
```

The image starts as root only long enough to create and assign ownership for `/data/ipfs`, `/data/local_storage`, `/data/pm2`, and `/app/logs`. The application process then runs as the non-root `node` user.

Back up both host folders if the node carries data you need to keep. Removing either folder creates a fresh local node state.

## Peer-to-peer Networking

The Compose example exposes only the web/API port by default:

| Port | Purpose |
| --- | --- |
| `8080` | Web app and HTTP API. |

For a simple local deployment, no extra ports are required.

Private networks use private IPFS/libp2p runtimes. A node can act as a private relay only for private networks it belongs to, because the relay must know the private network key.

`PIGEON_RELAY_ENABLED` is optional. Leave it empty for the default behavior. Set it to `true` only when this node should force-enable the public relay server. Set it to `false`, `0`, `no`, or `off` only when this node should not run relay servers.

Public networks do not require a relay. They can work without any relay node as long as peers can discover and reach each other through the public peer-to-peer layer.

Private networks should have at least one reachable relay node per private network. Without one, nodes that cannot dial each other directly may join the same private network but fail to exchange IPFS/OrbitDB data reliably. One node can relay all private networks it belongs to, so a deployment does not need a separate relay machine per private network.

To make a node act as a private relay, configure a relay port range:

```dotenv
PIGEON_PRIVATE_RELAY_PORT_START=4100
PIGEON_PRIVATE_RELAY_PORT_END=4199
PIGEON_PUBLIC_HOST=relay.example.com
```

The backend assigns one stable relay port from that range per private network. The configured range must be published in Docker and opened in the firewall/router. The Compose file includes a commented example:

```yaml
ports:
  - "8080:8080"
  - "4100-4199:4100-4199"
```

Nodes without a relay range remain leaf nodes. They can still use another reachable node as relay for shared private networks.

## Web Push Keys

Push notifications are disabled until VAPID keys are configured.

Generate keys once per deployment:

```bash
docker run --rm node:24.15-bullseye \
  sh -lc "corepack enable >/dev/null 2>&1 || true; npx web-push generate-vapid-keys"
```

The command prints a public key and a private key. Put them in `.env`:

```dotenv
PUSH_VAPID_PUBLIC_KEY=<generated-public-key>
PUSH_VAPID_PRIVATE_KEY=<generated-private-key>
PUSH_VAPID_SUBJECT=mailto:admin@example.com
```

Use a real email address in `PUSH_VAPID_SUBJECT` for production.

## Building Locally

The Dockerfile is the only place where the backend and frontend are combined. Local builds require Docker BuildKit/Buildx because the Dockerfile uses build secrets to access private source repositories.

While the source repositories are private, set a GitHub token with read access to both:

- `haskou/pigeon-swarm-node`
- `haskou/pigeon-swarm-ui`

Build locally:

```bash
GITHUB_TOKEN=github_pat_xxx DOCKER_BUILDKIT=1 docker build \
  --secret id=github_token,env=GITHUB_TOKEN \
  --target production \
  --tag pigeon-swarm:local \
  .
```

The Docker build context intentionally includes only the Dockerfile. Source code is cloned inside the build using the configured repository URLs and refs.

## Publishing

The [publish workflow](../.github/workflows/publish-docker.yml) publishes the image when this repository receives a push to `main`.

The [validation workflow](../.github/workflows/validate.yml) runs on every push and pull request. It validates the Docker Compose example and checks that the public configuration stays simple.

For GitHub Actions, add this repository secret while the source repositories are private:

```text
SOURCE_REPOSITORIES_TOKEN
```

The workflow also accepts `repository_dispatch` with the `source-published` event type. Source repositories can call that event after their own `main` branch changes to request a fresh combined image.

Published images include OCI metadata labels, GitHub Actions cache, SBOM generation, and provenance attestation through Docker Buildx.

## Source Branches

The source repositories have been checked on GitHub:

- [`haskou/pigeon-swarm-node`](https://github.com/haskou/pigeon-swarm-node): default branch `main`
- [`haskou/pigeon-swarm-ui`](https://github.com/haskou/pigeon-swarm-ui): default branch `main`

By default, the Dockerfile clones exactly `main` from both repositories. If that branch does not exist or cannot be read, the build fails.
