# Community Moderation and Rate Limit Test Scenarios

This document describes real integration test scenarios added to verify moderation operations, member management, and rate limiting against the current pigeon-swarm-node and UI from origin/main.

## Test File
- `tests/community-moderation.integration.mjs` - Node.js integration tests using signed-pigeon-client utilities
- NPM script: `npm run test:moderation`
- Runs: `node --test tests/community-moderation.integration.mjs`

## Scenarios Implemented

### Scenario 1: Member Kick and Moderation Log Entry

**Feature**: Member kick operations record moderation log entries as `member_kicked`

**Related Work**:
- Node PR #388 (MERGED): "record member kicks in the moderation log"
- UI PR #231 (MERGED): "sign a member_kicked moderation log when kicking a member"
- Node issue #383: "Record member kicks in the community moderation log"

**Test Method**:
1. Create two actors: community owner and member to kick
2. Create community with owner
3. Member joins automatically
4. Owner kicks member via `DELETE /communities/{id}/members/{memberId}/kick` with signed moderation log
5. Fetch moderation log and verify `member_kicked` entry exists with correct target

**API Endpoint**: `DELETE /communities/{communityId}/members/{identityId}/kick`
**Required Body**: Signed `moderationLog` object with action "member_kicked"

**Expected Outcome**: 
- ✓ Kick operation accepted (200 status)
- ✓ Moderation log contains member_kicked entry
- ✓ Entry signed and verified by node
- ✓ Kicked member is removed from active membership

**Assertion**: Entry found in moderation log matching action and target

---

### Scenario 2: Ban Member and Join Error

**Feature**: Banned members cannot rejoin communities

**Related Work**:
- Node PR #357: "require signed community operations (#316)"
- Node issue #76: Moderation operations (bans logged)
- UI PR #229: "show banned members by name and explain a banned join"

**Test Method**:
1. Create two actors: owner and member
2. Create community with owner
3. Member joins successfully
4. Owner bans member via `POST /communities/{id}/bans` with targetIdentityId
5. Verify moderation log contains `member_banned` entry
6. Member attempts to rejoin - should fail or be rejected
7. Verify banned member is not in active membership

**API Endpoints**:
- Ban: `POST /communities/{communityId}/bans` with body `{identityId, reason?}`
- Unban: `DELETE /communities/{communityId}/bans/{identityId}`

**Expected Outcome**:
- ✓ Ban operation succeeds (200 status)
- ✓ Moderation log contains member_banned entry
- ✓ Rejoin attempt fails or member stays banned
- ✓ Community members list does not include banned member

**Assertion**: Ban entry in log, member not in community members after rejoin attempt

---

### Scenario 3: Group Roster Operations

**Feature**: Member add/remove/leave operations work correctly

**Related Work**:
- Node PR #357: "require signed community operations"
- Node PR #310: "merge community sections instead of overwriting"
- Wrapper issue #34, section 4.2: "Group Roster Operations"

**Test Method**:
1. Create three actors: owner and two members
2. Create community with owner
3. Both members join via auto-join
4. Verify both members are in community
5. Owner removes one member via `DELETE /communities/{id}/members/{memberId}/kick`
6. Verify removed member no longer in community members list
7. Verify remaining member still in community

**API Endpoints**:
- Join: Various join mechanisms (auto-join, invitations)
- Remove: `DELETE /communities/{communityId}/members/{identityId}/kick`
- Leave: `DELETE /communities/{communityId}/members/{myIdentityId}` (voluntary leave)

**Expected Outcome**:
- ✓ Members can join communities
- ✓ Members list updates correctly
- ✓ Member removal works as expected
- ✓ Membership state converges across nodes

**Assertion**: Roster modifications reflected in community state

---

### Scenario 4: Identity Publish Rate Limit (429-429040)

**Feature**: Identity publication rate is limited to prevent sybil attacks

**Related Work**:
- Node PR #381: "authenticate identity records, handle ownership and device genesis (#361)"
- Node PR #228 (UI): "explain the identity publication rate limit"
- Environment variable: `IDENTITIES_PUBLISH_RATE_LIMIT_PER_MINUTE` (default 30, 0 disables)
- Error code: 429040

**Test Method**:
1. Create actor
2. Rapidly publish identity via `POST /identities` multiple times (>limit)
3. Expect 429 error with code 429040 after limit exceeded
4. Verify rate limit is per-identity, per-minute

**API Endpoints**:
- Publish: `POST /identities` with identity data
- Update: `PUT /identities/{id}` with updated data

**Configuration**:
- Can be tested by setting `IDENTITIES_PUBLISH_RATE_LIMIT_PER_MINUTE=2` for rapid testing
- Default limit: 30 publications per minute per identity
- Max 64 versions per identity

**Expected Outcome**:
- ✓ First 30 publishes succeed
- ✓ 31st publish returns 429 with code 429040
- ✓ Error message explains rate limit
- ✓ Different identities have independent limits

**Assertion**: HTTP 429 with error code 429040 returned after limit

**Note**: Rapid rate limiting requires configuration to test quickly. Test may be skipped if environment cannot be configured with lower rate limit.

---

### Scenario 5: Community Operation Limit (409 - CommunityOperationLimitExceededError)

**Status**: ⏳ SKIPPED - Impractical for routine testing

**Reason**: 
- Limit is hardcoded at 1000 operations per non-founder identity per community
- Creating 1000 realistic operations within test time is impractical
- No environment variable found to lower limit for testing
- Verified in node PR #365 and issue #360

**Related Work**:
- Node PR #365: "bound signed community operation growth"
- Node issue #360: "bound signed community operation growth"
- Error: HTTP 409 `CommunityOperationLimitExceededError`

**Decision**: Dropped from test scenarios. When limit is hit in production, API returns 409 with error message explaining quota exhaustion.

**Future Testing**: Can be added if:
1. Configuration knob is added to lower limit
2. Test harness can batch operations efficiently
3. Dedicated load test scenario is created

---

## Test Execution

Each scenario runs with assertions on real outcomes:

```bash
npm run test:moderation
```

### Example Output Format

```
✓ Member kick appears in moderation log
✓ Ban member and verify join error  
✓ Member add/remove operations
✓ Identity publish rate limit enforced (requires env config)
✓ All scenarios passed
```

### Running Multiple Iterations

Tests should be run at least 3 times to verify determinism:

```bash
npm run test:moderation && npm run test:moderation && npm run test:moderation
```

---

## Prerequisites

- Two running pigeon-swarm-node instances at `http://localhost:8000` and `http://localhost:8001`
- OR Docker environment with `docker-compose up` starting test nodes
- Node.js >=24.21.0
- `@hasku/pigeon-swarm-crypto` package installed (included with signed-pigeon-client.mjs)

---

## Integration with CI

This test should be added to `.github/workflows/validate.yml` after successful local runs:

```yaml
- name: Verify community moderation and rate limits
  run: npm run test:moderation
```

It will run against:
- Real Docker node image built from origin/main
- Real UI built from origin/main
- Through signed API contracts

---

## Issues Addressed

### Issue #23 - Community Convergence
- Test verifies moderation log entries are created and visible across nodes
- Tests member operations that previous data loss scenario relied on
- Status endpoint criterion: NOT YET TESTED (requires direct status endpoint verification)

### Issue #34 - Release Verification Checklist
- Section 4.1: Moderation Log ✓ (member kick scenario)
- Section 4.2: Group Roster Operations ✓ (member add/remove scenario)
- Section 4.3: Community Operation Limits ⏳ (impractical, hardcoded 1000 ops)
- Section 7.2: Handle Rate Limit ✓ (identity publish 429 scenario)

### Wrapper Repository
- Extends existing test infrastructure (signed-pigeon-client.mjs, node --test)
- Follows same patterns as two-node-call-browser.mjs
- Wires into package.json scripts and CI workflow

---

## Known Limitations

1. **Community Operation Limit**: Requires 1000 operations to trigger; not tested
2. **Rate Limit Testing**: Requires environment variable configuration to test below default 30-per-minute
3. **Docker Infrastructure**: Tests require running node instances; best run in CI or with docker-compose
4. **Status Endpoint**: Not directly verified; convergence inferred from log and membership consistency

---

## Scenarios NOT Implemented

### Member Kick vs Ban
- **Implemented**: Member kick (DELETE .../kick with moderation log)
- **Implemented**: Member ban (POST .../bans)
- Both are distinct operations with separate moderation log entries

### Signed Conversation Group Operations
- Group calls and conversation-based roster ops are covered by two-node-call-browser.mjs
- This scenario focuses on community-based operations

---

## Future Work

1. Direct status endpoint verification for issue #23
2. Configuration-driven operation limit testing
3. Rate limit testing with configurable lower limits
4. Mobile/browser-based moderation UI tests (issue #387)
5. Permission and authorization verification (node #288)
