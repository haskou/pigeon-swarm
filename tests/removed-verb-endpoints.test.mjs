import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The node serves resources and methods only. A probe or document that still
// names a removed verb-style path would reach an unrelated resource route, or
// teach operators an endpoint that no longer exists.
const removed = [
  ['POST /communities/{id}/channels/text', /\/channels\/text\b/],
  ['POST /communities/{id}/channels/voice', /\/channels\/voice\b/],
  ['DELETE /communities/{id}/members/{identityId}/kick', /\/kick(?![-\w])/],
  ['GET /communities/discover', /\/communities\/discover\b/],
  ['POST /polls/{pollId}/close', /\/polls\/.*\/close\b/],
  ['POST /calls/{id}/participants/me/heartbeat', /\/participants\/me\/heartbeat/],
  ['GET /calls/history', /\/calls\/history\b/],
  ['GET /calls/ice-servers', /\/calls\/ice-servers\b|['"`]calls\/ice-servers/],
  ['POST /stickers/packs/{p}/stickers/{s}/used', /\/stickers\/.*\/used\b/],
  ['POST /node/networks/public', /\/node\/networks\/public\b/],
  ['POST /ipfs/public', /\/ipfs\/public\b/],
];
const self = 'tests/removed-verb-endpoints.test.mjs';
const files = execFileSync('git', ['ls-files', '-z', '--', 'tests', 'docs', 'scripts', 'client', 'site', 'README.md'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && file !== self && /\.(mjs|cjs|js|ts|tsx|md|html|ya?ml|json|sh)$/.test(file));

for (const [operation, pattern] of removed) {
  test(`no file names the removed ${operation}`, () => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, []);
  });
}
