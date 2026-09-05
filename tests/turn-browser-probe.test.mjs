import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

test('external probe does not print malformed credential response bodies', async () => {
  const marker = 'private-turn-credential-do-not-print';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`{"credential":"${marker}",`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, ['tests/turn-browser-probe.mjs'], {
        env: {
          ...process.env,
          PIGEON_API_URL: `http://127.0.0.1:${server.address().port}/api/`,
          PIGEON_MEDIA_TRANSPORT: 'udp',
        },
        timeout: 10000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.equal(result.error?.code, 1);
    assert.match(result.stderr, /FAIL browser media probe: backend credential issuance/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
