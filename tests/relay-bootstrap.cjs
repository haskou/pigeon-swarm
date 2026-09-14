const { createRequire } = require("node:module");
const requireApp = createRequire("/app/package.json");
requireApp("reflect-metadata");
const { heliaRuntimeAdapter } = requireApp(
  "./dist/contexts/shared/infrastructure/ipfs/helia/adapters/HeliaRuntimeAdapter",
);

async function main() {
  const config = await heliaRuntimeAdapter.getLibp2pDefaults({
    distributedHashTableServerEnabled: true,
    localPeerDiscoveryEnabled: false,
    publicBootstrap: false,
  });
  const address = `/ip4/${process.env.TEST_BOOTSTRAP_IP}/tcp/4200`;
  config.addresses = { listen: [address], announce: [address] };
  config.peerDiscovery = [];
  const node = await heliaRuntimeAdapter.createLibp2p(config);
  console.log(JSON.stringify({ addresses: [`${address}/p2p/${node.peerId}`] }));
  process.once("SIGTERM", async () => {
    await node.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
