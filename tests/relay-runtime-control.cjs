const { createRequire } = require("node:module");
const { createServer } = require("node:http");
const requireApp = createRequire("/app/package.json");
requireApp("reflect-metadata");
const { heliaRuntimeAdapter } = requireApp(
  "./dist/contexts/shared/infrastructure/ipfs/helia/adapters/HeliaRuntimeAdapter",
);
const privateNodes = new Set();
const publicNodes = new Set();

for (const [method, nodes] of [
  ["createPrivateHelia", privateNodes],
  ["createRoutingHelia", publicNodes],
]) {
  const original = heliaRuntimeAdapter[method].bind(heliaRuntimeAdapter);
  heliaRuntimeAdapter[method] = async (...args) => {
    const result = await original(...args);
    nodes.add(result.libp2p);
    return result;
  };
}

createServer(async (request, response) => {
  try {
    let closedPrivateConnections;
    if (request.method === "POST" && request.url === "/public/drop") {
      await Promise.all(
        [...publicNodes].flatMap((node) =>
          node.getConnections().map((connection) => connection.close()),
        ),
      );
    } else if (request.method === "POST" && request.url === "/private/drop") {
      const connections = [...privateNodes].flatMap((node) =>
        node.getConnections(),
      );
      closedPrivateConnections = connections.length;
      await Promise.all(connections.map((connection) => connection.close()));
    } else if (request.method !== "GET" || request.url !== "/state") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        closedPrivateConnections,
        private: [...privateNodes].map((node) => ({
          id: node.peerId.toString(),
          status: node.status,
          peers: node.getPeers().map(String),
        })),
        public: [...publicNodes].map((node) => ({
          id: node.peerId.toString(),
          status: node.status,
          pubsubStarted: node.services.pubsub.isStarted(),
          peers: node.getPeers().map(String),
        })),
      }),
    );
  } catch {
    response.writeHead(500).end("Fault control failed");
  }
}).listen(9099, "127.0.0.1");
