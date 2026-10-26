# Authorization and retained data

Authorization failure must deny access without inventing a withdrawal of consent. The Auth service's `GarminTokenBroker.accessToken()` catches refresh failures and returns `null`; `garminAccessToken()` also returns `null` for missing/banned accounts or unusable refreshed credentials. Therefore a null broker reply cannot distinguish disconnection from a temporary outage.

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

## Verification and complexity

The original 215 Worker tests passed. Ten of thirteen added retention scenarios failed against the original implementation; after the fix, all thirteen pass. They seed health/activity summaries, cached FIT data, a subscription and a pending event before testing unavailable credentials on either side of the download, event authorization failures, restored authorization, wrong-account credentials and authenticated disconnect. Two additional tests check the exact expiry boundary and stale account-mismatch ordering.

Independent review found no actionable runtime issues and reproduced the ten original failures. Ten further probes are retained in the same Vitest test file: post-claim permission errors, revocation during background I/O, file replacement, competing foreground claims, retry exhaustion and shared alarm coordination. Their retry loop runs serially because each alarm depends on the previous durable attempt count; its local lint exception documents that dependency.

Recovery tests use Cloudflare's native `abortAllDurableObjects()` and obtain fresh stubs afterward. This verifies reconstruction from durable state after an abrupt restart. The initial graceful-eviction probe stalled while draining requests; the abrupt-restart assertions do not establish graceful-eviction latency. No live account, device, provider action or deployed request is used.

Oxlint 1.89.0 classic complexity changes: `downloadActivityFile` 21→6, `GarminEvents.access` 11→7, shared classifier 4 and extracted file helpers at most 7. These are decomposed decisions plus corrected authorization outcomes, not an assertion that every project function is below 10. Other ingestion, permission-update and event-delivery hotspots remain in the audit queue.

Run `pnpm check`, `pnpm --filter garmin-api-codegen build`, `pnpm --filter garmin-api-codegen test`, `git diff --exit-code -- src/garmin-api` and `pnpm build`. The existing Vitest Worker project covers runtime SQLite and alarms; the native generator's test covers generated output. No custom validation runner was added. The single lint exception on the classifier's `unknown` parameter identifies the actual untrusted RPC parsing boundary and immediately validates through Zod.

## Development dependency patches

The 2026-10-26 audit found seven known advisories in development-only transitive dependencies. Parent tooling pinned affected versions, so a normal depth update did not move them. Narrow pnpm overrides replace only `js-yaml@4.2.0` with `4.3.2`, `zod@4.6.5` with the already-used `4.6.7`, and `undici@7.29.1` with `7.30.1`. Remove the overrides when upstream dependency pins move beyond those exact affected versions.

The patches address YAML CPU amplification, constrained-collection memory use and Undici resource/error handling. See the [js-yaml advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [Undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c). The frozen lockfile fixes actual versions; the workspace continues to disallow esbuild and workerd dependency build scripts. Explicit installs can additionally use `--ignore-scripts`; normal installs may run the existing Husky prepare hook. No remotely exploitable application path was demonstrated by the dependency audit, and an advisory count is not a vulnerability proof for the deployed Worker.
