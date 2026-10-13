// Drops libp2p connections for the relay fault controller and returns how many
// were dropped. libp2p 3 gives a graceful close one second and rejects while a
// stream still waits for send window, leaving the link open; such links are
// aborted, as libp2p's connection manager does.
const dropConnection = async (connection) => {
  try {
    await connection.close();
  } catch (error) {
    connection.abort(error instanceof Error ? error : new Error(String(error)));
  }
};

const dropConnections = async (connections) => {
  await Promise.all(connections.map(dropConnection));
  return connections.length;
};

module.exports = { dropConnections };
