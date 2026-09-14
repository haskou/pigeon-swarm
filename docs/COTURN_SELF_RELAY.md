# TURN traffic between allocations on the same server

The application image builds coturn 4.11.0 from commit `97fd597fcb64861392b399ac824b044a2f0f5786` and applies `patches/coturn-self-relay.patch`. The patch follows coturn's BSD-3-Clause license; the image retains the upstream license at `/usr/local/share/licenses/coturn/LICENSE`.

## Problem

With a public address advertised for a container behind NAT, coturn translates incoming peer addresses back to its private relay address. The private-destination policy then rejects communication between two allocations on that server. Listening ports, successful authenticated allocations and container health do not establish that audio can pass.

Whitelisting the container address would allow access to unrelated UDP listeners on the same address. The bundled implementation instead permits traffic only to UDP relay sockets that coturn has successfully bound.

## Enforcement

- The permission exception applies only to the server's own mapped relay address and only while TCP relay allocations are disabled. Built-in zero-address, loopback and multicast checks still run first.
- The shared port registry records bound UDP sockets separately from reserved ports. A reservation or a failed bind does not authorize a destination.
- Every UDP relay send checks the exact destination address and port, including Send indications and ChannelData using an existing channel. An IP-only permission cannot authorize an unrelated port.
- The registry lock stays held through the nonblocking send. Closing a relay withdraws its bound state under that lock before closing the socket, preventing a stale check from sending to another service that reuses the port.
- Other private destinations remain subject to the existing restrictions. Explicit exceptions for separate trusted private peers retain their existing behavior.

This removes the need to whitelist the entire container address for communication between its own relay allocations. Public reachability, port forwarding and external-network acceptance remain deployment requirements.

## Validation and maintenance

`npm run test:media` exercises the complete image with a documentation-range public address mapped to its private container interface, without a private-peer whitelist. Two real browsers exchange audio over UDP, TCP and TLS before and after restarting the application.

The same fixture runs `tests/turn-self-relay-probe.mjs` against the bundled binary. It checks retained permissions and channels after a relay port is reused by a different UDP service, an unrelated UDP listener on the container address, concurrent allocation attempts against an occupied relay-range port, other private destinations and rejection of TCP relay allocations.

When updating coturn, recheck the successful-bind, release and UDP-send paths against the patch and rerun these regressions. A clean patch application alone is insufficient validation.
