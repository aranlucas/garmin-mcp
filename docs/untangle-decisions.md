# Untangle decisions — 2026-11-06

## Scope and baseline

Inventory recorded before implementation. Base: `4ad78be`; clean worktree with no existing edits. Read root AGENTS.md and the requested untangle-codebase skill. Both Comments and Tests additions selected. Tests and builds run only in CI; no local baseline test result is claimed. Existing CI checks generated clients, types, lint, formatting, worker behavior, browser views, and the production build. No deployment is authorized by this task.

Reviewed boundaries: Auth token verification/broker replies; HTTP/MCP composition; summary delivery, retention and dates; activity callbacks, storage and FIT decoding; event subscription/protocol/delivery; Training SDK adaptation and schemas; browser views/host/formatting; pages/assets; OpenAPI generation; CI/configuration and all test suites. Generated clients remain generated. Prior decisions in the maintained docs and recent commits remain authoritative.

## Redesign

- Make the account Durable Object coordinate its single alarm, with each domain exposing its next due time.
  - `events/store.ts` accepts `nextFileExpiry`, although file scheduling is unrelated to event delivery.
  - `push/store.ts` calls `events.schedule()` after file ingestion/claims, owner binding and data deletion. A file change requires knowledge of event internals.
  - Retain pre-commit wake-ups and the account alarm's recovery wake-up: a crash must not strand committed work.
- Put safe decoding of a claimed FIT file in `activity/files.ts`.
  - `activity/mcp.ts` and `push/store.ts` independently fetch, decorate and catch decode failures.
  - Keep authorization/claim/commit in their respective callers: background Auth refresh and foreground request permissions have different lifetimes. Ambiguous one-use downloads must never be retried or expose diagnostics.
- Put the persisted summary contract with summary schemas, instead of the Durable Object implementation.
  - Event enqueue depends on a type owned by `push/store.ts`, which itself constructs the event store. This is an unnecessary dependency on the account coordinator.
- Centralize summary-to-permission classification in summary schemas.
  - The MCP, day, ingestion and purge paths repeat one Health/Activity rule.
- Remove confirmed dead remnants of retired flows.
  - Unreferenced consent/training stylesheets and TrainingClient.getUserId have no callers.
  - createTrainingServer is a standalone server used only by tests; test registration directly.
  - Page document service name/style/theme options never vary; keep the actual site layout.
- Replace self-derived test expectations with independent category and annotation contracts.
  - Summary expectations call production isActivityType; an incorrect classification passes.
  - Training annotations repeat the implementation's name-prefix heuristic.
- Remove implementation-restating comments after structural changes; preserve external protocol facts, privacy constraints, units, and crash/concurrency reasoning.
- Audit tests last. Preserve behavior tests for isolation, withdrawal during I/O, outages, replay, one-use URLs and shared alarm scheduling. Do not remove tests merely because fixtures resemble other suites.

## Retained special cases

- Legacy push route and training redirects preserve configured deliveries/bookmarks.
- Garmin V2 create path, schedule trailing slash, numeric create replies, and 204/empty mutations reflect documented or live-observed provider contracts.
- Bounded reads/decode limits, strict callback destinations, redacted errors and safe discard failures protect memory and credentials.
- Revocation tombstones, version/epoch checks and repeated authorization across I/O prevent restoring withdrawn data. Null broker replies are outages, not proof of withdrawal.
- Event retry/backoff, verification caches/rate limits, secret rotation and expiry are delivery requirements.
- Personal API import stays operator-only and validates all pages/account evidence before delivery; native summaries retain precedence.
- Browser-only view models, missing-value handling and plot projections serve presentation needs and do not belong in the Worker schema modules.
- OpenAPI generation and its separate compiler workspace are upstream tool requirements; do not hand-edit generated output or migrate libraries for cosmetic uniformity.

## Validation and review

Completed the listed structural changes and comment cleanup. An inventory reviewer identified the alarm/FIT/permission/dead-code/test-expectation issues; a subsequent independent whole-repository review found no actionable regressions or further worthwhile structural changes. No behavioral test was deleted or weakened.

Local formatting completed. Standalone lint exposed missing generated Worker types (this fresh worktree has no generated Env declarations); those diagnostics are not an established baseline failure and full CI generates the types first. Three actionable new test-style diagnostics were corrected. No local tests or builds ran. CI remains the validation authority, including competing event/file alarms, failures during claims, account isolation and provider behavior. No new dependency or custom general-purpose utility was introduced: the changes coordinate existing domain logic and library calls.
