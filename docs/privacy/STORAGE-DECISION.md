# Storage decision and measured requirements

The decision is to keep **Level on the backend** and use **encrypted IndexedDB
on the client**, with a new delivery protocol. MongoDB is not a default runtime
requirement. OrbitDB is not retained as the private relationship store.

## Requirements before engine choice

The new backend needs opaque mailbox-key lookups, ordered bounded pages,
idempotent insertion, atomic envelope/outbox updates, expiry indexes and bounded
selected replication. It does not need joins over identities, a global message
history or server-side private search. The client owns those private views.

The initial planning workload is 10,000 envelopes, 100 mailboxes, 4 KiB of random
ciphertext per envelope, 100-row durable batches, 1,000 point reads, 100 pages of
50 rows and deletion of 1,000 expired rows. It is synthetic, not telemetry about
actual users. Local acceptance budgets are p95 <= 250 ms per write batch,
<= 100 ms per point/page read and <= 1 second for the expiry batch. These budgets
reserve room for encryption, networking and replication; they do not establish
end-to-end service capacity.

## Reproducible result

[Raw measurement](evidence/storage-benchmark.json) was taken on an Apple M5,
macOS arm64, Node 24.18.0, Level 10.0.0 and MongoDB 8.0.29 (driver 6.20.0).
MongoDB ran in Docker over loopback with a 768 MiB limit. Level ran directly on
macOS. This is one run without warmup; differences include the container and
protocol overhead, so the numbers must not be presented as a general ranking.

| Operation | Level | MongoDB |
| --- | ---: | ---: |
| 100-row write batch p95 | 3.01 ms | 6.65 ms |
| Point read p95 | 0.018 ms | 0.482 ms |
| 50-row page p95 | 0.719 ms | 3.085 ms |
| Explicit expiry delete, 1,000 rows (one sample) | 2.24 ms | 10.37 ms |
| Recorded storage before expiry | 58,399,888 file bytes | 53,739,520 collection bytes + 307,200 index bytes |

Both satisfy this bounded local workload. The script verifies exact point-read
contents, page counts, counts after deletion and a Level close/reopen. Writes
use Level `sync: true` and MongoDB `w: 1, j: true`. This does not test sudden power
loss, MongoDB restart, multi-node durability, concurrent load, browser IndexedDB
performance or physical erasure. The different storage byte counters are not
identical accounting measures; MongoDB journal/service overhead is excluded.

The [benchmark directory](../../benchmarks/private-storage/README.md) contains
pinned dependencies and reproduction commands. No credentials or real message
contents are used. The script removes only its generated temporary directory
and randomly named benchmark database.

## Engine comparison

| Option | Fit | Decision |
| --- | --- | --- |
| Level | Already deployed; atomic batches can keep envelope and outbox together; ordered keys support mailbox and expiry scans; one writer owns each database directory | Keep for node queues. Application code must implement expiry read gates, quotas, crash recovery and explicit replica acknowledgement. Encrypting client history is a separate layer. |
| MongoDB | Useful operational tooling, indexes and replication options; still requires a server, resource management and the same minimized document/transport model | Do not migrate now. Reconsider only after the selected-queue workload exceeds measured single-writer capacity or operations require a managed database. A future adapter must pass identical privacy and failure contracts. |
| Current OrbitDB | Real multi-node replication works, including late joins; current stores distribute private metadata to every member of a private network | Remove it from new private scopes. Keep only deliberately public data during transition; public write authorization still needs validation. |
| Browser IndexedDB | Local, asynchronous persistence without a new service | Store authenticated encrypted records and indexes. Add device-specific performance, eviction and recovery tests in UI #172; this benchmark does not measure it. |

The backend's real transport acceptance opens and replicates all 17 OrbitDB
store families, and its relay matrix successfully exchanges fresh documents
after partitions/restart. Those are functional measurements, not an equivalent
10,000-envelope performance comparison. The reason to stop private global
replication is its readership and copy lifecycle, even if it were faster.
See [backend relay acceptance](https://github.com/haskou/pigeon-swarm-node/pull/297)
and the [source inventory](DATA-INVENTORY.md).

Level's synchronous write option and atomic-batch behavior are documented by
[ClassicLevel](https://github.com/Level/classic-level#database-methods).
MongoDB's [TTL monitor](https://www.mongodb.com/docs/manual/core/index-ttl/)
does not guarantee immediate deletion at expiry. Consequently both adapters
must reject expired reads themselves; a sweeper is maintenance, not an access
control boundary. Deleting a row also cannot prove removal from operator
snapshots, journals or previously distributed copies.

## Conditions for reconsideration

Measure the same workload with concurrent clients, the chosen encrypted wire
format and two actual replicas before release. Include quota saturation,
restarts during writes/acks, network partitions and replay after tombstones.
Reconsider MongoDB if those measurements miss the service budget and an adapter
prototype demonstrably improves it within the deployment budget. Do not change
engines to retain the same global private graph in a different database.
