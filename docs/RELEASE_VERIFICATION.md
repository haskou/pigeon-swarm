# Release verification matrix

This document lists every automated release check, the topology and network
conditions it exercises, what it asserts, and what remains unverified. It maps
the acceptance criteria of [issue #34](https://github.com/haskou/pigeon-swarm/issues/34)
to those checks.

`tests/release-verification.test.mjs` runs in CI (step `Validate release verification matrix`).
It fails when the pins, a referenced repository path, an `npm run test:*`
script, or a test step in `.github/workflows/validate.yml` no longer matches this
document. Update the pins, rows and paths together with the workflow.

Status meanings:

- `Automated`: CI runs the check and asserts the stated result.
- `Partial`: CI runs a check that covers part of the stated scope; gaps are listed.
- `Open`: no check exists.

## Pins

| Component | Revision |
| --- | --- |
| `PIGEON_SWARM_NODE_SHA` | `3c2aaface8c4eee41e2591e51402ec54667953bc` |
| `PIGEON_SWARM_UI_SHA` | `d0e66ec34e01f69fa4686b11fdf41f5a34292ad9` |

Both revisions are commits of the public `haskou/pigeon-swarm-node` and
`haskou/pigeon-swarm-ui` repositories. CI builds the application image from these
revisions with `docker build --target production` and passes its image ID as
`PIGEON_TEST_IMAGE`. Results apply to this image build only.

## Verification matrix

Every CI test step in `validate.yml` appears here exactly once.

| ID | Scenario | Topology | Network conditions | CI step | Expected result | Status |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | TURN secret validation, automatic secret persistence and supervised bundled runtime | Unit and contract tests | None | `Validate TURN secret and Compose contract` | Invalid secrets refused; generated secrets persist across restarts; a failing supervised process stops its siblings | Automated |
| M02 | Independent static client serving | Client server unit tests | None | `Validate independent static client origin` | Explicit resource types; missing scripts are not answered with HTML; traversal and symlink escapes rejected | Automated |
| M03 | TURN authentication and restart against real coturn | coturn in Docker Compose, TLS enabled and disabled | Local Docker network | `Verify TURN authentication and restart against real coturn` | Issuer credentials checked by coturn; restart keeps the persisted secret; a rotated private runtime file is reloaded | Automated |
| M04 | Private-delivery protocol contracts | JSON schemas and fixture vectors | None | `Validate private delivery contracts` | Delivery, acknowledgement and protected-frame schemas validate their fixtures; delivery rejects extra fields; acknowledgements carry only opaque delivery references | Automated |
| M05 | Storage benchmark budgets and cleanup | Benchmark unit tests | None | `Validate storage benchmark budgets and cleanup` | Budget and cleanup logic passes unit tests; the benchmark itself is not run | Automated |
| M06 | Browser probe diagnostic redaction | Probe test against a local HTTP server | None | `Verify browser diagnostic redaction` | The external probe does not print malformed credential response bodies | Automated |
| M07 | Backend-issued TURN credentials and browser audio, before and after application restart | One application with its own coturn; browser probe per transport | Relay-only ICE; UDP, TCP and TLS listeners with a disposable certificate pinned by the probe; application container restarted between cycles | `Verify backend-issued credentials and bidirectional browser audio` | The probe selects a relay candidate pair for each transport and reports inbound audio, before and after the restart | Automated |
| M08 | Relay discovery without private bootstrap addresses, isolation of a cold node, recovery and community convergence | Four public DHT bootstrap containers and three application containers; IPv4 only | Public connections dropped for the isolated node; private links closed repeatedly; application restart | `Verify automatic relay discovery and recovery` | Full private relay mesh forms without manual relay addresses; fresh signalling delivered after each interruption; six concurrent community operations, including a delegation revocation racing a kick, each accepted or rejected as expected and converge on every node | Automated |
| M09 | Moderation and publishing limits | One real node, signed requests | None | `Verify moderation and publishing limits on a real node` | A kick removes the member and is logged; identity publication above the limit returns HTTP 429 with code 429040 | Automated |
| M10 | Application workflows between two independent nodes | Two application containers with separate storage, two coturn services (turn-a, turn-b), two Chromium sessions | Injected 409 participant-replication window of 300 ms; applications restarted one at a time; media restricted to each node's UDP TURN URL | `Verify application workflows between independent nodes` | Invitation acceptance, private messages, community creation and delivery, direct and community calls with inbound audio, leave and rejoin, login cycles, removal after departure and after network loss, and retained messages pass, as listed in [TWO_NODE_CALL_VALIDATION.md](TWO_NODE_CALL_VALIDATION.md). A synthetic plaintext canary is displayed in both browsers and has no raw or base64 copy in either node's stopped data volumes or container logs; a planted control is detected. TURN-entrypoint supervision checks also run. | Partial |
| M11 | Application calls across two NAT routers with a TURN server per node | Two router namespaces on a simulated WAN; Playwright controller | Port-mapped NAT with SNAT, DNAT and hairpin; WAN-to-LAN UDP accepted only from the peer subnet and established flows; relay media range blocked as a preflight negative control | `Verify application calls across two NAT routers` | The workflow of M10 runs across the routers; the UDP preflight succeeds when the media range is open and fails when blocked; inbound audio increases; router counters show UDP from the WAN | Partial |
| M12 | Independent client trust boundary and update rollback | Client built independently; explicitly fake backend fixtures over HTTPS | None | `Verify browser trust boundary and update rollback` | Same-origin update and rollback fixtures stay fresh and the trust boundary holds, against fixtures only; real-node behavior is covered by M13 | Automated |
| M13 | Independent client against real nodes | Client built independently; two application containers | As M10 | `Verify independent client calls against real nodes` | The M10 workflow passes with the independently built client (`PIGEON_INDEPENDENT_CLIENT=true`) | Partial |
| M14 | UI workflows against the real node in the image | Pinned UI Playwright specs against one application origin | Single node; three session specs also run on the mobile-chromium and desktop-firefox projects | `Verify UI flows against the real node in the image` | Listed UI specs pass against the image origin, as described in [UI_E2E_VALIDATION.md](UI_E2E_VALIDATION.md) | Automated |
| M15 | Release matrix drift guard | Repository files only | None | `Validate release verification matrix` | Pins, referenced paths, `npm run test:*` scripts and CI test steps match this document | Automated |

Blocked or unfinished behavior listed in the issue (#29, #32, #33 and their
linked node and UI issues) is not claimed here. Those rows are tracked by the
acceptance mapping and the open items below.

## Acceptance criteria of issue #34

| # | Criterion (abridged) | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Calls across two TURN servers and separate networks, blocked UDP, reconnection and no-direct-connection mode | M11 covers two TURN servers behind separate simulated NATs. M10 restarts applications between phases. Not covered: client UDP blocked during a live call, active-call recovery after a relay restart, no-direct-connection mode ([#32](https://github.com/haskou/pigeon-swarm/issues/32)). Remaining evidence: X2. | Partial |
| 2 | Three nodes with concurrent operations, partitions, restarts and revocations | M08 covers a three-node relay mesh with partitions, restarts, a delegation revocation racing a kick, and six concurrent community operations. Not covered: device or key revocation, attachments, mailbox delivery. | Partial |
| 3 | Removed members or devices receive no new keys after revocation | No check in this matrix. Key evolution and device revocation are outside these tests and are not claimed. | Open |
| 4 | Captures of storage, events, logs, DHT and push do not reveal prohibited fields | Schema contracts (M04), the static [data inventory](privacy/DATA-INVENTORY.md), and M10's canary scan of stopped data volumes and container logs for raw and base64 copies of a synthetic plaintext canary, with a planted control. Not covered: other encodings, encrypted or compressed storage contents, browser storage, DHT, push and traffic captures. | Partial |
| 5 | Retention, backups, restore and migration are tested without promising deletion of copies held by others | No check. Migration is tracked by [#33](https://github.com/haskou/pigeon-swarm/issues/33). | Open |
| 6 | Every failure has redacted evidence and a regression; no guarantee depends only on mocks | Redaction is tested by M06. Integration checks M07–M11 and M14 run real images. M12 uses fixtures and is labelled as such. Regression coverage is per-check, not a general process. | Partial |
| 7 | Specialist review is complete and blocking findings are resolved | Not performed. This matrix does not substitute for it (X3). | Open |
| 8 | Final documentation records residual metadata, assumptions and uncovered scenarios | The sections below. Final sign-off depends on criteria 2–7. | Partial |

## External checks

These require infrastructure or people outside CI. Record the image digest,
transport, network topology and packet-delta results. Omit credentials, SDP and
private addresses.

| ID | Procedure | Reference | Issue |
| --- | --- | --- | --- |
| X1 | TURN reachability over UDP, TCP and TLS from a machine outside the relay LAN | [DOCKER_IMAGE.md, reproducible browser media checks](DOCKER_IMAGE.md#reproducible-browser-media-checks) | [#29](https://github.com/haskou/pigeon-swarm/issues/29) |
| X2 | Cross-network call between devices on different networks, repeated with client UDP blocked, and after a relay restart without reloading the page; audible speech in both directions | [DOCKER_IMAGE.md, reproducible browser media checks](DOCKER_IMAGE.md#reproducible-browser-media-checks) | [#29](https://github.com/haskou/pigeon-swarm/issues/29), [#34](https://github.com/haskou/pigeon-swarm/issues/34) criterion 1 |
| X3 | Independent specialist review of the protocol, authorization, key recovery and privacy limits, with written findings and resolutions | Not in CI | [#34](https://github.com/haskou/pigeon-swarm/issues/34) criterion 7 |

## Residual metadata

From [data inventory](privacy/DATA-INVENTORY.md), which is a code snapshot at
backend `4f43437`. The pinned backend (`3c2aaface`) has not been re-inventoried.

- Replicated document metadata is visible to replica operators even though
  payloads are encrypted. It includes actors, conversation and message
  references, and reaction and reply links.
- The attachment registry links owner, file name, type, size and network. Replica
  claims show which node holds which content.
- Notification recipient indexes and read-marker indexes encode identities.
- Node error logs may include network and store IDs, document and head keys, and
  missing CIDs.
- Public IPFS provider metadata can disclose PeerIDs and offered CIDs.
- Browser storage keeps selected conversations and unread state per identity.
- Operator backups, exports, IPFS blockstores and remote replicas are copies that
  deleting a document does not reach.
- The TURN operator observes client source addresses, allocation timing and byte
  counts. This is a property of the protocol; no test here measures it. [INFERENCE]

## Assumptions

- Identities, messages and files in the tests are synthetic and disposable.
  Cleanup removes only containers and networks created by the run.
- Chromium uses synthetic audio devices. The NAT fixture uses RFC 1918 addresses
  as stand-ins for public ones.
- TLS certificates in fixtures are disposable. Browsers pin only the fixture's
  public key; external runs use normal certificate verification.
- Docker fixtures use internal networks with no published host ports. CI does not
  test public reachability.

## Uncovered scenarios

- Client UDP blocked during a live call. M11 has only a preflight negative control.
- Relay restart during an active call, with recovery and no page reload.
- Real home NAT, CGNAT, mobile networks and public reachability (X1, X2).
- No-direct-connection call mode ([#32](https://github.com/haskou/pigeon-swarm/issues/32)).
- Device or member revocation effects on key material (MLS and UI key work).
- Attachments, push notifications and mailbox delivery.
- Storage migration, backup, restore and retention ([#33](https://github.com/haskou/pigeon-swarm/issues/33)).
- Criterion 4 beyond the M10 canary: other encodings, encrypted or compressed storage contents, browser storage, DHT, push and traffic captures from a nonparticipant.

## Reproduction

The source repositories are public. The Dockerfile needs no token for these pins.

```sh
docker build --target production \
  --build-arg PIGEON_SWARM_NODE_SHA=3c2aaface8c4eee41e2591e51402ec54667953bc \
  --build-arg PIGEON_SWARM_UI_SHA=d0e66ec34e01f69fa4686b11fdf41f5a34292ad9 \
  --iidfile pigeon-test-image.id .
export PIGEON_TEST_IMAGE="$(cat pigeon-test-image.id)"
npm ci --ignore-scripts
npm run test:release
npm run test:privacy
npm run test:media
npm run test:relay
npm run test:moderation
npm run test:e2e
npm run test:e2e:nat
npm run test:ui-e2e
```

The `validate.yml` workflow runs the same checks, plus the TURN, client,
benchmark and browser-probe checks listed in the matrix.
