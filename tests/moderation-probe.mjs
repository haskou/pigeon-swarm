// Moderation and abuse-limit acceptance against one running node. Every
// assertion is exact: a wrong status, code or log entry fails the run.
//
// MODERATION_TEST_NODE: API base URL (…/api/); MODERATION_TEST_NETWORK_ID: a
// network the node has already joined and finished synchronizing.
import assert from "node:assert/strict";

import {
  HttpError,
  SignedCommunities,
  createActor,
  publishIdentity,
  signedRequest,
} from "./signed-pigeon-client.mjs";

const base = new URL(process.env.MODERATION_TEST_NODE);
const networkId = process.env.MODERATION_TEST_NETWORK_ID;
assert.ok(networkId, "MODERATION_TEST_NETWORK_ID is required");

const request = (actor, method, route, body) =>
  signedRequest(base, actor, method, route, body);
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `Unexpected failure: ${error}`);
    return { status: error.status, body: error.bodyText };
  }
  assert.fail("Request must be rejected");
};
const stage = (label) => console.log(`stage: ${label}`);

const communities = new SignedCommunities(request);
const [owner, kicked, banned] = await Promise.all([
  createActor(),
  createActor(),
  createActor(),
]);
// The network must already be joined and synchronized: a node still starting
// answers 503 or a device authorization conflict, which is not a result here.
stage("publish identities");
for (const [index, actor] of [owner, kicked, banned].entries())
  await publishIdentity(request, actor, [networkId], `Moderation ${index}`);

stage("create community and admit two members");
const community = await communities.create(owner, {
  autoJoinEnabled: true,
  description: "Moderation acceptance",
  discoverable: false,
  name: `Moderation ${Date.now()}`,
  networkId,
  visibility: "private",
});
await communities.joinAutomatically(kicked, community);
await communities.joinAutomatically(banned, community);
const route = `communities/${encodeURIComponent(community.id)}`;
const roster = async () => (await request(owner, "GET", route)).memberIds;
for (const actor of [owner, kicked, banned])
  assert.ok((await roster()).includes(actor.id), "Member must be on the roster");

stage("kick removes the member and is logged");
await communities.kick(owner, community, kicked.id);
assert.ok(!(await roster()).includes(kicked.id), "Kicked member left the roster");
assert.ok((await roster()).includes(banned.id), "Other members stay");
const kickLog = (await communities.moderationLogs(owner, community)).filter(
  (entry) => entry.action === "member_kicked",
);
assert.equal(kickLog.length, 1);
assert.equal(kickLog[0].actorIdentityId, owner.id);
assert.deepEqual(kickLog[0].target, { id: kicked.id, type: "member" });

stage("a non-moderator cannot kick");
const outsider = await rejection(communities.kick(banned, community, owner.id));
assert.equal(outsider.status, 409);
assert.equal(JSON.parse(outsider.body).code, "CommunityPermissionDeniedError");
assert.ok((await roster()).includes(owner.id), "Owner must stay");

stage("ban removes the member, is logged and blocks rejoining");
await communities.ban(owner, community, banned.id, "spam");
assert.ok(!(await roster()).includes(banned.id), "Banned member left");
const banLog = (await communities.moderationLogs(owner, community)).filter(
  (entry) => entry.action === "member_banned",
);
assert.equal(banLog.length, 1);
assert.equal(banLog[0].actorIdentityId, owner.id);
assert.deepEqual(banLog[0].target, { id: banned.id, type: "member" });
assert.equal(banLog[0].details.reason, "spam");
const rejoin = await rejection(communities.joinAutomatically(banned, community));
assert.equal(rejoin.status, 409);
assert.match(rejoin.body, /Identity is banned from this community/);
assert.ok(!(await roster()).includes(banned.id), "Banned must not rejoin");

stage("identity publishing is rate limited per identity");
const limited = await createActor();
const limit = Number(process.env.MODERATION_TEST_PUBLISH_LIMIT ?? 30);
for (let index = 0; index < limit; index++)
  await publishIdentity(request, limited, [networkId], `Limited ${index}`);
const exceeded = await rejection(
  publishIdentity(request, limited, [networkId], "Limited over"),
);
assert.equal(exceeded.status, 429);
assert.equal(JSON.parse(exceeded.body).code, 429040);
// The cap is per identity: another identity still publishes.
await publishIdentity(request, await createActor(), [networkId], "Unaffected");

console.log("PASS moderation");
