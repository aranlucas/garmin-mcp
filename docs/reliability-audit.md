# Correctness and reliability audit — 2026-11-06

Baseline: remote default `origin/main`, `1a53cb8` (merged untangle pass). Clean isolated worktree. Tests and builds run in CI only.

## Inventory and trust boundaries

- `app.tsx`, `auth.ts`: protected MCP HTTP endpoint, issuer/audience/scope validation, broker response validation, immutable Garmin account store selection. Public health, landing/privacy and OAuth resource metadata routes; private push/disconnect routes.
- `mcp.ts`, `day.ts`, `activity/mcp.ts`, `training/*`: read stored health/activity data, download one-use FIT callbacks, create/update/delete workouts and schedules. Inputs and upstream responses use Zod; ambiguous writes must not be automatically retried.
- `push/handler.ts`, `push/store.ts`, `push/schemas.ts`: authenticated delivery, validation before mutation, per-account SQLite summaries, permission timestamps, revocation tombstones, explicit reactivation/deletion. Partial cross-account delivery can replay stable summary IDs.
- `activity/*`: allowlisted official callbacks, bounded FIT downloads, claim/version protection, chunked persistence and expiration. Background authorization failure retains unrelated data; confirmed mismatch revokes.
- `events/*`: subscription ownership, public HTTPS callbacks, challenge verification, encrypted signing secrets, transactional outbox, bounded retry/deadline, shared alarm with file downloads. Epoch/version checks protect subscription activation and delivery around asynchronous I/O.
- `mcp-apps/*`: self-contained host-bridged React views for day navigation, activity charts and workout scheduling requests. Host messages/results cross a schema boundary; scheduling asks the host model and does not silently mutate Garmin.
- `codegen/*`, generated APIs, config and CI: generated API contracts, Worker tests, protocol fixtures and Playwright view tests. Existing meaningful coverage and production configuration retained.

## Confirmed findings (before implementation)

### R1 — leaving a loading activity is undone by its late reply (medium, high confidence)

Location: `src/mcp-apps/ui/day-view.tsx`, `open` and activity `back` handlers. Trigger: open an activity from a day, press “Back to day” while the host tool call is pending, then the tool resolves. Expected: remain on the day the user selected. Actual: unconditional `setScreen` restores the activity and publishes stale model context. A host response can therefore override a later user decision.

Plan: invalidate pending navigation on Back and guard asynchronous completions with a navigation sequence. Regression will hold a real host tool reply until after Back, then assert day content and context remain current.

### R2 — pending day navigation uses the original tool date (medium, high confidence)

Location: same file, `Screen` and `date` fallback. Trigger: navigate away from the initial day, request the preceding day, and press Previous again while loading (or after an error). Expected: dates progress from the current selected day. Actual: loading/error states fall back to `tool.input.date`, so requests repeat or jump back to the original date. Concurrent replies also overwrite newer selections.

Plan: retain the selected date in day state and ignore superseded replies. Regression will assert requested dates and resolve replies out of order; latest selected content must win. Error/retry navigation also keeps the selected date.

## Reconciled hypotheses and limits

- Broker null/expired/invalid replies are not proof of revocation: existing classification and credential-retention regressions deliberately retain data. Do not change this policy.
- One-use FIT callback failures cannot be safely retried after claiming; existing consumed-claim expiry and version checks are intentional.
- Missing health records are not zero activity; MCP tool descriptions and UI availability states preserve this distinction.
- Push permission notifications use monotonic timestamps and SQL transactions; parallel delivery is not by itself evidence of corruption. Revocation tombstones reject late pushes.
- Event delivery is at least once; transport failures after remote acceptance may duplicate a stable event ID. No exactly-once requirement is invented.
- SDK requests use request-local tokens, explicit redirects, deadlines, bounded bodies and validated output. No unrelated SDK/auth migration or structural cleanup is warranted.
- External Garmin/Auth success paths cannot be validated against production under this audit. Existing fixture-backed HTTP/protocol/storage tests remain the relevant ordinary CI gates.

## Requested e2e framework

Read published quickstart, CI, GitHub Actions, web and config references on 2026-11-06. Registry confirms real `e2e` 0.23.0 and `@e2e-dev/web` 0.15.5, both Node `^22.22.3 || >=24.8.0`; repo uses Node 24.22.1. Deterministic browser actions require no model credentials. MCP Apps supply an honest browser target: the actual built day view and its host protocol, with controlled synthetic Garmin results. This covers navigation journeys, not Garmin login or real device sync. API/CLI-only `codegen` has no independent browser/mobile target; preserve its generation/contract CI checks rather than inventing a UI.

## Validation and review

Pending implementation, independent review and CI. No local tests or builds executed.

### R3 — stale permission denial deletes a refreshed subscription (medium, high confidence)

Independent review found `events/store.ts:deliver` checks subscription version only on the allowed path. A delayed old permission denial can arrive after successful re-subscription with restored permissions and delete the new version by deterministic ID. Expected: discard the stale authorization decision and retry under the new subscription; actual: new subscription and its pending deliveries are removed. Add a version guard immediately after authorization and a held-denial storage/protocol regression. This finding was recorded before implementing it.
