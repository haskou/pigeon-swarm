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

First create `.env` with a private TURN secret using the
[configuration steps below](#configuration). Then start the example stack:

```bash
docker compose up
```

An empty secret is a startup error. Existing installations using the former
public fallback must follow the [rotation steps](#turn-for-webrtc-calls)
before upgrading.

The TURN entrypoint writes the secret to a mode-`0600` configuration file on
tmpfs and removes it from the long-running `turnserver` environment. It is not
passed in the process command line.

Open:

```text
http://localhost:8080
```

The included [`docker-compose.yml`](../docker-compose.yml) is intentionally small. It does not build the image. It pulls `ghcr.io/haskou/pigeon-swarm:latest` and persists both IPFS data and the node-local embedded database.

## Configuration

Create `.env` once from [`.env.example`](../.env.example), generating a private
TURN secret directly into the file. This requires OpenSSL and refuses to
overwrite an existing `.env`. The secret is not printed or passed in arguments:

```bash
(
  set -eu
  umask 077
  set -C
  {
    sed '/^CALLS_TURN_SHARED_SECRET=/d' .env.example
    printf 'CALLS_TURN_SHARED_SECRET='
    openssl rand -hex 32
  } > .env
)
```

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port exposed on your machine by Docker Compose. |
| `IPFS_STORAGE_HOST_PATH` | `./ipfs_storage` | Host folder used by Docker Compose for IPFS storage. |
| `LOCAL_STORAGE_HOST_PATH` | `./local_storage` | Host folder used by Docker Compose for the embedded node-local database. |
| `LINK_PREVIEW_RATE_LIMIT_PER_MINUTE` | `30` | Maximum link preview requests per minute. Set `0` to disable the limit. |
| `PIGEON_RELAY_DATA_LIMIT_BYTES` | `67108864` | Per-reservation relay data limit in bytes. Increase it only when relay transfers need larger reservations. |
| `CALLS_TURN_SHARED_SECRET` | required; no default | Private coturn REST secret, 32–256 base64/hex-compatible characters. Generate 32 random bytes as hex; length validation alone cannot establish entropy. Backend and coturn receive the same value. |
| `CALLS_TURN_EXTERNAL_IP` | auto-detected IPv4 | Explicit IPv4 address or `public/private` IPv4 mapping. No hostnames; this override currently supports IPv4 only. |
| `CALLS_TURN_TLS_PORT` | `5349` | Dedicated TLS listener/published TCP port when using the TLS overlay. Must not overlap the plain listener or relay range. |
| `CALLS_TURN_TLS_SERVER_NAME` | required for TLS | DNS hostname covered by the server certificate, used for local TLS verification. |
| `CALLS_TURN_TLS_CERTS_DIR` | required for TLS | Existing directory with `fullchain.pem` and `privkey.pem`, mounted read-only by the TLS overlay. |
| `CALLS_TURN_URLS` | required for TLS overlay | Explicit advertised TURN URLs, including `turns:hostname:port?transport=tcp` for the configured certificate and TLS listener. |
| `PUSH_VAPID_PUBLIC_KEY` | empty | Web Push public key. |
| `PUSH_VAPID_PRIVATE_KEY` | empty | Web Push private key. Keep it secret. |
| `PUSH_VAPID_SUBJECT` | empty | Contact used by browser push providers. |
| `LOG_LEVEL` | `info` | Application log level. |

Node-to-node transport is also configured by default. The image uses `libp2p-gossipsub://` without requiring anything in `.env`.

The frontend is built into the image and already talks to the backend through `/api`. You do not need to configure frontend URLs or route prefixes.

## TURN For WebRTC Calls

Compose refuses to start without `CALLS_TURN_SHARED_SECRET`. The TURN launcher
also rejects the former public fallback, short values, oversized values and
characters that could inject coturn configuration. It writes the secret to a
mode-600 file in tmpfs and removes it from the turnserver child's environment.
The Docker administrator can still inspect container configuration; this is
not a substitute for controlling access to Docker and protecting `.env`.

For an existing installation using the public fallback, rotate it once before
upgrading. The following preserves other settings, saves a private backup and
writes the new secret without printing it. Run it only for an intentional
rotation, not on every restart:

```sh
(
  set -eu
  umask 077
  test -f .env
  backup="$(mktemp .env.backup.XXXXXX)"
  cp .env "$backup"
  chmod 600 "$backup"
  replacement="$(mktemp .env.rotation.XXXXXX)"
  trap 'rm -f "$replacement"' EXIT
  sed '/^CALLS_TURN_SHARED_SECRET=/d' .env > "$replacement"
  printf '\nCALLS_TURN_SHARED_SECRET=' >> "$replacement"
  openssl rand -hex 32 >> "$replacement"
  mv "$replacement" .env
)
docker compose up -d --force-recreate app turn
```

Keep `.env` across restarts. Rotating the secret invalidates existing temporary
credentials and can interrupt calls. Coordinate rotation with every backend
that issues credentials for this TURN server. Two independent TURN servers do
not need the same secret to exchange relayed traffic. The current backend's
distributed credential issuance and relay-record pool validation do require
matching secrets for participating issuers and the servers they advertise;
independent per-server issuance is tracked in
[pigeon-swarm-node#286](https://github.com/haskou/pigeon-swarm-node/issues/286).

The Compose stack runs coturn separately while sharing the application's
network namespace. The backend writes a local runtime contract whenever the
persisted node relay configuration changes. Coturn observes that contract and
starts, stops, or reloads automatically. TURN ports and browser ICE policy do
not need environment variables.

After choosing the public hostname, configure the backend node with a calls
relay listener and a private relay range:

```http
PUT /api/node/relay-configuration
```

```json
{
  "publicHost": "relay.example.com",
  "callsRelay": {
    "port": 4101
  },
  "privateRelay": {
    "enabled": true,
    "portStart": 4102,
    "portEnd": 4199
  }
}
```

Publish and forward:

- `callsRelay.port` over UDP and TCP;
- `privateRelay.portStart-privateRelay.portEnd` over TCP for private IPFS and
  UDP for TURN media.

The TURN listener must be outside the configured media range. Coturn detects
the host's external IPv4 address when it starts unless `CALLS_TURN_EXTERNAL_IP`
is set. For a known mapping, set it to `203.0.113.10/10.0.0.10`, replacing those
example addresses with the actual public and container-reachable local IPv4
addresses. The private address must belong to coturn's shared network namespace.
The diagnostic checks that allocations advertise the configured public IPv4.
Syntax validation and an advertised address do not establish reachability.
If the host sits behind NAT,
the router must preserve the UDP relay port numbers because coturn returns
those ports to WebRTC clients.

Verify the local listener and REST credentials from the running service:

```bash
docker compose ps turn
./scripts/verify-turn.sh
```

The check uses the backend container's issuer secret, verifies authenticated
allocation over UDP and TCP, and requires wrong-secret and expired credentials
to receive an authentication rejection. It verifies response integrity and
releases successful allocations. A failed valid allocation explicitly points
to a possible backend/coturn secret mismatch. Neither the shared secret nor
temporary credentials are passed as command-line arguments or printed.

The automated equivalent, `node --test tests/turn-runtime.integration.mjs`,
uses the real pinned coturn image with an isolated Node fixture in the shared
network namespace. It also checks a coturn restart and a deliberately mismatched
issuer secret. It does not run the complete backend or browser application.

Run an equivalent allocation test from a machine outside the server's LAN to
verify the public firewall and NAT path. A TCP port probe alone does not verify
that coturn can allocate and exchange media through its UDP relay range.

These local checks do not prove public reachability or browser audio.
An external network acceptance test remains tracked in
[#29](https://github.com/haskou/pigeon-swarm/issues/29). Behind CGNAT without
forwardable ports, detecting an external IP does not make this host a public
relay; use a reachable relay host. For ordinary NAT, publish and forward the
listener and full media range with unchanged port numbers.

### Optional TLS Listener

Obtain a valid certificate for the relay hostname and place its full chain and
unencrypted private key in an existing directory outside the repository (or
the ignored `turn-certs/` directory). Coturn runs as UID 65534 / GID 65533 in
the pinned image: grant that identity read access, restrict the private key
to that identity and its administrator, and mount the directory read-only.
Do not commit the key or relax it to world-readable for a production deployment.
The launcher refuses missing or unreadable files. Certificate/key validity is
checked by coturn and by the TLS diagnostic below.

Configure `.env`, using the real hostname and certificate directory:

```dotenv
CALLS_TURN_TLS_PORT=5349
CALLS_TURN_TLS_SERVER_NAME=relay.example.com
CALLS_TURN_TLS_CERTS_DIR=/absolute/path/to/turn-certificates
CALLS_TURN_URLS=turns:relay.example.com:5349?transport=tcp
```

The backend can advertise these explicit URLs alongside URLs derived from its
persisted relay configuration. Keep the hostname and port aligned with the
certificate, public DNS and Docker/router mapping. Configure the persisted
plain listener and relay range as shown above; the TLS port is additional and
must be outside both. It must also differ from the application's internal
port `8080` and its published web port (`PORT`). The ordinary stack keeps TLS disabled unless the overlay
is selected; DTLS remains disabled.

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.turn-tls.yml
docker compose up -d --force-recreate app turn
./scripts/verify-turn.sh
```

Keep the same `COMPOSE_FILE` selection for subsequent commands. The overlay
publishes the TLS TCP port on the app because coturn shares its network
namespace. Publish the plain listener and media range separately in the base
Compose file. For the example configuration, the complete port matrix is:

| Host/container ports | Protocol | Purpose | Router/firewall requirement |
| --- | --- | --- | --- |
| `8080` (or `PORT`) | TCP | Web/API | Expose according to the web deployment, usually behind HTTPS. |
| `4101` | UDP and TCP | Plain TURN listener | Forward both if advertising the corresponding `turn:` URLs. |
| `5349` | TCP | TLS TURN listener | Forward TCP and advertise the certificate hostname with this port. |
| `4102–4199` | UDP | TURN relay allocations | Forward the whole range with unchanged port numbers. |
| `4102–4199` | TCP | Private IPFS relay nodes | Publish the range selected for private relays. |

TLS on the client-to-TURN connection still uses UDP relay allocations in this
configuration. Opening only the TLS port is insufficient for media forwarding.
The local probe now also authenticates over TLS, checks server trust and the
configured hostname, and rejects invalid/expired TURN credentials over TLS.
It requires TLS 1.2 or newer and never disables certificate verification.
For a private CA, install that CA in the diagnostic client's trust store; never
copy the TURN private key to a client or disable verification.

After certificate renewal, restart coturn and rerun the probe. Certificates are
loaded on process startup, not automatically reloaded by the runtime-config
watcher. The container healthcheck is still a local STUN check; it does not
establish TLS certificate validity. A failed TLS probe is a deployment failure
even when that healthcheck is green.

The integration suite generates an isolated test certificate, verifies TLS
allocation before and after restart, and rejects an untrusted certificate and
an incorrect hostname. It verifies an explicit advertised IPv4 mapping, but it
does not emulate a router or test a real external network. Quotas, destination
restrictions and browser media acceptance remain open in #29.

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
