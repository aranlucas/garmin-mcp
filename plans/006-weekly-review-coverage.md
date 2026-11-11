# Plan 006: A weekly review tool reports a coverage matrix and cites its evidence

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 07e3182..HEAD -- src/mcp.ts src/day.ts src/push/store.ts test/summaries.test.ts test/account.test.ts README.md ROADMAP.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `07e3182`, 2026-11-11

## Why this matters

`ROADMAP.md` names one user outcome: "a useful weekly training review". Its "Now" release is "A weekly review that explains its evidence". Acceptance: "every observation links to its source dates/activities; a week with missing data remains incomplete rather than implying no activity." The roadmap also gives the next shippable slice: "Add one weekly-review resource/tool that composes existing reads and includes a coverage matrix, not a new scoring model."

Today a model must call `get_garmin_day` seven times to cover a week. That costs seven Garmin permission lookups and about 140 Durable Object calls. The model then has to work out coverage itself, and that is exactly where "no records" turns into "no activity". After this plan, one read-only tool returns the week's coverage, cited evidence, and an explicit `complete` flag.

## Current state

- `src/day.ts` builds the single-day read. Keep the new tool consistent with it:
  - Its availability vocabulary is `z.enum(["available", "not_received", "permission_denied"])` (`src/day.ts:29`).
  - A category is denied when the store is revoked or the live permission list lacks `summaryPermission(type)` (`src/day.ts:42-53`).
  - Its output is checked with a Zod schema before it is returned (`src/day.ts:84`).
- `src/mcp.ts:184-208` registers `get_garmin_day`. It makes one `client.getPermissions(ctx.mcpReq.signal)` call, then calls `result(...)`. Errors go to `toolError(readFailure(error instanceof GarminError ? error.status : undefined))`. Copy this structure.
- `src/push/store.ts:141-160`: `list(type, startDate, endDate, limit, offset)` runs `SELECT data,received_at ... ORDER BY date,id LIMIT limit+1` and returns `{records:[{receivedAt, summaryJSON}], hasMore}`. It does not return the stored `date` column.
- Index `summaries_date ON summaries(type,date,id)` (`src/push/store.ts:48-50`) supports `type IN (...) AND date BETWEEN` grouping.
- `src/tool-input.ts` provides `calendarDate = z.iso.date()`. The server stores no user time zone, so "this week" cannot be resolved server-side (`ROADMAP.md`, "Workout due/missed").
- Test pattern: in `test/summaries.test.ts`, `connect(garminId, permissions)` mocks the Garmin permissions URL and links an in-memory MCP client. The day tests there are the model to copy.
- `test/account.test.ts` asserts the exact sorted tool list.

## Commands you will need

| Purpose   | Command                                                                             | Expected on success |
| --------- | ----------------------------------------------------------------------------------- | ------------------- |
| Install   | `pnpm install --frozen-lockfile`                                                    | exit 0              |
| Typecheck | `pnpm run typecheck`                                                                | exit 0              |
| Lint      | `pnpm run lint`                                                                     | exit 0              |
| Format    | `pnpm run format:check`                                                             | exit 0              |
| Tests     | `pnpm exec vitest run --project worker test/summaries.test.ts test/account.test.ts` | all pass            |
| All tests | `pnpm test`                                                                         | all pass            |
| Build     | `pnpm run build`                                                                    | exit 0              |

## Scope

**In scope**: `src/week.ts` (create), `src/mcp.ts`, `src/push/store.ts`, `test/summaries.test.ts`, `test/account.test.ts`, `README.md`, `ROADMAP.md`.

**Out of scope**:

- An MCP Apps week view. It would need `src/mcp-apps/*` and browser tests; that is a separate plan.
- Planned Training sessions. These need `WORKOUT_IMPORT`, and `requireWorkoutPermission` throws, which would fail the whole review.
- Totals, trends, or any score. The roadmap explicitly says "not a new scoring model".
- Changing `get_garmin_day` to use the new store method.

## Steps

### Step 1: Store support

In `src/push/store.ts`:

- Add `date` to `list()` rows: select it and return it on each record. Existing callers map records to new objects, so they never expose it.
- Add `coverage(types, startDate, endDate)`. It runs one `SELECT type,date,COUNT(*) AS count ... WHERE type IN (...) AND date>=? AND date<=? GROUP BY type,date` and returns `{ revoked: this.isRevoked(), counts }`.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: `src/week.ts`

- Input: `weekInput = z.strictObject({ startDate: calendarDate, limitPerType: 1..100 default 50 })`. No `endDate`: the week is always seven dates.
- `weekDates(startDate)` uses UTC date arithmetic.
- Output, validated by a Zod `weekData` schema:
  - `{ startDate, endDate, dates, complete, missingDates, unavailableCategories, coverage, evidence }`.
  - `coverage[type]` is `{ availability, counts }`. `counts` maps every date to an integer, or is `null` when denied. Denied categories must not leak counts.
  - `evidence` has `dailies`, `sleeps` and `activities` sections. Each is `{ availability, records, hasMore, nextOffset }`. Each record is `{ date, summaryId, receivedAt, fields }`, and activity records also carry `activityId` (normalized with `garminActivityId`, else `null`). `fields` keeps only top-level scalar values (string, number, boolean or null), so sample arrays and nested objects never enter the result.
  - `missingDates` lists dates whose `dailies` count is 0, or every date when `dailies` is denied.
  - `complete` is true when `missingDates` and `unavailableCategories` are both empty.

**Verify**: `pnpm exec oxlint src/week.ts` → no errors.

### Step 3: Register `get_garmin_week` in `src/mcp.ts`

Register it as a plain `server.registerTool`, right after `get_garmin_day`, with the same read-only annotations, permission fetch and error mapping. The description must say:

- seven dates from `startDate`;
- what counts mean, and that denied categories have no counts;
- that evidence carries no samples, and which tool to drill into;
- how `missingDates` and `complete` are defined;
- "Missing data does not mean zero or inactivity";
- how to page with `list_garmin_summaries`.

Add one sentence to the server instructions telling the model to cite IDs and report `missingDates` and `unavailableCategories`.

**Verify**: `pnpm run typecheck && pnpm run lint` → exit 0.

### Step 4: Docs

- Add a `get_garmin_week` bullet to the README tool list, and a "Review a week" section after "Read a day's data".
- Record the shipped slice and its remaining limits in `ROADMAP.md`, as its last section requires.

**Verify**: `pnpm run format:check` → exit 0.

## Test plan

Add to `test/summaries.test.ts`, reusing `connect` and real pushes through `receivePush`:

1. A week holding six daily summaries, a sleep, an HRV record and two activities, with data on each side of the week and another account's record on the missing date. Asserts:
   - exact `dates` and `endDate`;
   - per-date counts, with zero for absent dates;
   - `missingDates` equal to the single missing date, and `complete: false`;
   - activity `activityId` values as strings;
   - zero-valued measurements preserved, and nested samples absent;
   - out-of-week and other-account IDs absent;
   - exactly one permission fetch.
2. Seven daily summaries with both permissions give `complete: true`.
3. `it.each` over Health-only and Activity-only permissions:
   - denied categories appear in `unavailableCategories`, in schema order;
   - their `counts` are `null`, and stored records are withheld;
   - Activity-only makes every date missing.
4. After revocation, every category is denied.
5. `hasMore`/`nextOffset` with `limitPerType: 2` continues through `list_garmin_summaries` over the same dates.
6. Month, year and leap-day boundaries in `dates`.
7. Invalid inputs fail without a Garmin call: impossible date, "this week", extra `endDate`, extra `userId`, `limitPerType` 0 or 101.
8. Add `get_garmin_week` to the existing "explains $name without wrongly advising a reconnect" call list.

Also add `get_garmin_week` to the sorted list in `test/account.test.ts`.

## Done criteria

- [ ] `pnpm run typecheck`, `pnpm run lint` and `pnpm run format:check` exit 0
- [ ] `pnpm exec vitest run --project worker test/summaries.test.ts test/account.test.ts` passes, including the new week tests
- [ ] `pnpm run build` exits 0
- [ ] `grep -n "get_garmin_week" README.md ROADMAP.md src/mcp.ts` matches in all three files
- [ ] No files outside the in-scope list are modified

## STOP conditions

- `list()` callers expose the new `date` field somewhere other than the week tool. Check with `grep -rn "store.list(" src`.
- The Zod union for evidence records strips `activityId`. If activity records come back without it, put `activityRecord` first in the union.
- A requirement appears to need a user time zone or "this week" resolution.

## Maintenance notes

- `missingDates` uses `dailies` alone as the "day arrived" signal. If pilots report devices that send no daily summaries, revisit this before adding expected-category configuration.
- If `get_garmin_day` is later rebuilt on a single store snapshot (see the README "Findings without a plan"), `coverage()` is the natural building block.
- Reviewers: confirm that denied categories leak neither counts nor records, and that `fields` never contains arrays or objects.
