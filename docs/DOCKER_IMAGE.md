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

## Quick Start

Start the example stack:

```bash
docker compose up
```

Open:

```text
http://localhost:8080
```

The included [`docker-compose.yml`](../docker-compose.yml) is intentionally small. It does not build the image and it does not declare volumes. It pulls `ghcr.io/haskou/pigeon-swarm:latest` and starts a temporary MongoDB service so newcomers can try the app quickly.

## Configuration

The image works with defaults. Copy [`.env.example`](../.env.example) to `.env` only when you want to change something:

```bash
cp .env.example .env
```

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port exposed on your machine by Docker Compose. |
| `PUSH_VAPID_PUBLIC_KEY` | empty | Web Push public key. |
| `PUSH_VAPID_PRIVATE_KEY` | empty | Web Push private key. Keep it secret. |
| `PUSH_VAPID_SUBJECT` | empty | Contact used by browser push providers. |
| `LOG_LEVEL` | `info` | Application log level. |

MongoDB is already configured for the bundled Compose example. The app connects to the `mongodb` service and uses the `pigeon-swarm` database by default.

Node-to-node transport is also configured by default. The image uses `libp2p-gossipsub://` without requiring anything in `.env`.

The frontend is built into the image and already talks to the backend through `/api`. You do not need to configure frontend URLs or route prefixes.

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

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0. Commercial use requires a separate commercial license from the author.

## Source Branches

The source repositories have been checked on GitHub:

- [`haskou/pigeon-swarm-node`](https://github.com/haskou/pigeon-swarm-node): default branch `main`
- [`haskou/pigeon-swarm-ui`](https://github.com/haskou/pigeon-swarm-ui): default branch `main`

By default, the Dockerfile clones exactly `main` from both repositories. If that branch does not exist or cannot be read, the build fails.
