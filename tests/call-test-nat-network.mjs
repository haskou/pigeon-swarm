import assert from "node:assert/strict";

export async function prepareNatNetwork(compose) {
  for (const name of ["a", "b"]) {
    await compose("exec", "-d", `app-${name}`, "node", "--input-type=module", "-e", `
      import dgram from 'node:dgram';
      import {writeFileSync} from 'node:fs';
      const socket = dgram.createSocket('udp4');
      socket.on('message', (data, peer) => socket.send(JSON.stringify({token:data.toString(), address:peer.address}), peer.port, peer.address));
      socket.bind(4133, '0.0.0.0', () => writeFileSync('/tmp/nat-probe.pid', String(process.pid)));
      setTimeout(() => socket.close(), 60000);
    `);
  }
  try {
    for (const [index, name] of ["a", "b"].entries()) {
      const remote = index === 0 ? "b" : "a";
      const publicIp = index === 0 ? "172.29.203.12" : "172.29.203.11";
      const sourceIp = index === 0 ? "172.29.203.11" : "172.29.203.12";
      const privateIp = index === 0 ? "10.203.2.10" : "10.203.1.10";
      // Bound and destroy each socket, including when the firewall silently drops SYNs.
      await compose("exec", "-T", `app-${name}`, "node", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {connect} from 'node:net';
        const reachable = host => new Promise(resolve => {
          const socket = connect(8080, host);
          const finish = result => {clearTimeout(timer); socket.destroy(); resolve(result);};
          const timer = setTimeout(() => finish(false), 1500);
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
        });
        assert.equal(await reachable('127.0.0.1'), true, 'Own backend must be reachable');
        assert.equal(await reachable('${privateIp}'), false, 'Remote private address must be unreachable');
      `);
      const probe = (blocked) => compose("exec", "-T", `app-${name}`, "node", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import dgram from 'node:dgram';
        import {randomUUID} from 'node:crypto';
        const token = randomUUID();
        const socket = dgram.createSocket('udp4');
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(null), 1500);
          socket.on('error', reject);
          socket.on('message', (data, peer) => {clearTimeout(timer); resolve({body:JSON.parse(data), peer});});
          socket.send(token, 4133, '${publicIp}');
        }).finally(() => socket.close());
        ${blocked ? "assert.equal(result, null, 'Blocked relay media must not bypass the NAT firewall');" : `
        assert.ok(result, 'Forwarded UDP media must traverse both routers');
        assert.equal(result.body.token, token);
        assert.equal(result.body.address, '${sourceIp}', 'Destination must see the translated source');
        assert.equal(result.peer.address, '${publicIp}', 'Reply must originate from the advertised public address');`}
      `);
      await probe(false);
      await compose("exec", "-T", `router-${remote}`, "iptables", "-A", "CALL_MEDIA", "-j", "DROP");
      try {
        await probe(true);
        const counters = await compose("exec", "-T", `router-${remote}`, "iptables", "-nvxL", "CALL_MEDIA");
        assert.match(counters, /\n\s*[1-9]\d*\s+\d+\s+DROP\s/, "Negative control must hit the media drop rule");
      } finally {
        await compose("exec", "-T", `router-${remote}`, "iptables", "-D", "CALL_MEDIA", "-j", "DROP");
      }
      await probe(false);
    }
    console.log("PASS NAT isolation: private addresses blocked, bidirectional SNAT/DNAT verified, blocked UDP fails and restored UDP succeeds");
  } finally {
    for (const name of ["a", "b"])
      await compose("exec", "-T", `app-${name}`, "node", "-e", "process.kill(Number(require('node:fs').readFileSync('/tmp/nat-probe.pid', 'utf8')))");
  }
  for (const name of ["a", "b"])
    await compose("exec", "-T", `router-${name}`, "iptables", "-Z", "FORWARD");
}

export async function verifyNatTraffic(compose) {
  for (const name of ["a", "b"]) {
    const counters = await compose("exec", "-T", `router-${name}`, "iptables", "-nvxL", "FORWARD");
    const packets = Number(counters.match(/\n\s*(\d+)\s+\d+\s+CALL_WAN_UDP\s/)?.[1]);
    assert.ok(packets > 100, `Router ${name} must forward sustained WAN UDP traffic, got ${packets} packets`);
    console.log(`PASS router ${name}: ${packets} accepted WAN UDP packets after preflight`);
  }
}
