import assert from "node:assert/strict";
import test from "node:test";
import { dropConnections } from "./relay-connection-drop.cjs";

const fakeConnection = (close) => {
  const connection = {
    abortedWith: undefined,
    close,
    abort(error) {
      connection.abortedWith = error;
    },
  };
  return connection;
};

test("closes every link gracefully when it can", async () => {
  const connections = [
    fakeConnection(async () => {}),
    fakeConnection(async () => {}),
  ];

  assert.equal(await dropConnections(connections), 2);
  assert.deepEqual(
    connections.map((connection) => connection.abortedWith),
    [undefined, undefined],
  );
});

// libp2p 3 gives a graceful close one second; a stream still waiting for send
// window makes it reject and leaves the link open.
test("aborts a link whose graceful close fails", async () => {
  const timeout = new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
  const closed = fakeConnection(async () => {});
  const stuck = fakeConnection(async () => {
    throw timeout;
  });

  assert.equal(await dropConnections([closed, stuck]), 2);
  assert.equal(closed.abortedWith, undefined);
  assert.equal(stuck.abortedWith, timeout);
});
