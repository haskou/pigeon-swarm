# Application calls across two NAT routers

Run the complete UI workflow against an immutable application image:

```sh
npm ci --ignore-scripts
export PIGEON_TEST_IMAGE="$(docker image inspect ghcr.io/haskou/pigeon-swarm:latest --format '{{.Id}}')"
npm run test:e2e:nat
```

The application image and Playwright dependencies must already be available.
Docker must be running. The suite builds a small Alpine router image with
iptables and iproute2; the first build needs access to their package repositories.
CI runs this suite against the same pinned-source image as the ordinary E2E.

## Topology

```text
Chromium A + app A + TURN A                       Chromium B + app B + TURN B
       10.203.1.10                                      10.203.2.10
            |                                               |
  NAT A: 10.203.1.2                                NAT B: 10.203.2.2
       172.29.203.11 ------- isolated WAN ----------- 172.29.203.12
                                |
                       Playwright controller
```

Each endpoint has a separate network namespace. A small namespace container
sets its default route before the application starts and keeps that route alive
across application restarts. IPv6 and multicast discovery are disabled. The LAN
bridges disable Docker masquerading; the router containers perform SNAT, DNAT
and hairpin translation. Forwarded TURN ports retain their port numbers.

The WAN uses RFC1918 addresses as stand-ins for public addresses, with explicit
fixture-only TURN peer allowlisting, as in the ordinary local E2E. The WAN is an
internal Docker network. Routers forward outgoing traffic only
to that simulated WAN and incoming traffic only through the explicit port
mappings. No host ports or host firewall changes are used. Fixed subnets must
not overlap another Docker network; an overlap fails setup without modifying
the existing network. Run one NAT fixture at a time.

The controller drives two separate Chromium processes through Playwright's
control channel. Each browser loads the real bundled frontend through a local
HTTPS gateway to its own real backend. Browser HTTP, WebSocket, ICE and media
traffic originate in the endpoint namespace, not in the controller. Microphones
use Chromium's synthetic audio device.

## Assertions

The detached UDP receivers deliberately delay binding for five seconds. The
runner waits for both bind acknowledgements, with a bounded readiness deadline,
before sending any probe. This exercises slow container startup on every run.

Before opening the UI, both directions must pass a network preflight:

- The other node's private HTTP address is unreachable.
- A UDP request through the public address reaches the other node with its
  source translated, and the reply comes from the advertised public address.
- Blocking the relay media range makes the UDP probe fail and increments the
  firewall drop counter; restoring it makes the same probe succeed.

The suite then reuses the application workflow: registration, encrypted direct
messages, direct calls, community membership and messages, community voice,
leave/rejoin, password login, retained history and presence expiry.

In NAT mode the test observes RTCPeerConnection without replacing its ICE
servers, credentials or transport policy. It accepts the successful ICE route
selected by the application, including peer-reflexive candidates. Received audio
packets, bytes, decoded samples and audio energy must increase in both browsers
on the same connected peer, so encrypted packets arriving without decoded audio
cannot pass.
Router counters, reset after the preflight, must show sustained UDP traffic
entering each LAN from the WAN. The original E2E separately enforces relay/relay.

The existing brief injected signalling rejection remains part of the workflow
to verify recovery from participant-replication delays. Subsequent requests
reach the real backend. No SDP, ICE candidates or database records are copied
between clients by test code.

## Limits

This models two home NATs with explicit port forwarding and hairpin support.
It does not prove public Internet reachability, arbitrary CGNAT or symmetric
NAT behavior, blocked-UDP fallback to TCP/TLS, or active-call recovery after
router/TURN failure. The negative network probe runs before calls; it does not
claim active-call recovery. Video, physical microphones/speakers, other browser
engines and the independent static client are outside this fixture.

Containers, networks and volumes belong to a uniquely named disposable project
and are removed on success and failure. Diagnostics report stages and transport
state without application response bodies, SDP or TURN credentials.

## Local verification

On 2026-09-27, the NAT suite passed in 107 seconds on Docker Desktop with image
`sha256:69b49d53c898497e4cf2d0df293d5638325acb63cefaeee264feae44a2c1b6af`.
Both clients decoded approximately 240,000 samples per five-second observation
with increasing audio energy. The routers accepted 2,128 and 2,131 WAN UDP
packets after the preflight counters were reset. The ordinary E2E passed against
the same image in 90 seconds. These are local measurements, not Internet
reachability or timing guarantees.
