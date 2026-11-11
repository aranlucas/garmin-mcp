# Plan 008: Activity reads and file scheduling use indexes instead of full scans

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 07e3182..HEAD -- src/push/store.ts src/activity/store.ts`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (apply after 007 if both are in flight; both touch `src/activity/store.ts`)
- **Category**: perf
- **Planned at**: commit `07e3182`, 2026-11-11

## Why this matters

Stored records never expire (README: "no automatic expiration"), so per-account tables only grow. Two queries scan whole tables:

- **Activity reads.** `getActivity` filters on `CAST(json_extract(data,'$.activityId') AS TEXT)` across every activity row. It runs twice per `get_garmin_activity` call and parses every stored activity and activityDetails payload, sample arrays included.
- **Scheduling.** The `activity_files` table has no index on `state`, `callback` or `expires_at`. `schedule()` runs after every ingest, subscribe and claim, and each run scans that table about four times.

Both costs grow without bound for long-lived accounts.

## Current state

- `src/push/store.ts` constructor creates indexes `summaries_date (type,date,id)` and `summaries_start (type,start_time)`. Find them with `grep -n "CREATE INDEX" src/push/store.ts`.
- `getActivity` query (`grep -n "getActivity(activityId" src/push/store.ts`):
  `SELECT type,data FROM summaries WHERE type IN ('activities','manuallyUpdatedActivities','activityDetails') AND CAST(json_extract(data,'$.activityId') AS TEXT)=? ORDER BY received_at DESC`
- `src/activity/store.ts`:
  - `nextExpiry()` filters `WHERE callback IS NOT NULL OR state='downloading'`.
  - `pendingId()` filters `WHERE state='pending' ORDER BY expires_at`.
  - `expire()` updates `WHERE callback IS NOT NULL AND expires_at<=?` and `WHERE state='downloading' AND expires_at<=?`.
- Schema is created with `CREATE ... IF NOT EXISTS` in constructors, and there is no migration runner. A new **index**, unlike a new column, is safe to add this way: it applies to existing Durable Objects on next construction.

## Commands you will need

| Purpose | Command                                                                                                                | Expected |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| Gates   | `pnpm run typecheck && pnpm run lint && pnpm run format:check`                                                         | exit 0   |
| Tests   | `pnpm exec vitest run --project worker test/activity.test.ts test/credential-retention.test.ts test/summaries.test.ts` | all pass |

## Scope

**In scope**: the constructors in `src/push/store.ts` and `src/activity/store.ts`, plus one new test in `test/activity.test.ts`.

**Out of scope**: adding columns, changing query semantics, and moving `expire()` out of `pendingId()`. That move is a separate, behavior-affecting change.

## Steps

### Step 1: Expression index for activity lookups

Add to the `GarminUserData` constructor:

```sql
CREATE INDEX IF NOT EXISTS summaries_activity ON summaries(CAST(json_extract(data,'$.activityId') AS TEXT)) WHERE type IN ('activities','manuallyUpdatedActivities','activityDetails')
```

The index expression and the `WHERE` clause must match the query text exactly, or SQLite will not use the index.

### Step 2: Index for file scheduling

Add to the `ActivityFiles` constructor:

```sql
CREATE INDEX IF NOT EXISTS activity_files_state ON activity_files(state, expires_at)
```

### Step 3: Prove the plan is used

Add a test that uses `runInDurableObject` to run `EXPLAIN QUERY PLAN` on the exact `getActivity` SQL. Assert that the plan text contains `summaries_activity` and not `SCAN summaries`.

## Done criteria

- [ ] Gates and tests exit 0, including the new query-plan test
- [ ] Only in-scope files are modified

## STOP conditions

- Workers SQLite rejects `json_extract` in an index expression. Report it; do not add a column instead.
- The query plan does not use the index after an exact text match.

## Maintenance notes

Any edit to the `getActivity` predicate must keep the index expression in sync. The query-plan test is there to catch drift.
