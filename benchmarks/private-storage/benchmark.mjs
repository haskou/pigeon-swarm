import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Level } from 'level';
import { MongoClient } from 'mongodb';
import { assertWithinBudgets } from './budgets.mjs';

const count = 10_000;
const batchSize = 100;
const payloadBytes = 4096;
const mailboxCount = 100;
const root = await mkdtemp(join(tmpdir(), 'pigeon-private-storage-'));
const databaseName = `pigeon_benchmark_${randomUUID().replaceAll('-', '')}`;
const mongo = new MongoClient('mongodb://127.0.0.1:27039', {
  serverSelectionTimeoutMS: 5000,
});
const boxes = Array.from({ length: mailboxCount }, () =>
  randomBytes(32).toString('base64url'),
);
const rows = Array.from({ length: count }, (_, index) => ({
  version: 1,
  mailboxId: boxes[index % mailboxCount],
  deliveryId: randomBytes(16).toString('base64url'),
  sequence: Math.floor(index / mailboxCount),
  expiresAt: 2_000_000_000 + index,
  bucketBytes: payloadBytes,
  ciphertext: randomBytes(payloadBytes).toString('base64'),
}));
const key = (row) =>
  `${row.mailboxId}!${String(row.sequence).padStart(10, '0')}`;
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
async function measured(fn, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await fn(index);
    samples.push(performance.now() - started);
  }
  return {
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    totalMs: samples.reduce((a, b) => a + b, 0),
  };
}
async function diskBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    bytes += entry.isDirectory()
      ? await diskBytes(filename)
      : (await stat(filename)).size;
  }
  return bytes;
}
let level;
try {
  await mongo.connect();
  const database = mongo.db(databaseName);
  const collection = database.collection('envelopes');
  await collection.createIndex({ mailboxId: 1, sequence: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 });
  level = new Level(join(root, 'level'), { valueEncoding: 'json' });
  const levelWrite = await measured(async (batch) => {
    await level.batch(
      rows.slice(batch * batchSize, (batch + 1) * batchSize).flatMap((row) => [
        { type: 'put', key: `envelope!${key(row)}`, value: row },
        {
          type: 'put',
          key: `expiry!${row.expiresAt}!${key(row)}`,
          value: key(row),
        },
      ]),
      { sync: true },
    );
  }, count / batchSize);
  const mongoWrite = await measured(async (batch) => {
    await collection.insertMany(
      rows
        .slice(batch * batchSize, (batch + 1) * batchSize)
        .map((row) => ({ ...row })),
      { writeConcern: { w: 1, j: true } },
    );
  }, count / batchSize);
  const levelRead = await measured(async (index) => {
    const row = rows[(index * 7919) % count];
    assert.deepEqual(await level.get(`envelope!${key(row)}`), row);
  }, 1000);
  const mongoRead = await measured(async (index) => {
    const row = rows[(index * 7919) % count];
    assert.deepEqual(
      await collection.findOne(
        { mailboxId: row.mailboxId, sequence: row.sequence },
        { projection: { _id: 0 } },
      ),
      row,
    );
  }, 1000);
  const levelPage = await measured(async (index) => {
    const prefix = `envelope!${boxes[index % mailboxCount]}!`;
    assert.equal(
      (await level.iterator({ gte: prefix, lt: `${prefix}~`, limit: 50 }).all())
        .length,
      50,
    );
  }, 100);
  const mongoPage = await measured(async (index) => {
    assert.equal(
      (
        await collection
          .find({ mailboxId: boxes[index % mailboxCount] })
          .sort({ sequence: 1 })
          .limit(50)
          .toArray()
      ).length,
      50,
    );
  }, 100);
  await level.close();
  const levelDisk = await diskBytes(join(root, 'level'));
  level = new Level(join(root, 'level'), { valueEncoding: 'json' });
  assert.deepEqual(await level.get(`envelope!${key(rows[0])}`), rows[0]);
  assert.equal(await collection.countDocuments(), count);
  const mongoStats = await database.command({ collStats: 'envelopes' });
  const cutoff = rows[999].expiresAt;
  const levelExpiry = await measured(async () => {
    const entries = await level
      .iterator({ gte: 'expiry!', lt: `expiry!${cutoff + 1}!` })
      .all();
    assert.equal(entries.length, 1000);
    await level.batch(
      entries.flatMap(([indexKey, envelopeKey]) => [
        { type: 'del', key: indexKey },
        { type: 'del', key: `envelope!${envelopeKey}` },
      ]),
      { sync: true },
    );
  }, 1);
  const mongoExpiry = await measured(async () => {
    assert.equal(
      (
        await collection.deleteMany(
          { expiresAt: { $lte: cutoff } },
          { writeConcern: { w: 1, j: true } },
        )
      ).deletedCount,
      1000,
    );
  }, 1);
  assert.equal(
    (await level.iterator({ gte: 'envelope!', lt: 'envelope!~' }).all()).length,
    count - 1000,
  );
  assert.equal(await collection.countDocuments(), count - 1000);
  assertWithinBudgets({
    level: {
      writes: levelWrite,
      reads: levelRead,
      pages: levelPage,
      expiry: levelExpiry,
    },
    mongodb: {
      writes: mongoWrite,
      reads: mongoRead,
      pages: mongoPage,
      expiry: mongoExpiry,
    },
  });
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0].model,
          mongoVersion: (await database.admin().serverInfo()).version,
          levelVersion: '10.0.0',
          mongoDriverVersion: '6.20.0',
        },
        workload: {
          count,
          batchSize,
          payloadBytes,
          mailboxCount,
          pointReads: 1000,
          pages: 100,
          pageSize: 50,
          expiredRows: 1000,
        },
        conditions: [
          'Synthetic random ciphertext; no real user data',
          `Level runs on ${platform()}; MongoDB runs in Docker over loopback with 768 MiB limit`,
          'Level sync writes and MongoDB w:1,j:true; neither test proves power-loss durability or replicated acknowledgement',
          'Expiry is an explicit indexed delete, not the MongoDB TTL monitor',
          'Single run, no warmup; does not establish production p95 or a cross-engine winner',
        ],
        level: {
          writes: levelWrite,
          reads: levelRead,
          pages: levelPage,
          expiry: levelExpiry,
          diskBytesBeforeExpiry: levelDisk,
        },
        mongodb: {
          writes: mongoWrite,
          reads: mongoRead,
          pages: mongoPage,
          expiry: mongoExpiry,
          storageBytesBeforeExpiry: mongoStats.storageSize,
          indexBytesBeforeExpiry: mongoStats.totalIndexSize,
        },
        assertions: 'PASS',
      },
      null,
      2,
    ),
  );
} finally {
  await level?.close();
  try {
    await mongo.db(databaseName).dropDatabase();
  } finally {
    await mongo.close();
  }
  await rm(root, { recursive: true, force: true });
}
