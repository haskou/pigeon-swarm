# Private storage benchmark

This isolated tool compares the bounded workload documented in
[the storage decision](../../docs/privacy/STORAGE-DECISION.md). It does not add
MongoDB or these dependencies to the application runtime.

Requirements: Node 24 and Docker. From this directory:

```sh
npm ci --ignore-scripts
docker run --detach --name pigeon-private-storage-benchmark \
  --publish 127.0.0.1:27039:27017 --memory 768m \
  mongo@sha256:02a0cc7939f5ed38f30f9bc714ef5f682d49baf9350c54acf302ce833087fe8a \
  --bind_ip_all --wiredTigerCacheSizeGB 0.25
node benchmark.mjs
docker stop pigeon-private-storage-benchmark
docker rm pigeon-private-storage-benchmark
```

Wait for MongoDB startup before running the script. It uses only loopback port
27039 and a randomly named `pigeon_benchmark_*` database, which it drops in
cleanup. Level data is created in the operating system temporary directory and
removed afterward. The dataset is random bytes, not production data or a crypto
interoperability fixture. JSON output includes versions, workload, exact
conditions, latency samples summarized by percentile and assertion status.

The recorded result is a single successful run. A failed assertion or connection
error exits nonzero. Before emitting `assertions: "PASS"`, it checks both engines
against the documented local budgets: write batch p95 <= 250 ms, point and page
read p95 <= 100 ms, and total expiry batch <= 1,000 ms. Invalid or over-budget
timings exit nonzero without reporting PASS. Run `npm test` to verify these gates,
including over-budget and cleanup-failure cases, without Docker or a database.
Cleanup attempts every resource independently, preserves the original failure
alongside cleanup errors, and removes temporary files even if database cleanup
fails. PASS is printed only after successful cleanup.

Do not interpret one local run as a production percentile,
a storage-engine ranking or a secure-deletion test.
