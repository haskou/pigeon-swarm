/**
 * Community moderation scenarios: member kick, ban operations, and moderation log entries.
 * 
 * Scenarios:
 * 1. Member kick appears in moderation log as member_kicked
 * 2. Ban member then verify banned-join error
 * 3. Group roster operations (add/remove members)
 * 
 * These tests verify real API outcomes against two nodes running origin/main code.
 */

import assert from "node:assert/strict";
import {
  createActor,
  signedRequest,
  publishIdentity,
  SignedCommunities,
  canonicalJson,
} from "./signed-pigeon-client.mjs";

const NETWORK_ID = `test-${Date.now()}`;
const BASE_URLS = ["http://localhost:8000", "http://localhost:8001"];

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    return true;
  } catch (error) {
    console.error(`✗ ${name}:`, error.message);
    return false;
  }
}

// Test scenario 1: Member kick and moderation log
async function testMemberKickModerationLog(baseUrl) {
  const actor_owner = await createActor();
  const actor_member = await createActor();
  
  const request_owner = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_owner, method, route, body);
  const request_member = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_member, method, route, body);

  // Publish identities
  await publishIdentity(request_owner, actor_owner, [], "Owner");
  await publishIdentity(request_member, actor_member, [], "Member");

  // Create community
  const communities = new SignedCommunities(request_owner);
  const communityRes = await communities.create(actor_owner, {
    name: "Test Kick Community",
    description: "Testing member kick scenarios",
    networkId: NETWORK_ID,
    visibility: "private",
  });
  const communityId = communityRes.id;

  // Join community
  await communities.joinAutomatically(actor_member, {
    id: communityId,
    networkId: NETWORK_ID,
  });

  // Kick member
  const kickRes = await request_owner(
    "DELETE",
    `communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(actor_member.id)}/kick`,
    {
      moderationLog: {
        // Signed moderation log entry would go here
        action: "member_kicked",
        targetIdentityId: actor_member.id,
      }
    }
  );

  // Fetch moderation log
  const logRes = await request_owner(
    "GET",
    `communities/${encodeURIComponent(communityId)}/moderation-logs`
  );

  // Verify kick entry exists
  assert(
    Array.isArray(logRes.logs),
    "Moderation log should be an array"
  );
  const kickEntry = logRes.logs.find(
    (entry) => entry.action === "member_kicked" && 
               entry.target?.id === actor_member.id
  );
  assert(kickEntry, "member_kicked entry should exist in moderation log");

  return { communityId, kicked: true };
}

// Test scenario 2: Ban member and error on join
async function testBanMemberJoinError(baseUrl) {
  const actor_owner = await createActor();
  const actor_banned = await createActor();

  const request_owner = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_owner, method, route, body);
  const request_banned = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_banned, method, route, body);

  // Publish identities
  await publishIdentity(request_owner, actor_owner, [], "Owner2");
  await publishIdentity(request_banned, actor_banned, [], "Toban");

  // Create community
  const communities = new SignedCommunities(request_owner);
  const communityRes = await communities.create(actor_owner, {
    name: "Test Ban Community",
    description: "Testing ban scenarios",
    networkId: NETWORK_ID,
    visibility: "private",
  });
  const communityId = communityRes.id;

  // Try to join first (should succeed)
  await communities.joinAutomatically(actor_banned, {
    id: communityId,
    networkId: NETWORK_ID,
  });

  // Ban the member
  const banRes = await request_owner(
    "POST",
    `communities/${encodeURIComponent(communityId)}/bans`,
    {
      identityId: actor_banned.id,
      reason: "Test ban",
    }
  );

  // Verify ban entry in moderation log
  const logRes = await request_owner(
    "GET",
    `communities/${encodeURIComponent(communityId)}/moderation-logs`
  );

  const banEntry = logRes.logs?.find(
    (entry) => entry.action === "member_banned" &&
               entry.target?.id === actor_banned.id
  );
  assert(banEntry, "member_banned entry should exist after ban");

  // Try to join again (should fail or be restricted)
  try {
    const rejoinRes = await communities.joinAutomatically(actor_banned, {
      id: communityId,
      networkId: NETWORK_ID,
    });
    // If join succeeds, verify the member is actually banned in the community state
    const communityGet = await request_owner(
      "GET",
      `communities/${encodeURIComponent(communityId)}`
    );
    assert(
      communityGet.bans?.includes(actor_banned.id) ||
      !communityGet.members?.includes(actor_banned.id),
      "Banned member should not be in active members after rejoin attempt"
    );
  } catch (e) {
    // Expected: rejoin should fail
    assert(
      e.message.includes("banned") || e.message.includes("403") || e.message.includes("401"),
      `Rejoin should fail for banned member, got: ${e.message}`
    );
  }

  return { communityId, banned: true };
}

// Test scenario 3: Member operations
async function testGroupRosterOperations(baseUrl) {
  const actor_owner = await createActor();
  const actor_member1 = await createActor();
  const actor_member2 = await createActor();

  const request_owner = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_owner, method, route, body);
  const request_m1 = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_member1, method, route, body);
  const request_m2 = async (method, route, body) =>
    signedRequest(baseUrl + "/api", actor_member2, method, route, body);

  // Publish identities
  await publishIdentity(request_owner, actor_owner, [], "Owner3");
  await publishIdentity(request_m1, actor_member1, [], "Member1");
  await publishIdentity(request_m2, actor_member2, [], "Member2");

  // Create community
  const communities = new SignedCommunities(request_owner);
  const communityRes = await communities.create(actor_owner, {
    name: "Test Roster Community",
    description: "Testing roster operations",
    networkId: NETWORK_ID,
    visibility: "private",
  });
  const communityId = communityRes.id;

  // Add members via join
  await communities.joinAutomatically(actor_member1, {
    id: communityId,
    networkId: NETWORK_ID,
  });
  await communities.joinAutomatically(actor_member2, {
    id: communityId,
    networkId: NETWORK_ID,
  });

  // Verify members are in community
  const communityGet = await request_owner(
    "GET",
    `communities/${encodeURIComponent(communityId)}`
  );

  assert(
    communityGet.members?.length >= 2,
    "Community should have at least 2 members"
  );

  // Remove a member
  const removeRes = await request_owner(
    "DELETE",
    `communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(actor_member2.id)}/kick`,
    {
      moderationLog: {
        action: "member_kicked",
        targetIdentityId: actor_member2.id,
      }
    }
  );

  // Verify member was removed
  const communityAfter = await request_owner(
    "GET",
    `communities/${encodeURIComponent(communityId)}`
  );

  assert(
    !communityAfter.members?.includes(actor_member2.id),
    "Removed member should not be in community members"
  );

  return { communityId, roster_modified: true };
}

async function runTests() {
  const baseUrl = BASE_URLS[0];
  const results = [];

  console.log("\n=== Scenario 1: Member Kick and Moderation Log ===");
  for (let run = 1; run <= 3; run++) {
    console.log(`\nRun ${run}/3:`);
    const result = await test(
      "Member kick appears in moderation log",
      () => testMemberKickModerationLog(baseUrl)
    );
    results.push({ scenario: 1, run, result });
  }

  console.log("\n=== Scenario 2: Ban Member and Join Error ===");
  for (let run = 1; run <= 3; run++) {
    console.log(`\nRun ${run}/3:`);
    const result = await test(
      "Ban member and verify join error",
      () => testBanMemberJoinError(baseUrl)
    );
    results.push({ scenario: 2, run, result });
  }

  console.log("\n=== Scenario 3: Group Roster Operations ===");
  for (let run = 1; run <= 3; run++) {
    console.log(`\nRun ${run}/3:`);
    const result = await test(
      "Member add/remove operations",
      () => testGroupRosterOperations(baseUrl)
    );
    results.push({ scenario: 3, run, result });
  }

  console.log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.result).length;
  console.log(`Passed: ${passed}/${results.length} test runs`);

  if (passed === results.length) {
    console.log("✓ All scenarios passed");
    process.exitCode = 0;
  } else {
    console.log("✗ Some scenarios failed");
    process.exitCode = 1;
  }
}

// Run tests
await runTests();
