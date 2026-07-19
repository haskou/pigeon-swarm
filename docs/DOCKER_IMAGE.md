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
cp .env.example .env
openssl rand -hex 32
# Put the generated value in CALLS_TURN_SHARED_SECRET inside .env.
docker compose up
```

The secret is mandatory because the backend uses it to mint temporary TURN
credentials and coturn uses the same value to validate them. Compose refuses to
start with an empty secret instead of silently returning an unusable
`iceServers: []` response.

Open:

```text
http://localhost:8080
```

The included [`docker-compose.yml`](../docker-compose.yml) is intentionally small. It does not build the image. It pulls `ghcr.io/haskou/pigeon-swarm:latest` and persists both IPFS data and the node-local embedded database.

## Configuration

The application image keeps its runtime defaults, but the Compose stack requires
one deployment-specific TURN secret. Copy [`.env.example`](../.env.example) to
`.env` and set `CALLS_TURN_SHARED_SECRET` before startup:

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
| `PIGEON_RELAY_DATA_LIMIT_BYTES` | `67108864` | Per-reservation relay data limit in bytes. Increase it only when relay transfers need larger reservations. |
| `CALLS_TURN_SHARED_SECRET` | required | Shared coturn REST secret. Generate it once and configure the same value on every backend and coturn instance in the relay pool. |
| `CALLS_TURN_PORT` | `3478` | Public UDP/TCP TURN listening port. It must match `callsRelay.port` in the node relay configuration. |
| `CALLS_TURN_EXTERNAL_IP` | detected | Optional public IPv4 override for coturn. Leave empty to detect it at startup. |
| `CALLS_TURN_RELAY_MIN_PORT` | `49160` | First UDP media relay port exposed by coturn. |
| `CALLS_TURN_RELAY_MAX_PORT` | `49200` | Last UDP media relay port exposed by coturn. |
| `CALLS_TURN_REALM` | `pigeon-swarm` | Authentication realm reported by coturn. |
| `CALLS_TURN_TRANSPORTS` | `udp,tcp` | TURN transports advertised by the backend. |
| `CALLS_ICE_TRANSPORT_POLICY` | `all` | Browser ICE policy returned by `/calls/ice-servers`. |
| `CALLS_TURN_URLS` | empty | Optional explicit comma-separated TURN/TURNS URLs. By default the backend derives TURN URLs from the node relay configuration. |
| `PUSH_VAPID_PUBLIC_KEY` | empty | Web Push public key. |
| `PUSH_VAPID_PRIVATE_KEY` | empty | Web Push private key. Keep it secret. |
| `PUSH_VAPID_SUBJECT` | empty | Contact used by browser push providers. |
| `LOG_LEVEL` | `info` | Application log level. |

Node-to-node transport is also configured by default. The image uses `libp2p-gossipsub://` without requiring anything in `.env`.

The frontend is built into the image and already talks to the backend through `/api`. You do not need to configure frontend URLs or route prefixes.

## TURN For WebRTC Calls

The Compose stack runs coturn separately from the application container. It
uses host networking, as recommended by the
[official coturn image documentation](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md)
for relay port ranges. This stack therefore targets Linux hosts.

After choosing the public hostname, configure the backend node with a
`callsRelay.port` equal to `CALLS_TURN_PORT`:

```http
PUT /api/node/relay-configuration
```

```json
{
  "publicHost": "relay.example.com",
  "callsRelay": {
    "port": 3478
  }
}
```

Open or forward all of these ports to the host without translating the media
port numbers:

- `${CALLS_TURN_PORT}` over UDP and TCP;
- `${CALLS_TURN_RELAY_MIN_PORT}-${CALLS_TURN_RELAY_MAX_PORT}` over UDP.

Coturn detects the host's external IPv4 address at startup. If the host sits
behind NAT, the router must preserve the UDP relay port numbers because coturn
returns those ports to WebRTC clients. `turns:` is not enabled by this minimal
stack; add an explicit `CALLS_TURN_URLS` entry only after terminating TURN TLS
with a valid certificate.

Verify the local listener and REST credentials from the running service:

```bash
docker compose ps turn
./scripts/verify-turn.sh
```

Run an equivalent allocation test from a machine outside the server's LAN to
verify the public firewall and NAT path. A TCP port probe alone does not verify
that coturn can allocate and exchange media through its UDP relay range.

Once the node relay configuration is saved, authenticated calls to
`GET /api/calls/ice-servers` return the local TURN URLs plus a temporary
`username` and `credential`. Leaf nodes use records from their currently
connected relay, provided they share the same TURN secret.

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

The image starts as root only long enough to create and assign ownership for `/data/ipfs`, `/data/local_storage`, and `/app/logs`. The application process then runs as the non-root `node` user.

Back up both host folders if the node carries data you need to keep. Removing either folder creates a fresh local node state.

## Peer-to-peer Networking

The Compose example exposes only the web/API port by default:

| Port | Purpose |
| --- | --- |
| `8080` | Web app and HTTP API. |

For a simple local deployment, no extra ports are required.

Private networks use private IPFS/libp2p runtimes. A node can act as a private relay only for private networks it belongs to, because the relay must know the private network key.

Relay node selection and relay port configuration are owner-managed during node startup instead of being configured through Docker environment variables. The image only keeps `PIGEON_RELAY_DATA_LIMIT_BYTES` as an optional relay data-limit override.

Public networks do not require a relay. They can work without any relay node as long as peers can discover and reach each other through the public peer-to-peer layer.

Private networks should have at least one reachable relay node per private network. Without one, nodes that cannot dial each other directly may join the same private network but fail to exchange IPFS/OrbitDB data reliably. One node can relay all private networks it belongs to, so a deployment does not need a separate relay machine per private network.

If this node is configured as a relay, publish the ports selected during startup and open them in Docker, the firewall, and the router. Reserve at least one TCP port per private network this node will relay. For example, a node expected to relay up to 100 private networks needs a published range with at least 100 ports, such as `4100-4199`.

Nodes without relay configuration remain leaf nodes. They can still use another reachable node as relay for shared private networks.

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
