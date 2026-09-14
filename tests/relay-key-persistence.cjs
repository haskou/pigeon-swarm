const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const originalWriteFile = fsp.writeFile;
const originalLink = fsp.link;
const previousStoragePath = process.env.IPFS_STORAGE_PATH;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-key-probe-"));
const finalPath = path.join(storage, "shared-peer-private-key.pb");
const stateKey = "__pigeonSwarmIPFSNetworkRegistryState";
let stage = "load compiled backend";
let failed = false;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function restore() {
  fsp.writeFile = originalWriteFile;
  fsp.link = originalLink;
  delete globalThis[stateKey];
  if (previousStoragePath === undefined) delete process.env.IPFS_STORAGE_PATH;
  else process.env.IPFS_STORAGE_PATH = previousStoragePath;
}

const watchdog = setTimeout(() => {
  restore();
  fs.rmSync(storage, { recursive: true, force: true });
  console.error("FAIL relay key persistence: 30-second deadline exceeded");
  process.exit(1);
}, 30000);

async function rejectsWithCode(operation, code) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  check(caught?.code === code, `Expected ${code} rejection`);
}

async function onlyFinalFile() {
  const entries = await fsp.readdir(storage);
  check(
    entries.length === 1 && entries[0] === path.basename(finalPath),
    "Unexpected files or orphan staging directories",
  );
  const metadata = await fsp.stat(finalPath);
  check(
    metadata.isFile() && (metadata.mode & 0o777) === 0o600,
    "Final key must be a regular file with mode 0600",
  );
}

(async () => {
  try {
    process.env.IPFS_STORAGE_PATH = storage;
    const appRequire = createRequire("/app/package.json");
    appRequire("reflect-metadata");
    const Registry = appRequire(
      "/app/dist/contexts/shared/infrastructure/ipfs/networks/IPFSNetworkRegistry",
    ).default;
    const { libp2pKeyAdapter: adapter } = appRequire(
      "/app/dist/contexts/shared/infrastructure/ipfs/networks/adapters/Libp2pKeyAdapter",
    );
    const registry = () => new Registry(undefined);
    delete globalThis[stateKey];

    stage = "partial ENOSPC write must not publish a final key";
    let partialWrites = 0;
    fsp.writeFile = async (filename, data, options) => {
      check(
        typeof filename === "string" && filename.startsWith(storage + path.sep),
        "Write interception escaped owned test storage",
      );
      check(
        ArrayBuffer.isView(data) && data.byteLength > 1,
        "Expected serialized key bytes",
      );
      partialWrites++;
      await originalWriteFile.call(
        fsp,
        filename,
        Buffer.from(data.buffer, data.byteOffset, 1),
        options,
      );
      throw Object.assign(new Error("Injected partial write failure"), {
        code: "ENOSPC",
      });
    };
    try {
      await rejectsWithCode(
        () => registry().getSharedPeerPrivateKey(),
        "ENOSPC",
      );
    } finally {
      fsp.writeFile = originalWriteFile;
    }
    check(
      partialWrites === 1,
      "Partial write injection was not exercised exactly once",
    );
    await rejectsWithCode(() => fsp.lstat(finalPath), "ENOENT");
    check(
      (await fsp.readdir(storage)).length === 0,
      "Failed key creation left an orphan staging directory",
    );

    stage = "concurrent retry must persist exactly one shared identity";
    const keys = await Promise.all(
      Array.from({ length: 12 }, () => registry().getSharedPeerPrivateKey()),
    );
    const ids = keys.map((key) => adapter.peerIdFromPrivateKey(key));
    check(
      new Set(ids).size === 1,
      "Concurrent callers received different identities",
    );
    const persisted = await adapter.privateKeyFromProtobuf(
      await fsp.readFile(finalPath),
    );
    check(
      adapter.peerIdFromPrivateKey(persisted) === ids[0],
      "Returned identity differs from persisted identity",
    );
    await onlyFinalFile();
    delete globalThis[stateKey];
    check(
      adapter.peerIdFromPrivateKey(
        await registry().getSharedPeerPrivateKey(),
      ) === ids[0],
      "Reload changed the persisted identity",
    );

    stage = "exclusive publication must preserve a competing final key";
    delete globalThis[stateKey];
    await fsp.unlink(finalPath);
    const winner = await adapter.generateEd25519KeyPair();
    const winnerBytes = await adapter.privateKeyToProtobuf(winner);
    let racedLinks = 0;
    fsp.link = async (source, destination) => {
      check(
        typeof source === "string" &&
          source.startsWith(storage + path.sep) &&
          destination === finalPath,
        "Link interception escaped owned test storage",
      );
      racedLinks++;
      await originalWriteFile.call(fsp, finalPath, winnerBytes, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      return originalLink.call(fsp, source, destination);
    };
    try {
      await rejectsWithCode(
        () => registry().getSharedPeerPrivateKey(),
        "EEXIST",
      );
    } finally {
      fsp.link = originalLink;
    }
    check(
      racedLinks === 1,
      "Exclusive-link race was not exercised exactly once",
    );
    check(
      (await fsp.readFile(finalPath)).equals(Buffer.from(winnerBytes)),
      "Exclusive publication overwrote the competing identity",
    );
    check(
      adapter.peerIdFromPrivateKey(
        await registry().getSharedPeerPrivateKey(),
      ) === adapter.peerIdFromPrivateKey(winner),
      "Retry did not load the competing persisted identity",
    );
    await onlyFinalFile();
  } catch {
    failed = true;
    console.error(`FAIL relay key persistence during ${stage}`);
  } finally {
    restore();
    try {
      await fsp.rm(storage, { recursive: true, force: true });
    } catch {
      failed = true;
      console.error(
        "FAIL relay key persistence: owned temporary storage cleanup failed",
      );
    }
    clearTimeout(watchdog);
  }
  if (failed) process.exitCode = 1;
  else
    console.log(
      "PASS relay key persistence: partial-write cleanup, 12 concurrent callers, persisted reload, mode 0600 and exclusive publication race",
    );
})().catch(() => {
  restore();
  fs.rmSync(storage, { recursive: true, force: true });
  clearTimeout(watchdog);
  console.error("FAIL relay key persistence: unexpected probe failure");
  process.exitCode = 1;
});
