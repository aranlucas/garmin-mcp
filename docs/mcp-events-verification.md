# MCP Events verification against OpenAI's guide

Checked **2026-10-24** against the complete [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events). This records local protocol and lifecycle evidence. It does not certify a live ChatGPT integration.

## Audit corrections

The initial PR had the documented event methods and signed webhook envelope, but re-challenged callbacks on every refresh. Verification now caches a successful proof for five minutes, keyed by authenticated principal, Garmin account, callback URL, and signing key. Hits do not renew the proof's expiry. Expired proofs and new keys require a new challenge. Revocation and explicit deletion invalidate the cache; durable alarms remove expired entries.

Verification failures now distinguish timeout, connection, TLS, HTTP, and challenge failures in the safe `data.reason` field of `-32015`. Upstream URLs, response bodies, and raw exception messages remain private. An explicit 256 KiB UTF-8 bound now protects the complete serialized request body at the send boundary.

## Local evidence

The existing Worker suite now includes these checks:

- **Discovery and authentication:** actual HTTP requests through the Worker verify MCP `2026-07-28`, `server/discover`, `resultType: complete`, the `events` capability, and permission-filtered event definitions. The same `/mcp` authentication protects tools and Events.
- **HTTP subscription lifecycle:** an authenticated `events/subscribe` request produces a signed challenge, stores a subscription, and returns `id`, a finite `refreshBefore`, `cursor: null`, and `truncated: false`. Refresh preserves identity and uses the verification cache. A synthetic Garmin delivery reaches a signature-validating callback. A nonmatching sport is filtered. Repeated unsubscribe succeeds, and subsequent observations produce no deliveries.
- **Canonical identity and permissions:** reordered/normalized filters reuse the subscription ID. Account mismatches are rejected, Garmin permissions are checked again before delivery, and disconnect/deletion races cannot activate or send from stale state.
- **Verification cache:** account-local proofs survive eviction, have fixed expiry, and are bypassed on key/URL change or expiry. Fresh challenges are rate-limited; cache hits do not consume the challenge quota.
- **Signing and bounds:** a receiver validates the exact transmitted body with `standardwebhooks`. Altered bodies fail verification. Retries retain identity/body while recalculating signing time/signature. A multibyte body over 262,144 bytes is rejected before network I/O.
- **Delivery lifecycle:** independent jobs fan out to matching subscribers, survive eviction, and retry transient failures within bounded attempts. `410` and `413` are terminal. Expiry, unsubscribe, permission withdrawal, and deletion remove pending bodies. Secret rotation accepts the new key and overlaps the old key briefly.

Relevant tests: [HTTP integration](../test/worker.test.ts), [account/outbox lifecycle](../test/events.test.ts), [callback wire behavior](../test/event-webhook.test.ts). The local `pnpm check` run passed **137 Worker tests**, TypeScript, lint, and formatting; `pnpm build` passed. No live Garmin workouts or calendar fixtures were created.

## Callback networking

The guide requires resolved destinations to be restricted when connecting. This Worker delegates that boundary to native global `fetch`, keeps TLS verification enabled, disables redirects, and enables `global_fetch_strictly_public`. It does not dispatch user callbacks through private service/VPC bindings.

Cloudflare's [network policy source](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp#L936) documents public-address-only defaults and filtering of DNS lookup results. The [public routing flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) closes the same-zone private-origin bypass; Cloudflare also explains the [capability-based SSRF boundary](https://blog.cloudflare.com/workers-environment-live-object-bindings/). This supplies the address restriction below the application rather than using Node DNS/HTTPS pinning. Source/configuration inspection supports this design; mocked callback tests do not validate the deployed network boundary. Moving the transport outside Workers or enabling private routing requires a new networking assessment.

## Remaining integration limits

The guide's live ChatGPT checklist remains open: deployed discovery/rescan, event visibility on the plugin page, subscription in a Work cloud chat or dot, a real callback verification and receipt, the host's instructed response, filtering, unsubscribe, and burst/batching behavior. Local fake receivers cannot prove those host behaviors. Physical Garmin sync timing is also unverified.

Events have no client replay cursor; interrupted history is read through summary tools. This is a documented no-replay option, while pending deliveries still survive restart. It is separate from the SDK REPL example's session/SSE `EventStore`.

The guide recommends idempotent writes and testing feedback loops. Existing [Training tools](../src/training/mcp.ts) mark writes as non-idempotent and require user confirmation; the approved Garmin create/schedule contract does not expose a documented idempotency key. This audit does not establish safe automatic Training mutations from repeated event-driven instructions. The initial monitoring examples use read/notify behavior and explicitly avoid automatic plan changes. Automatic Training writes need their own durable idempotency design and feedback-loop verification.
