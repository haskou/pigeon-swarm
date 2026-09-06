# Independent browser client

The independent client serves a fixed UI build from a distributor-controlled origin. Users select a separate Pigeon Swarm node for API, WebSocket events, storage, and call signaling. The static server contains no backend or API proxy and never downloads executable UI code from the selected node.

The distributor remains trusted with executable code. A malicious distributor, compromised client build, hosting account, or browser extension can read browser-accessible keys and plaintext. Separating the client origin prevents a selected node from automatically replacing the application; it does not make arbitrary JavaScript safe or eliminate trust in the distributor. A selected node still handles transport and associated metadata, and can withhold or manipulate responses subject to the client's validation and cryptographic checks.

A signed native package could enforce OS-level publisher and update checks without trusting a web host on each page load. It would still trust its publisher and would not hide routing metadata from nodes. This release uses a separately hosted, verifiable web artifact to retain browser support and existing media flows; native packaging is not required for this boundary and is deferred rather than presented as an anonymity guarantee.

## Build and release

`Dockerfile.client` consumes a named `ui` build context, installs the frozen Yarn lockfile, and builds with `VITE_INDEPENDENT_CLIENT=true` and an empty `VITE_API_SERVER_URL`. Its runtime contains only the built static files and the dependency-free Node static server, running as the `node` user. Use a reviewed exact UI commit, including the independent-client changes:

```sh
UI_SHA='<reviewed full 40-character UI commit>'
git -C ../pigeon-swarm-ui checkout --detach "$UI_SHA"
test "$(git -C ../pigeon-swarm-ui rev-parse HEAD)" = "$UI_SHA"
UI_CONTEXT="$(mktemp -d)"
git -C ../pigeon-swarm-ui archive "$UI_SHA" | tar -x -C "$UI_CONTEXT"
docker buildx build --load -f Dockerfile.client \
  --build-context "ui=$UI_CONTEXT" \
  --build-arg "PIGEON_SWARM_UI_SHA=$UI_SHA" \
  --build-arg "PIGEON_SWARM_WRAPPER_SHA=$(git rev-parse HEAD)" \
  -t pigeon-swarm-client:reviewed .
```

The wrapper checkout determines the Dockerfile and static-server source. Record its exact commit too. The archive exports the tracked tree of that commit, excluding local modifications, untracked build outputs and credentials, and `.git`. Tracked files remain part of the build input and must be reviewed. The build rejects a missing or malformed UI SHA. `/client-release.json` contains `sourceCommit` and `contractVersion: 1`; it is informational metadata, not a signature.

The manually dispatched `Publish independent client` workflow accepts only a full lowercase UI SHA. It checks out that commit and exports its tracked tree as the named context. Before publishing, it builds the selected source into a local image, extracts that image’s static files, and runs the independent-client browser contract against them. An old or incompatible UI commit must pass that gate before any registry push. It then publishes `ghcr.io/<owner>/<wrapper-repository>-client:build-<run-id>-<attempt>` for amd64 and arm64, without a `latest` tag. The run summary records the immutable image digest, UI commit, and wrapper commit. OCI labels record both source revisions and the version; BuildKit emits provenance and an SBOM.

The workflow uses the existing `SOURCE_REPOSITORIES_TOKEN` secret only if needed to read a private UI repository; credentials are not persisted or passed into the Docker build. Publishing needs GHCR package write access and GitHub OIDC/attestation permissions. Dispatch is a release action: review the exact UI and wrapper sources before starting it. No publication is required to run local validation.

## Verify before deploying

The workflow creates GitHub artifact attestations for both the OCI digest and `independent-client-build.json`. The latter binds the published digest to the recorded UI commit, wrapper commit, workflow run, and version. Download and retain this file before the workflow artifact retention period expires. Replace the placeholders with the reviewed run and source commit:

```sh
REPOSITORY='haskou/pigeon-swarm'
RUN_ID='<release run ID>'
RUN_ATTEMPT='<release run attempt>'
WRAPPER_SHA='<reviewed wrapper commit>'
gh run download "$RUN_ID" --repo "$REPOSITORY" \
  --name "independent-client-build-$RUN_ID-$RUN_ATTEMPT"
gh attestation verify independent-client-build.json \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/publish-client.yml" \
  --source-digest "$WRAPPER_SHA" --deny-self-hosted-runners
cat independent-client-build.json
```

After successful verification, compare `uiCommit` with the reviewed UI SHA and `wrapperCommit` with the reviewed wrapper SHA. Copy the complete `image` value from that verified file:

```sh
CLIENT_IMAGE='ghcr.io/haskou/pigeon-swarm-client@sha256:<verified digest>'
gh attestation verify "oci://$CLIENT_IMAGE" --bundle-from-oci \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/publish-client.yml" \
  --source-digest "$WRAPPER_SHA" --deny-self-hosted-runners
docker pull "$CLIENT_IMAGE"
```

Authenticate the GitHub CLI and registry as required by their access policies. Verification must succeed for the expected repository, workflow, source commit, and artifact; do not merely check that some signature exists. See the [GitHub CLI verification reference](https://cli.github.com/manual/gh_attestation_verify) and [GitHub attestation action](https://github.com/actions/attest).

Attestation proves that the identified workflow asserted provenance for those bytes. It does not prove the source is safe, the build is reproducible, or that a public website serves those bytes. The UI SHA in the metadata is a claim by the trusted workflow, whose checkout and build logic must also be reviewed. Browsers do not automatically verify OCI attestations before executing a website. A website operator can replace HTML, JavaScript, headers, and the displayed release metadata; users who need control over that trust should verify and host the digest themselves. Base-image and action version tags can change between builds, so an exact UI SHA alone does not identify identical final bytes; the image digest does.

## Run, update, and roll back

For a local browser on the same machine:

```sh
docker run --name pigeon-client --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8081:8080 "$CLIENT_IMAGE"
```

Open `http://localhost:8081`. For remote use, serve a dedicated HTTPS origin with a browser-trusted certificate, either at a reverse proxy that preserves the security headers or using `CLIENT_TLS_CERT_FILE` and `CLIENT_TLS_KEY_FILE` together. Mount certificates read-only and make them readable by the `node` user. The server listens on `CLIENT_PORT` (default `8080`) and serves `CLIENT_ROOT` (default `/app/public`). Both TLS variables are required when either is set. Never disable certificate validation to make deployment work.

Do not mount a selected node's UI directory into this container or configure a proxy to fetch scripts from that node. Preserve the client origin across releases so that browser-local identity storage stays associated with the same origin. Changing hostname, scheme, or port creates a different browser origin.

For an update, retain the running digest and verified metadata, verify the new release as above, and start the new digest on a staging port. Check the release metadata, node selection, identity loading, and media behavior. Then replace the serving container or switch the reverse proxy to that digest. Keep the previous digest available for rollback. A version tag is a discovery label; deploy `@sha256:...` references.

To roll back, redeploy the previous verified digest on the same client origin and reload the browser. Never rebuild an old UI SHA and assume it recreates the old release. Client updates and rollbacks do not reset browser storage; confirm that the older version understands any state written by the newer version before rolling back. The server marks HTML, `sw.js`, and release metadata `no-store`; only content-hashed build assets receive immutable caching. In independent mode the service worker handles notifications but never intercepts resource requests, so it cannot pin an old application shell. Close stale tabs and confirm the expected `/client-release.json` after switching releases.

## Node selection and browser contract

The selected address is a separate node API base, normally an HTTPS URL ending in `/api`. The UI validates and normalizes it before use. Remote HTTP addresses, embedded credentials, query strings, fragments, and non-network schemes must not be used. Local development can use exact loopback hosts `localhost` or `127.0.0.1`; browser mixed-content and local-network policies can still restrict requests. The selected node must allow the client origin through its CORS policy and support the independent-client API contract. The public `/client-contract` must return protocol `pigeon-swarm` and `apiVersion: 1`; failure blocks application bootstrap. Changing nodes retires the previous push subscription and reloads the whole document to close active sessions and workers. Other tabs on that client origin return to node selection when the saved selection changes, so they cannot keep an old session running. Credentials, device-unlock state, projections, notifications, and workspace storage are partitioned by the normalized node URL. Switching back restores that node’s stored state. Existing combined-client storage keys remain unchanged.

HTTP API and blob fetches omit ambient cookies and reject redirects. Native WebSocket handshakes still include any cookies eligible under browser policy for the selected node: JavaScript cannot set a credential-omission option on WebSocket. Use a dedicated API hostname outside unrelated applications' cookie scopes; another subdomain is insufficient when cookies cover a shared parent domain. This reduces exposure but does not guarantee that no existing or subsequently set cookies reach the node. Signed WebSocket authentication and CSP do not change this behavior. This release does not promise cookie-free realtime; a credentialless backend/client realtime protocol is tracked in [node #291](https://github.com/haskou/pigeon-swarm-node/issues/291), alongside the broader metadata work.

The static origin denies remote scripts, JavaScript `eval`, plugins, framing, base-URL changes, and form submissions. Its CSP allows same-origin scripts and workers, blob workers, and WebAssembly compilation needed by RNNoise. Existing UI styles require inline styles. HTTPS/WSS connections are permitted for selectable remote nodes; HTTP/WS exceptions are limited to exact loopback hosts. The CSP is a defense around the trusted client, not a replacement for endpoint validation or response sanitization.

Independent mode rejects external profile-picture and banner URLs. Link previews retain text and hyperlinks without loading remote images or favicons; push notifications use bundled icons and badges. Uploaded CID images remain available through protected fetches and local blob URLs. The static origin's image CSP permits only same-origin, data, and blob images, so cached external profile URLs cannot initiate image or CSS-background requests to a remote host.

Camera, microphone, and screen capture remain limited to the client origin by Permissions Policy and still require browser permission. Remote clients need a secure HTTPS context for these features. Preserve `Permissions-Policy`, `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` at the reverse proxy. Validate media in a real browser against the intended node and TURN configuration; serving the page successfully does not establish media connectivity.

## Validation

The independent-client CI job skips fork pull requests and Dependabot runs because they cannot use the private UI repository credential. It runs for trusted repository contexts; maintainers must configure `SOURCE_REPOSITORIES_TOKEN` with read access to the UI repository. The wrapper-only static-server checks still run for untrusted pull requests.

Run `node --test tests/client-server.test.mjs` for real HTTP path, MIME, caching and header checks. Build the UI in independent mode, set `PIGEON_CLIENT_DIST` to its absolute `dist` path, install the wrapper’s test dependencies and Playwright Chromium, then run:

```sh
node --test tests/independent-client-browser.integration.mjs
```

These browser cases use deliberately synthetic backend responses to test compatibility rejection, TLS rejection, origin isolation, node switching, and update/rollback under the actual service worker. They do not establish backend interoperability.

For that acceptance check, set `PIGEON_TEST_IMAGE` to an immutable application image digest, retain `PIGEON_CLIENT_DIST`, and run `PIGEON_INDEPENDENT_CLIENT=true npm run test:calls`. The fixture creates two private-network application nodes and separate TURN servers, selects their HTTPS API endpoints from the independent static client, registers identities, and checks bidirectional browser audio in direct and community calls. Its temporary network, volumes and containers are removed after the run. Locally built backend image IDs are accepted for development, but published-release evidence must name the registry digest. This local topology does not establish behavior behind an external NAT.
