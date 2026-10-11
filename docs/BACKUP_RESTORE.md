# Backup and Restore

This document describes how to copy a stopped node's data, restore it, and the
limits of that procedure. The two-node run (M10, non-NAT) and the helper's unit
tests (M17) in [RELEASE_VERIFICATION.md](RELEASE_VERIFICATION.md) check it.

## What To Copy

The default Compose file stores node state in two host folders:

| Folder | Variable | Contents |
| --- | --- | --- |
| `ipfs_storage` | `IPFS_STORAGE_HOST_PATH` | IPFS data. |
| `local_storage` | `LOCAL_STORAGE_HOST_PATH` | Embedded node-local database and `turn-shared-secret`. |

The `turn_runtime` volume (`/run/pigeon`) is derived at startup from the stored
secret and does not need copying. Logs are not part of a backup.

`.env` is not in either folder. It can hold an explicit `CALLS_TURN_SHARED_SECRET`
and push keys (`PUSH_VAPID_PRIVATE_KEY`). Back it up separately, with mode `600`.

Use the values of `IPFS_STORAGE_HOST_PATH` and `LOCAL_STORAGE_HOST_PATH` in
place of `./ipfs_storage` and `./local_storage` if you set them.

## Backup

Stop the node first. Copies taken while it runs are not supported.

```sh
(
  set -eu
  umask 077
  backup="$HOME/pigeon-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$HOME/pigeon-backups"
  mkdir -m 700 "$backup"
  mkdir -m 700 "$backup/ipfs_storage" "$backup/local_storage"
  docker compose stop app
  sudo ./scripts/restore-copy.sh ./ipfs_storage "$backup/ipfs_storage"
  sudo ./scripts/restore-copy.sh ./local_storage "$backup/local_storage"
  install -m 600 .env "$backup/.env"
  docker compose up -d app
)
```

`scripts/restore-copy.sh <source> <target>` copies a directory into an existing
empty target and then compares the two. It prints the names of differing files,
never their contents. Run it as root to keep the original owners. Without root
the copy belongs to the operator, and the entrypoint corrects ownership on start.

The backup folder holds private keys and the TURN secret. Keep it outside the
repository and off shared storage.

## Restore

Restore into a stopped node. Never run the original and a restored copy at the
same time: both would present the same peer ID, keys and TURN secret.

```sh
(
  set -eu
  umask 077
  restore="$HOME/pigeon-backups/<timestamp>"
  docker compose stop app
  mv ./ipfs_storage ./ipfs_storage.before-restore
  mv ./local_storage ./local_storage.before-restore
  mkdir -m 700 ./ipfs_storage ./local_storage
  sudo ./scripts/restore-copy.sh "$restore/ipfs_storage" ./ipfs_storage
  sudo ./scripts/restore-copy.sh "$restore/local_storage" ./local_storage
  docker compose up -d app
)
```

Restore `.env` only if you intend to replace the current one. Compare the two
first. The `.before-restore` folders still hold the previous state. Delete them
when you no longer need them.

## Limits

- **Same node identity.** A restored copy is the same node. It has the same peer
  ID, keys and TURN secret. Running a copy beside the original, or starting two
  copies, is not tested.
- **Copies are secrets.** They contain node data, keys and the TURN secret. Keep
  directories at mode `700` and files at mode `600`. Encrypt off-host copies. The
  canary scan in M10 found no plaintext canary in the stopped volumes. That result
  does not make a copy harmless.
- **Deletion does not reach other copies.** Deleting a backup does not delete
  copies held by others, such as remote replicas, IPFS providers, DHT records, or
  backups made by other operators. Retention of your own backups is your decision.
  The software does not expire them.
- **Only a stopped node is consistent.** The helper does not stop the node. Its
  final comparison catches many changes made during a copy, but it cannot make a
  live copy consistent.
- **Failed copies are partial.** The helper refuses a non-empty target and exits
  non-zero on a mismatch. It does not remove a partial target. Delete the target
  and retry.
- **Same image only.** M10 restores with the pinned image that produced the copy.
  Restoring into a different image version is not tested. Storage migration is
  tracked by [#33](https://github.com/haskou/pigeon-swarm/issues/33).
- **An explicit TURN secret replaces the stored one.** If `.env` sets
  `CALLS_TURN_SHARED_SECRET`, the node writes it over the stored secret on start.
  Restore `.env` with the matching value, or leave the variable empty so the stored
  secret is used.
- **Not tested.** Restore on another host, restore after a relay configuration
  change, and encrypted-at-rest storage. The application does not provide the last
  one.

## Tested Procedure

The non-NAT two-node run (`npm run test:e2e`) does the following after the browser
checks:

1. Stops both nodes.
2. Copies the `ipfs_a` and `local_a` volumes of `app-a` with
   `scripts/restore-copy.sh` into new volumes (`restore-copy` service, profile
   `restore`).
3. Starts `app-restored` from the copies, with an empty
   `CALLS_TURN_SHARED_SECRET`, so the stored secret is used.
4. Checks that `caller-1` keeps its identity, handle and network list, and that the
   restored node keeps its private network peer ID. Checks both after start and
   after restart.
5. Runs the canary scan over the restored volumes and logs, as it does for the
   original nodes.

The helper's behavior is tested by `tests/restore-copy.test.mjs`, which is run by
the "Validate restore copy helper" CI step.
