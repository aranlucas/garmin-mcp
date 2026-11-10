# Plan 004: Epochs for different activity types in the same 15-minute window are all kept

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3fe4c9f..HEAD -- src/push/store.ts test/push.test.ts`
> If `src/push/store.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Changes to `test/push.test.ts`
> from Plans 001 and 002 are expected and are not drift.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `3fe4c9f`, 2026-11-10

## Why this matters

For Health summaries, the store keeps one row per category and start time: a later, longer record replaces an earlier one. That matches how Garmin revises dailies, sleeps and stress records. Epochs are different. Garmin produces one epoch record **per activity type** for the same 15-minute window, for example one `WALKING` and one `SEDENTARY` record that share `startTimeInSeconds` and both report `durationInSeconds: 900`. Today the second record deletes the first, so steps, distance and calories from all but one activity type are lost and epoch totals are undercounted. After this plan, an epoch only replaces an earlier epoch of the same activity type.

Confidence note for the reviewer: the per-activity-type behavior comes from Garmin's Health API description of epoch summaries. The checked-in schema supports it (`ClientEpoch` has `activityType`, plus `activeTimeInSeconds` separate from `durationInSeconds`), but no real delivery was observed in the planning session. The change is safe either way: if Garmin only ever sends one activity type per window, behavior is identical to today.

## Current state

- `src/push/store.ts` — the per-account Durable Object `GarminUserData`. Its `ingest` method holds the replacement logic.
- `src/push/handler.ts` — sets `row.startTime` and `row.duration` for Health categories only. Do not change it.
- `test/push.test.ts` — Worker tests for the receiver and store. New test goes here.

The replacement logic today, `src/push/store.ts:87-107`, inside `ingest`'s `for (const row of records)` loop:

```ts
if (row.startTime !== undefined) {
  const newer = this.ctx.storage.sql
    .exec(
      "SELECT id FROM summaries WHERE type=? AND start_time=? AND duration>?",
      row.type,
      row.startTime,
      row.duration ?? 0,
    )
    .toArray();

  if (newer.length) {
    continue;
  }

  this.ctx.storage.sql.exec(
    "DELETE FROM summaries WHERE type=? AND start_time=? AND id<>?",
    row.type,
    row.startTime,
    row.summaryId,
  );
}
```

Facts you need:

- The table is `summaries (type, id, date, received_at, data, start_time, duration)`. `data` is the record's JSON text. `row.data` is that same JSON text for the incoming record.
- SQLite's `json_extract` is already used in this file (line 110, `json_extract(excluded.data,'$.importSource')`).
- In SQLite, `a IS b` is true when both are `NULL`. That matters here: records without an `activityType` must keep today's behavior.
- An existing test, `"keeps the latest complete health summary when Garmin changes its summary ID"` (`test/push.test.ts:189-199`), pushes three epochs **without** `activityType` and expects one row. It must keep passing unchanged.
- `test/push.test.ts` defines `record(userId, summaryId, steps)`, which returns `{ userId, summaryId, calendarDate: "2026-10-23", startTimeInSeconds: 1792713600, steps }`, and `push(body)`.

Garmin's epoch shape, from `docs/garmin-wellness-openapi.json` (`components.schemas.ClientEpoch`): `userId`, `summaryId`, `activityType`, `activeKilocalories`, `steps`, `distanceInMeters`, `durationInSeconds`, `activeTimeInSeconds`, `startTimeInSeconds`, `startTimeOffsetInSeconds`, `met`, `intensity`, and others.

## Commands you will need

These come from `package.json` and `.github/workflows/ci.yml`. They were not run in the planning session.

| Purpose           | Command                                                                          | Expected on success |
| ----------------- | -------------------------------------------------------------------------------- | ------------------- |
| Install           | `pnpm install`                                                                   | exit 0              |
| Push tests only   | `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` | all pass            |
| Typecheck         | `pnpm run typecheck`                                                             | exit 0, no errors   |
| Lint              | `pnpm run lint`                                                                  | exit 0              |
| Format check      | `pnpm run format:check`                                                          | exit 0              |
| Full Worker suite | `pnpm test`                                                                      | all pass            |

Always run `pnpm run build:apps` before `vitest` in a fresh checkout.

## Scope

**In scope** (the only files you should modify):

- `src/push/store.ts` (only the two SQL statements shown above, plus one constant)
- `test/push.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- The `known` query just above the excerpt (`src/push/store.ts:76-85`). It only feeds event de-duplication, and epochs never produce events.
- The `INSERT ... ON CONFLICT` statement below the excerpt.
- Any schema change such as a new column or index. The fix is a query predicate only.
- Replacement behavior for every other category. Only rows whose `type` is `epochs` may behave differently.

## Git workflow

- Branch: `advisor/004-keep-epochs-per-activity-type`
- One commit. Suggested message: `Keep epochs of different activity types that share a start time`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a failing test

In `test/push.test.ts`, add this test directly after `"keeps the latest complete health summary when Garmin changes its summary ID"`:

```ts
it("keeps one epoch per activity type for the same window and replaces only a revision", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  // Shape follows ClientEpoch in docs/garmin-wellness-openapi.json.
  const epoch = (summaryId: string, activityType: string, steps: number) => ({
    ...record(id, summaryId, steps),
    activityType,
    durationInSeconds: 900,
    activeTimeInSeconds: 450,
  });

  await push({ epochs: [epoch("walk-1", "WALKING", 600), epoch("still-1", "SEDENTARY", 0)] });
  const both = await store.list("epochs", "2026-10-23", "2026-10-23", 50, 0);
  expect(both.records).toHaveLength(2);

  await push({ epochs: [epoch("walk-2", "WALKING", 640)] });
  const revised = await store.list("epochs", "2026-10-23", "2026-10-23", 50, 0);
  const stored = revised.records.map((row) => row.summaryJSON).join("\n");

  expect(revised.records).toHaveLength(2);
  expect(stored).toContain("walk-2");
  expect(stored).toContain("still-1");
  expect(stored).not.toContain("walk-1");
});
```

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → the new test **fails** at the first `toHaveLength(2)` with a length of `1`. All other tests pass.

### Step 2: Scope the replacement to the same activity type for epochs

In `src/push/store.ts`, add a module-level constant below the `type ActivityOwner` line:

```ts
// Garmin sends one epoch per activity type for the same window, so only a revision of the same
// activity type replaces an earlier epoch. Every other category keeps one row per start time.
const SAME_SLOT =
  "(type<>'epochs' OR json_extract(data,'$.activityType') IS json_extract(?,'$.activityType'))";
```

Then change the two statements from "Current state". Append ` AND ${SAME_SLOT}` to each SQL string and pass `row.data` as one extra, final bound value:

```ts
const newer = this.ctx.storage.sql
  .exec(
    `SELECT id FROM summaries WHERE type=? AND start_time=? AND duration>? AND ${SAME_SLOT}`,
    row.type,
    row.startTime,
    row.duration ?? 0,
    row.data,
  )
  .toArray();
```

```ts
this.ctx.storage.sql.exec(
  `DELETE FROM summaries WHERE type=? AND start_time=? AND id<>? AND ${SAME_SLOT}`,
  row.type,
  row.startTime,
  row.summaryId,
  row.data,
);
```

Change nothing else in `ingest`.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → all pass, including the new test and the existing `"keeps the latest complete health summary when Garmin changes its summary ID"`.

### Step 3: Run the full gates

**Verify**:

- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm run format:check` → exit 0 (if it reports your files, run `pnpm exec oxfmt --write src/push/store.ts test/push.test.ts` and re-check)
- `pnpm test` → all pass

## Test plan

- One new test in `test/push.test.ts`, shown in Step 1. It covers: two activity types in one window are both stored, and a revision of one type replaces only that type.
- The existing test at `test/push.test.ts:189` is the regression guard for records without `activityType`.
- Verification: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` exits 0
- [ ] `pnpm test` exits 0; the new test exists and passes
- [ ] `grep -c "SAME_SLOT" src/push/store.ts` returns `3`
- [ ] `git status --porcelain` lists only `src/push/store.ts`, `test/push.test.ts` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The two SQL statements don't match the excerpts in "Current state".
- The new test passes before you change `src/push/store.ts`.
- The existing test `"keeps the latest complete health summary when Garmin changes its summary ID"` fails after Step 2.
- Any test in `test/events.test.ts` or `test/credential-retention.test.ts` fails after Step 2 and one fix attempt does not resolve it.
- The fix seems to need a new table column or an index.

## Maintenance notes

- The operator should confirm against a real epoch delivery that Garmin sends several records per window. If it never does, this change is inert.
- Rows already deleted by the old logic cannot be recovered; Garmin Starter has no backfill.
- If another category turns out to carry several legitimate records per start time, extend `SAME_SLOT` rather than adding a second mechanism.
- A reviewer should check that both statements received the extra bound value. A missing value fails at runtime, not at compile time.
