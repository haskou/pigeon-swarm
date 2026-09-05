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
error exits nonzero. Do not interpret one local run as a production percentile,
a storage-engine ranking or a secure-deletion test.
