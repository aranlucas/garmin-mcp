# Garmin MCP Events

The authenticated `/mcp` endpoint supports the experimental MCP Events **webhook profile** used by [DIGITS](https://github.com/aranlucas/digits-call-bridge/blob/55a5138076745dc6105b90f07aa2aa290a2572f1/apps/server/docs/events.md) and [documented by OpenAI](https://developers.openai.com/plugins/build/mcp-events). An event-capable client can discover events and subscribe independently. Each matching subscription receives its own signed delivery; successful delivery to one client does not consume another client's event.

## Available events

- **`garmin.activity.completed` — Workout finished.** A new recorded `activities` summary arrived after Garmin sync. Optional filters: `activityTypes` (case-insensitive sport names, such as `RUNNING`) and `minDurationSeconds`. Imports, summaries already stored before subscription, `isManual` records, edits, Move IQ, and later activity-detail deliveries do not trigger it. This does not establish that a scheduled Training workout was performed.
- **`garmin.sleep.available` — Sleep summary available.** A new `sleeps` episode arrived. Revisions for the same start time do not trigger another event. No filters.
- **`garmin.body_composition.recorded` — Body composition recorded.** A new `bodyComps` measurement arrived. No filters.
- **`garmin.health_snapshot.available` — Health Snapshot available.** A new `healthSnapshot` summary arrived. Requires `HEALTH_EXPORT`. Repeated IDs and revisions with the same start time do not trigger another event. No filters; nonempty arguments are rejected. Pre-subscription history, imports, and manual records are not replayed.

Data becomes available after device synchronization, which can occur later than finishing on the watch. Event `timestamp` and `data.receivedAt` describe when this service received the summary. Available provider start time and duration are separate fields; no finish time is fabricated from timer duration.

Each payload contains `type`, `summaryId`, `calendarDate`, and `receivedAt`. Available activity fields include sport, name, start time, duration, distance, and heart-rate summary. Sleep/body-composition/Health Snapshot payloads carry a reference and available timing; read measurements with `get_garmin_summary`. If a Health summary has been superseded by a more complete record with a new ID, use `list_garmin_summaries` for the event's calendar date and start time. Health Snapshot measurements (including heart rate, stress, respiration, and pulse oximetry) stay in the stored summary, not its event. GPS traces, samples, Garmin account IDs, and credentials are not included in events. Payload text is untrusted data.

## Subscribe

Refresh the connector's catalog in an event-capable client. For example:

> When a running workout finishes on Garmin, summarize the session here and ask how it felt. Do not change my training plan automatically.

The client supplies the callback URL and signing secret through `events/subscribe`. Users do not need to copy secrets into chat. The client must support the advertised delivery mode. ChatGPT's documented integration requires MCP `2026-07-28` in Work cloud chats or dots; general MCP tool support alone does not establish Events support.

The SDK advertises `capabilities.events` through `server/discover` and registers:

- `events/list`: discover only categories currently shared with Garmin MCP.
- `events/subscribe`: verify, create, or refresh an account-scoped subscription.
- `events/unsubscribe`: idempotently remove the caller's matching subscription and its pending deliveries. Works after category withdrawal while the account remains linked.

Subscriptions use the authenticated Auth subject and immutable Garmin account. Account IDs are never subscription arguments. The default lifetime is one day, with a five-minute minimum and seven-day maximum. Refresh the same owner, account, callback, name, and normalized filters to retain the subscription ID. There is a limit of 50 subscriptions and 10 callback verification attempts per minute per Garmin account.

The server keeps the ChatGPT/DIGITS profile's `-32011..-32015` error codes, including `-32015` for callback verification failure. The [working-group sketch at `d5316be`](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md) instead uses `-32023..-32027`; changing codes would change client error semantics. The implemented profile also omits the sketch's `gap` and `terminated` controls, and does not advertise `listChanged`. Polling, streaming, and client cursor replay are not implemented. Deliveries carry `cursor: null`; a non-null subscribe cursor is rejected. Existing tools provide history. No pre-subscription history is replayed.

## Delivery and storage

One existing SQLite Durable Object per Garmin account stores subscriptions, occurrences awaiting delivery, and a separate outbox row for each event/subscription pair. A new summary and its deliveries are committed together. Ingestion performs no callback, Garmin API call, or AI processing. A durable alarm handles delivery and schedules the next retry or expiration; state survives eviction.

Before subscription activation, a signed challenge verifies the callback. Successful proofs are cached for five minutes by account, authenticated principal, callback URL, and signing key. Cache hits keep the original expiry; a key change requires a fresh challenge. Revocation/deletion invalidates proofs. Failures return `-32015` with a categorized `data.reason`. Deliveries use `standardwebhooks` to sign the exact serialized body with `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id`. The complete UTF-8 body is limited to 256 KiB before any request is sent. Callbacks require public HTTPS hostnames with no credentials or fragments; IP literals and local names are rejected. Redirects are disabled and calls time out after ten seconds. The production transport uses native global `fetch`, with `global_fetch_strictly_public` enabled and no private network binding: [Cloudflare's public routing flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [Workers' capability-based network isolation](https://blog.cloudflare.com/workers-environment-live-object-bindings/). Cloudflare's [runtime network policy](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp#L936) filters resolved addresses at the network layer. This relies on Workers' public network isolation rather than DIGITS' Node DNS/HTTPS pinning; do not replace it with a private-origin or VPC transport.

Callback secrets are encrypted by `jose` (JWE A256GCM), using a key derived with a separate HKDF context from the existing private `GARMIN_PUSH_TOKEN`. No additional operator secret is required. Rotating that delivery credential makes old callback secrets unreadable; clients must subscribe again. A subscription refresh signs with both old and new secrets for a ten-minute overlap.

The Auth broker rechecks account linking/banned status and supplies current Garmin credentials for subscription activation and every delivery attempt. The immutable account must still match, and current Garmin sharing permission must cover the event. Temporary authorization or callback failures receive bounded retries. Each event has up to five delivery attempts within fifteen minutes, with exponential backoff and jitter; `408`, `425`, `429`, and `5xx` are retryable. Other HTTP failures are terminal. A `2xx` acknowledges receipt, not successful AI processing. Network ambiguity can cause duplicate deliveries, so clients must deduplicate `eventId`. Arrival order is not guaranteed.

Delivered or exhausted bodies are removed from the outbox; the normal source summary remains under existing retention rules. Unsubscribe, expiration, Garmin disconnect, and sharing withdrawal remove the affected subscriptions and pending bodies. `delete_stored_garmin_data` also cancels all event subscriptions. Re-subscribe to resume monitoring after deletion. A request already sent cannot be recalled. Removing a connector should unsubscribe its events; otherwise its explicit subscription can remain until expiration. Disconnecting Garmin stops every subscription for that account. Copies delivered to a client are governed by that client's deletion controls.

Unavailable authorization withholds delivery without deleting subscriptions; confirmed withdrawal remains destructive. See [authorization and retention contracts](authorization-retention.md) for classification and retry behavior.

## Trace an event

Structured Workers Logs distinguish subscription creation, refresh, deletion, accepted-summary decisions, webhook responses, scheduled retries, and terminal delivery outcomes. Search the `event` field for `mcp_event_ingest`, `mcp_event_webhook`, `mcp_event_delivery_retry`, or `mcp_event_delivery_finished`. The same `event_id` correlates ingestion with each subscription's independent delivery. HTTP `2xx` means the callback acknowledged receipt; it does not prove that the client ran an AI response or another action.

Ingestion logs report decisions such as `queued`, `no_subscriptions`, `filtered`, `duplicate`, `import`, or `manual`, plus subscription and queued-delivery counts. They are emitted after the summary transaction commits, so a rolled-back batch does not claim it queued events. Only event-producing summary types are traced; later detail records and other categories do not create completion events. Source references are SHA-256 of `JSON.stringify([type, summaryId])`, allowing correlation with a known summary without logging the raw provider ID. Lifecycle logs use `mcp_event_subscription_created`, `mcp_event_subscription_refreshed`, and `mcp_event_subscription_deleted`.

Logs contain opaque event/subscription IDs, hashed source references, fixed protocol labels, counts, attempt numbers, and HTTP status codes. They exclude activity names, metrics, provider identities, payload bodies, callback URLs, filters, tokens, and signing secrets. Automatic invocation logs and URL traces remain disabled. These are operational logs under Cloudflare's retention and delivery limits, not a durable or exhaustive delivery ledger. They cannot reconstruct a callback body that was already discarded or establish delivery before this instrumentation was deployed. Read the source summary with `get_garmin_summary`; absence of a retained webhook log is inconclusive.

## Compatibility and validation limits

The MCP SDK owns transport and custom-method registration; Garmin-specific code supplies observations, permissions and durable delivery. `standardwebhooks` follows the documented profile; existing `jose` handles secret encryption. The DIGITS runtime was not imported because it couples delivery to unrelated phone/session behavior and Node-specific storage/networking.

[HTTP integration](../test/worker.test.ts), [account/outbox lifecycle](../test/events.test.ts), and [callback wire tests](../test/event-webhook.test.ts) use a fake Auth RPC service, mocked Garmin permissions and synthetic receivers. They exercise signed fan-out, filtering, deduplication, refresh/key rotation, retries, expiry, account separation and revocation. Mocked fetch does not validate the deployed public-network boundary; moving transport outside Workers or enabling private routing requires a new networking assessment.

Live host verification remains necessary: discovery/rescan, event visibility, callback verification and receipt, the host's instructed response, filtering, unsubscribe and burst/batching behavior. Physical Garmin sync timing is also unverified. Generic MCP tool support does not establish Events support or cause a host to wake an agent.

Training writes require explicit confirmation and are non-idempotent; Garmin's create/schedule contract supplies no documented idempotency key. Automatic event-driven mutations need durable idempotency and feedback-loop verification before use. Initial monitoring should read/notify only.

[Candidate follow-on events](../ROADMAP.md#candidate-event-follow-ons) retain the remaining product ideas.
