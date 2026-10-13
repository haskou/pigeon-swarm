// Drops libp2p connections for the relay fault controller and returns how many
// were dropped.
const dropConnections = async (connections) => {
  await Promise.all(connections.map((connection) => connection.close()));
  return connections.length;
};

module.exports = { dropConnections };
