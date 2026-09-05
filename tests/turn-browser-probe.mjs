// Actual backend credentials and browser RTP. SDP stays inside this process.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chromium } from 'playwright';

const api = new URL(process.env.PIGEON_API_URL || 'http://127.0.0.1:8080/api/');
if (!api.pathname.endsWith('/')) api.pathname += '/';
const mode = process.env.PIGEON_MEDIA_TRANSPORT || 'udp';
assert.ok(['udp', 'tcp', 'tls'].includes(mode), 'Choose udp, tcp or tls');

async function configuration() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const endpoint = new URL('calls/ice-servers', api);
  const timestamp = Date.now();
  const payload = JSON.stringify({ bodyHash: createHash('sha256').update('{}').digest('hex'), method: 'GET', path: endpoint.pathname, timestamp });
  const response = await fetch(endpoint, {
    headers: {
      'x-identity-id': publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      'x-timestamp': String(timestamp),
      'x-signature': sign(null, Buffer.from(payload), privateKey).toString('base64'),
    },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, 'Backend credential endpoint must accept the signed request');
  const config = await response.json();
  const iceServers = config.iceServers.flatMap(server => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url =>
      mode === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') &&
        (mode === 'tcp' ? url.includes('transport=tcp') : !url.includes('transport=tcp')));
    return urls.length ? [{ ...server, urls }] : [];
  });
  assert.ok(iceServers.length > 0, 'Backend must advertise the requested TURN transport');
  assert.ok(iceServers.every(server => server.username && server.credential), 'Issuer must supply authenticated TURN credentials');
  return { iceServers, iceTransportPolicy: 'relay' };
}

const args = ['--autoplay-policy=no-user-gesture-required'];
// Only the isolated fixture uses a disposable certificate pinned to this SPKI.
// External runs leave these unset and use Chromium's normal trust/DNS policy.
if (process.env.PIGEON_TEST_TLS_SPKI) args.push(`--ignore-certificate-errors-spki-list=${process.env.PIGEON_TEST_TLS_SPKI}`);
if (process.env.PIGEON_TEST_RELAY_IP) args.push(`--host-resolver-rules=MAP relay.test ${process.env.PIGEON_TEST_RELAY_IP}`);
const browser = await chromium.launch({ headless: true, args });
try {
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of pages) {
    const config = await configuration();
    await page.evaluate(async config => {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      tone.frequency.value = 440;
      tone.connect(destination);
      tone.start();
      await audio.resume();
      const peer = new RTCPeerConnection(config);
      peer.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
      window.mediaProbe = { peer, audio, tone };
    }, config);
  }
  const localDescription = async (page, type) => page.evaluate(async type => {
    const { peer } = window.mediaProbe;
    await peer.setLocalDescription(await (type === 'offer' ? peer.createOffer() : peer.createAnswer()));
    if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TURN candidate gathering timed out')), 20000);
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      };
    });
    return peer.localDescription.toJSON();
  }, type);
  const offer = await localDescription(pages[0], 'offer');
  await pages[1].evaluate(description => window.mediaProbe.peer.setRemoteDescription(description), offer);
  const answer = await localDescription(pages[1], 'answer');
  await pages[0].evaluate(description => window.mediaProbe.peer.setRemoteDescription(description), answer);

  const sample = async page => page.evaluate(async () => {
    const stats = await window.mediaProbe.peer.getStats();
    const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
    const pair = transport && stats.get(transport.selectedCandidatePairId);
    const inbound = [...stats.values()].find(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio');
    return {
      local: pair && stats.get(pair.localCandidateId)?.candidateType,
      remote: pair && stats.get(pair.remoteCandidateId)?.candidateType,
      bytes: inbound?.bytesReceived || 0,
      packets: inbound?.packetsReceived || 0,
    };
  });
  for (const page of pages) await page.waitForFunction(() => window.mediaProbe.peer.connectionState === 'connected', null, { timeout: 20000 });
  const first = await Promise.all(pages.map(sample));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const second = await Promise.all(pages.map(sample));
  for (let index = 0; index < 2; index += 1) {
    assert.equal(second[index].local, 'relay', 'Local selected candidate must be relay');
    assert.equal(second[index].remote, 'relay', 'Remote selected candidate must be relay');
    assert.ok(second[index].bytes > first[index].bytes, 'Inbound audio bytes must increase in both browsers');
    assert.ok(second[index].packets > first[index].packets, 'Inbound audio packets must increase in both browsers');
  }
  console.log(`PASS ${mode}: backend-issued credentials; relay/relay in both browsers; inbound audio packet deltas ${second.map((entry, index) => entry.packets - first[index].packets).join('/')}.`);
} finally {
  await browser.close();
}
