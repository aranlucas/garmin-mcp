# Authorization and retained data

Authorization failure must deny access without inventing a withdrawal of consent. The private Auth broker can return `null` for missing links or temporary refresh failures, so a null reply cannot establish disconnection.

Confirmed disconnect uses the existing authenticated `/garmin/disconnect` control request or Garmin deregistration delivery. Permission-change delivery and successful permission-list responses establish category withdrawal. These paths remain authoritative; failed credential or permission lookups do not replace them.

## Shared credential classification

`classifyGarminCredential(value, garminUserId, now)` is the Zod parsing boundary for background work. It accepts an untrusted RPC reply, the expected immutable account ID and a clock value in milliseconds, and returns one of:

| Result                               | Evidence                                                                          | Behavior                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed`, with validated credential | Nonempty token, valid account ID and expiry strictly after `now`; account matches | Continue to the current sharing-permission check. This alone does not authorize a data read or delivery.                                                                                                 |
| `unavailable`                        | Null, malformed reply or expiry at/before `now`                                   | Withhold access, preserve unrelated retained state and follow the caller's bounded retry policy. Even a stale reply naming another account is not sufficient for destructive classification.             |
| `mismatch`                           | A usable credential names a different account                                     | Deny access. The file worker retains its existing permanent-revocation policy for the old store; event delivery removes the mismatched subscription. Never use the credential for the requested account. |

Both background file retrieval and event authorization use this classifier. Broker exceptions and failed permission HTTP requests are unavailable. In particular, `401` may mean an expired token, and a failed lookup does not supply a current permission list. A successful list that omits the required permission remains a denial. Local revocation/permission tombstones remain checked around asynchronous work.

The request-level `/mcp` boundary still returns HTTP 401 for unavailable credentials. An event subscription that reaches its authorization check without a usable broker credential returns the existing temporary-authorization protocol error (`-32603`), rather than treating null as a confirmed forbidden state (`-32012`). No successful response or private data is fabricated during an outage.

## File state and recovery

`GarminUserData.downloadActivityFile()` coordinates due-work selection, validated identity, permissions, one-use retrieval and post-download authorization. Its helpers keep each phase locally reviewable:

1. Select an unclaimed pending file and persist a one-minute retry floor before external work. Expired callback cleanup and event deadlines continue sharing the object's single alarm.
2. Obtain a usable matching credential and current `ACTIVITY_EXPORT` permission before claiming a callback. An unavailable result leaves the callback pending, bounded by its original 24-hour lifetime.
3. Claim the URL durably before download, clearing the stored callback. The same URL cannot be consumed by a concurrent read, retry or duplicate delivery.
4. Decode the bounded response, recheck permission and obtain a fresh broker classification. If credential validation becomes unavailable after claim, discard this payload and mark the claimed file unavailable. Preserve health summaries, other cached FIT data, event subscriptions and unrelated deliveries.
5. Complete only the matching record version while the store still permits access. A concurrent deletion, category withdrawal or disconnect prevents resurrection. A thrown post-claim lookup or process crash leaves a consumed claim that becomes unavailable on lease expiry; it is never automatically downloaded again.

The shared alarm uses persisted schedules, consistent with Cloudflare's [single-alarm and at-least-once execution model](https://developers.cloudflare.com/durable-objects/api/alarms/). The application retains its explicit retry schedule rather than relying on automatic exception retries for one-use external work.

Event authorization outages use the existing maximum of five attempts within fifteen minutes. Exhausted occurrence bodies are discarded; subscription expiry still applies. Explicit unsubscribe, disconnect and category withdrawal continue removing the affected subscriptions and pending bodies. An already-sent callback cannot be recalled.

## Regression coverage

[Credential classification tests](../test/credential-access.test.ts) cover exact expiry and stale account mismatches. [Retention tests](../test/credential-retention.test.ts) cover outages before/after file claim, restoration, explicit disconnect, revocation during I/O, file replacement, competing foreground claims, event retry exhaustion and shared alarms. They use synthetic data and mocked provider responses. `abortAllDurableObjects()` verifies reconstruction after abrupt restart, not graceful-eviction latency.

## Development dependency patches

Development tooling pins affected transitive versions. [Workspace overrides](../pnpm-workspace.yaml) replace only `js-yaml@4.2.0` with `4.3.2`, `zod@4.6.5` with `4.6.7`, and `undici@7.29.1` with `7.30.1`. Remove each override when upstream pins move beyond the affected version. Advisory rationale: [js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [Undici](https://github.com/advisories/GHSA-xjj6-f33q-929c).

The workspace disallows esbuild and workerd dependency build scripts. `pnpm install --ignore-scripts` also skips the root Husky prepare hook.
