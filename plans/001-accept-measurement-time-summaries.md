# Plan 001: Garmin body composition and blood pressure deliveries are accepted and stored

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3fe4c9f..HEAD -- src/push/schemas.ts test/push.test.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `3fe4c9f`, 2026-11-10

## Why this matters

Garmin's `bodyComps` and `bloodPressures` summaries carry `measurementTimeInSeconds`. They have no `calendarDate` and no `startTimeInSeconds`. The push receiver's envelope schema requires one of those two fields (or a nested `summary`), so every real delivery of these two categories fails validation and the whole request is answered `400`. Nothing is stored, `list_garmin_summaries` returns nothing for those categories, and the `garmin.body_composition.recorded` event can never fire. The existing tests pass because their fixtures add a `calendarDate` that Garmin does not send. After this plan, both categories are stored under the device-local date of the measurement.

## Current state

- `src/push/schemas.ts` — Zod schemas for Garmin push deliveries. Contains the envelope schema `summary` and the date helper `summaryDate`.
- `src/push/handler.ts` — the webhook receiver. It calls `summary.safeParse(value)` for every record and returns `400` when it fails. Do not change this file.
- `test/push.test.ts` — Worker tests for the receiver. New tests go here.
- `docs/garmin-wellness-openapi.json` — Garmin's own Health API description, checked in. It is the independent source for the real record shapes.

The schema today, `src/push/schemas.ts:60-74`:

```ts
export const summary = z
  .looseObject({
    userId,
    summaryId: z.string().min(1).max(255),
    calendarDate: calendarDate.optional(),
    durationInSeconds: z.number().nonnegative().optional(),
    startTimeInSeconds: z.number().int().nonnegative().optional(),
    startTimeOffsetInSeconds: z.number().int().min(-86400).max(86400).optional(),
    summary: z.looseObject(timing.shape).optional(),
  })
  .refine(
    (value) =>
      value.calendarDate !== undefined || value.startTimeInSeconds !== undefined || value.summary,
    { message: "Summary requires a calendar date or start time." },
  );
```

The date helper today, `src/push/schemas.ts:95-104`:

```ts
export function summaryDate(value: Summary): string {
  if (value.calendarDate) {
    return value.calendarDate;
  }

  const seconds = value.startTimeInSeconds ?? value.summary?.startTimeInSeconds ?? 0;
  const offset = value.startTimeOffsetInSeconds ?? value.summary?.startTimeOffsetInSeconds ?? 0;

  return new Date((seconds + offset) * 1000).toISOString().slice(0, 10);
}
```

Garmin's shapes, from `docs/garmin-wellness-openapi.json` (`components.schemas`):

- `ClientBodyComp`: `userId`, `summaryId`, `muscleMassInGrams`, `boneMassInGrams`, `bodyWaterInPercent`, `bodyFatInPercent`, `bodyMassIndex`, `weightInGrams`, `measurementTimeInSeconds`, `measurementTimeOffsetInSeconds`.
- `ClientBloodPressure`: `userId`, `summaryId`, `systolic`, `diastolic`, `pulse`, `sourceType`, `measurementTimeInSeconds`, `measurementTimeOffsetInSeconds`.

Neither has `calendarDate`, `startTimeInSeconds`, or a nested `summary`.

Conventions that apply:

- Tests follow the rules in `AGENTS.md`: "Before adding a test, identify the specific behavior, a credible mistake it should catch, and an independently justified expected result" and "Do not reproduce implementation logic in assertions or mocks."
- Lint is strict (`oxlint` with an `anti-slop` rule set). It requires a blank line between a multi-line statement and the next statement. Match the spacing of the surrounding code.
- `test/push.test.ts` already defines the helper `push(body)` (lines 12-23), which calls the receiver with a valid credential, and uses `userStore(env, id)` to read back stored rows. Reuse both.

## Commands you will need

These come from `package.json` and `.github/workflows/ci.yml`. They were not run in the planning session, because the planning worktree had no installed dependencies.

| Purpose           | Command                                                                          | Expected on success |
| ----------------- | -------------------------------------------------------------------------------- | ------------------- |
| Install           | `pnpm install`                                                                   | exit 0              |
| Build view bundle | `pnpm run build:apps`                                                            | exit 0              |
| Push tests only   | `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` | all pass            |
| Typecheck         | `pnpm run typecheck`                                                             | exit 0, no errors   |
| Lint              | `pnpm run lint`                                                                  | exit 0              |
| Format check      | `pnpm run format:check`                                                          | exit 0              |
| Full Worker suite | `pnpm test`                                                                      | all pass            |

The Worker test project loads the whole Worker, which imports a built view bundle. Always run `pnpm run build:apps` before `vitest` in a fresh checkout, or the run fails on a missing `build/mcp-apps/garmin-app.html`.

## Scope

**In scope** (the only files you should modify):

- `src/push/schemas.ts`
- `test/push.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/push/handler.ts` — it must keep using `startTimeInSeconds` alone for its start-time replacement logic. Measurement records are keyed by `summaryId`, which is already correct.
- `src/push/store.ts` and `src/events/store.ts` — no change is needed; an event ID already falls back to `summaryId` when there is no start time.
- `src/garmin-api/**` — generated code, never hand-edited.
- `test/events.test.ts` — its `bodyComps` fixture uses a synthetic shape. Leave it; see Maintenance notes.

## Git workflow

- Branch: `advisor/001-accept-measurement-time-summaries`
- One commit. Message style matches the repo's history, for example `Fix e2e host typecheck and record local CI evidence`. Suggested: `Accept Garmin body composition and blood pressure deliveries`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add failing tests that use Garmin's real record shapes

In `test/push.test.ts`, add two tests after the test named `"uses the provider calendar date or device offset, including nested activity details"` (it starts at line 167).

Test A, an integration test through the receiver:

```ts
it("stores body composition and blood pressure deliveries by their measurement time", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  // Shapes follow ClientBodyComp and ClientBloodPressure in docs/garmin-wellness-openapi.json.
  const delivered = await push({
    bodyComps: [
      {
        userId: id,
        summaryId: "weight-1",
        measurementTimeInSeconds: 1792713600,
        measurementTimeOffsetInSeconds: -25200,
        weightInGrams: 70500,
      },
    ],
    bloodPressures: [
      {
        userId: id,
        summaryId: "pressure-1",
        measurementTimeInSeconds: 1792713600,
        measurementTimeOffsetInSeconds: 3600,
        systolic: 120,
        diastolic: 80,
      },
    ],
  });

  expect(delivered.status).toBe(200);

  const weights = await store.list("bodyComps", "2026-10-22", "2026-10-22", 50, 0);
  expect(weights.records).toHaveLength(1);
  expect(weights.records[0]?.summaryJSON).toContain('"weightInGrams":70500');

  const pressures = await store.list("bloodPressures", "2026-10-23", "2026-10-23", 50, 0);
  expect(pressures.records).toHaveLength(1);
  expect(pressures.records[0]?.summaryJSON).toContain('"systolic":120');
});
```

Why those dates: `1792713600` is `2026-10-23T00:00:00Z`. With an offset of `-25200` seconds (UTC−7) the device-local date is `2026-10-22`. With `+3600` it is `2026-10-23`.

Test B, to keep the "a record needs some date" rule:

```ts
it("still rejects a summary that has no date, start time or measurement time", async () => {
  expect((await push({ bodyComps: [{ userId: "a", summaryId: "no-time" }] })).status).toBe(400);
});
```

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → Test A **fails** with `expected 400 to be 200`. Test B passes. All other tests pass. If Test A already passes, that is a STOP condition.

### Step 2: Teach the envelope schema about measurement time

In `src/push/schemas.ts`, change the `summary` schema:

1. Add two optional fields to the `z.looseObject({...})`, after `startTimeOffsetInSeconds`:

   ```ts
   measurementTimeInSeconds: z.number().int().nonnegative().optional(),
   measurementTimeOffsetInSeconds: z.number().int().min(-86400).max(86400).optional(),
   ```

2. Extend the `.refine` predicate so a measurement time also satisfies it, and update its message:

   ```ts
   .refine(
     (value) =>
       value.calendarDate !== undefined ||
       value.startTimeInSeconds !== undefined ||
       value.measurementTimeInSeconds !== undefined ||
       value.summary,
     { message: "Summary requires a calendar date, start time or measurement time." },
   );
   ```

**Verify**: `pnpm run typecheck` → exit 0.

### Step 3: Derive the stored date from the measurement time

In `src/push/schemas.ts`, change only the two `const` lines inside `summaryDate`. Append the measurement fields as the last fallback before `0`:

```ts
const seconds =
  value.startTimeInSeconds ??
  value.summary?.startTimeInSeconds ??
  value.measurementTimeInSeconds ??
  0;

const offset =
  value.startTimeOffsetInSeconds ??
  value.summary?.startTimeOffsetInSeconds ??
  value.measurementTimeOffsetInSeconds ??
  0;
```

Keep the existing order of the first two fallbacks exactly as it is.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → all pass, including Test A and Test B.

### Step 4: Run the full gates

**Verify**:

- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm run format:check` → exit 0 (if it reports your two files, run `pnpm exec oxfmt --write src/push/schemas.ts test/push.test.ts` and re-check)
- `pnpm test` → all pass

## Test plan

- New tests in `test/push.test.ts`: Test A (real `bodyComps` and `bloodPressures` shapes are accepted and stored under the device-local measurement date) and Test B (a record with no time field is still rejected).
- Structural pattern: the existing test `"persists idempotent updates and separates Garmin accounts across eviction"` in the same file (line 45).
- Verification: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → all pass, including the 2 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` exits 0
- [ ] `pnpm test` exits 0; the two new tests exist and pass
- [ ] `grep -n "measurementTimeInSeconds" src/push/schemas.ts` returns at least 3 matches
- [ ] `git status --porcelain` lists only `src/push/schemas.ts`, `test/push.test.ts` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- Test A passes before you change `src/push/schemas.ts` (the bug is already fixed or the test is wrong).
- Any existing test in `test/push.test.ts`, `test/summaries.test.ts` or `test/events.test.ts` fails after Step 3 and one reasonable fix attempt does not resolve it.
- The fix appears to require a change in `src/push/handler.ts` or `src/push/store.ts`.

## Maintenance notes

- `test/events.test.ts:775` builds its `bodyComps` fixture by spreading a sleep record, so it still uses a shape Garmin does not send. It keeps passing. A follow-up could switch it to the real shape to prove the `garmin.body_composition.recorded` event end to end.
- `src/garmin-api/wellness/zod.gen.ts` contains generated schemas for every Garmin summary type (`zClientBodyComp`, `zClientBloodPressure`, and others) and nothing imports them. A follow-up could build one fixture per category from those schemas and push each through the receiver, which would catch this class of bug for all 19 categories.
- A reviewer should check that measurement records are not given a `startTime` in `src/push/handler.ts`. Two measurements at the same second must both be kept.
