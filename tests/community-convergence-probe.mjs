import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  HttpError,
  SignedCommunities,
  createActor,
  publishIdentity,
  signedRequest,
} from "./signed-pigeon-client.mjs";

// Runs inside a node container. Drives one community through concurrent,
// signed role and removal operations submitted to different nodes and checks
// that every node folds them into the same community.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
let stage = "configuration";
let failure;
let success;

try {
  const configured = JSON.parse(process.env.COMMUNITY_TEST_NODES || "null");
  check(
    Array.isArray(configured) && configured.length >= 3,
    "COMMUNITY_TEST_NODES must contain at least 3 API base URLs",
  );
  const nodes = configured.map((value) => new URL(value));
  const networkId = process.env.COMMUNITY_TEST_NETWORK_ID;
  check(
    typeof networkId === "string" && networkId.length > 0,
    "Missing network ID",
  );

  const request = async (index, identity, method, route, body) => {
    try {
      return await signedRequest(nodes[index], identity, method, route, body);
    } catch (error) {
      if (error instanceof HttpError)
        throw new Error(
        `HTTP ${error.status} at node ${index + 1}: ${String(error.bodyText).slice(0, 300)}`,
      );
      throw error;
    }
  };
  const at = (index) =>
    new SignedCommunities((actor, method, route, body) =>
      request(index, actor, method, route, body),
    );
  const eventually = async (label, operation, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await operation()) return;
      } catch {}
      await pause(250);
    }
    throw new Error(`Timed out: ${label}`);
  };

  const [owner, admin, memberB, memberC, memberD, memberE] = await Promise.all(
    Array.from({ length: 6 }, () => createActor()),
  );
  const everyone = [owner, admin, memberB, memberC, memberD, memberE];
  stage = "publish identities";
  for (const [index, identity] of everyone.entries())
    await publishIdentity(
      (actor, method, route, body) => request(0, actor, method, route, body),
      identity,
      [networkId],
      `Convergence ${index}`,
    );

  stage = "create community";
  const community = await at(0).create(owner, {
    networkId,
    name: `Convergence ${randomUUID()}`,
    description: "Concurrent roles and removals across nodes",
    autoJoinEnabled: true,
    discoverable: false,
    visibility: "private",
  });
  check(typeof community?.id === "string", "Missing community ID");
  const route = `communities/${encodeURIComponent(community.id)}`;
  const read = (index, identity = owner) =>
    request(index, identity, "GET", route);
  const readRoles = (index) => request(index, owner, "GET", `${route}/roles`);

  stage = "admit members";
  for (const identity of everyone.slice(1))
    await at(0).joinAutomatically(identity, community);

  stage = "create and assign role";
  const role = await at(0).createRole(owner, community, "Member managers", [
    "manage_members",
  ]);
  check(typeof role?.id === "string", "Missing role ID");
  await at(0).setMemberRoles(owner, community, admin.id, [role.id]);

  // Reads one snapshot per node; true when all of them are identical.
  const snapshots = async () => {
    const result = await Promise.all(
      nodes.map(async (_, index) => ({
        community: await read(index),
        roles: await readRoles(index),
      })),
    );
    return result;
  };
  const identical = (values) =>
    values.every((value) => isDeepStrictEqual(value, values[0]));

  stage = "replicate roster and roles";
  await eventually("initial replication", async () => {
    const state = await snapshots();
    return (
      identical(state) &&
      everyone.every((identity) =>
        state[0].community.memberIds.includes(identity.id),
      ) &&
      state[0].roles.memberRoles.some(
        (entry) =>
          entry.identityId === admin.id && entry.roleIds.includes(role.id),
      )
    );
  });
  // The acting identities must be known by the nodes they will talk to.
  await eventually("admin known at node 2", async () =>
    (await read(1, admin)).id === community.id,
  );
  await eventually("owner known at node 3", async () =>
    (await read(2, owner)).id === community.id,
  );

  stage = "submit concurrent operations";
  // Control operations form one chain per community: operations signed on the
  // same frontier conflict (409) and the client re-signs on the new frontier.
  // An operation that lost a race against the removal of its own precondition
  // (revoked delegation, member already gone) may end as 403, 404 or 409.
  const submit = async (operation, mayLose = false) => {
    let last;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        last = error;
        if (!/^HTTP 409 /.test(error.message)) break;
        await pause(100 + Math.random() * 400);
      }
    }
    if (mayLose && /^HTTP (403|404|409) /.test(last.message)) return "lost";
    throw last;
  };
  const outcomes = await Promise.allSettled([
    submit(() => at(0).kick(owner, community, memberB.id)),
    submit(() => at(2).ban(owner, community, memberC.id, "concurrent ban")),
    // Race between a delegated kick and the revocation of that delegation.
    submit(() => at(1).kick(admin, community, memberD.id), true),
    submit(() => at(0).setMemberRoles(owner, community, admin.id, [])),
    // Voluntary leave racing an owner kick of the same member.
    submit(() => at(1).leave(memberE, community), true),
    submit(() => at(2).kick(owner, community, memberE.id), true),
  ]);
  const rejected = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => outcome.status === "rejected")
    .map(({ index, outcome }) => `op${index}: ${outcome.reason.message}`);
  check(
    rejected.length === 0,
    `Operations rejected at submission: ${rejected.join(", ")}`,
  );

  stage = "converge";
  let final;
  await eventually("final convergence", async () => {
    const state = await snapshots();
    if (!identical(state)) return false;
    const { memberIds } = state[0].community;
    if (
      memberIds.includes(memberB.id) ||
      memberIds.includes(memberC.id) ||
      memberIds.includes(memberE.id)
    )
      return false;
    final = state[0];
    return true;
  });

  stage = "verify outcome";
  check(
    final.community.memberIds.includes(owner.id),
    "Owner must remain a member",
  );
  check(
    final.community.bannedMemberIds.includes(memberC.id),
    "Banned member must be listed as banned on every node",
  );
  check(
    !final.community.bannedMemberIds.includes(memberB.id) &&
      !final.community.bannedMemberIds.includes(memberE.id),
    "Kicked or departed members must not be banned",
  );
  check(
    final.roles.roles.some((item) => item.id === role.id),
    "Created role must exist on every node",
  );

  stage = "stable after settling";
  await pause(3000);
  check(identical(await snapshots()), "State changed after convergence");

  success = `PASS community convergence nodes=${nodes.length} concurrent-operations=${outcomes.length} members=${final.community.memberIds.length}`;
} catch (error) {
  const detail =
    /^(HTTP [0-9]{3} at node [0-9]+|Timed out: [a-zA-Z0-9 ]+|Operations rejected at submission: [a-zA-Z0-9:, ]+|[A-Z][A-Za-z ]+ (?:must|on every node|after convergence)[A-Za-z ,]*)$/.test(
      error?.message || "",
    )
      ? `: ${error.message}`
      : "";
  failure = `Community convergence probe failed during ${stage}${detail}`;
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else console.log(success);
