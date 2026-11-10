# Plan 002: Every rejected Garmin delivery leaves a fixed-label log line

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3fe4c9f..HEAD -- src/push/handler.ts test/push.test.ts`
> If `src/push/handler.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Changes to `test/push.test.ts`
> from Plan 001 are expected and are not drift.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (Plan 001 touches the same test file; apply after it if both are in flight)
- **Category**: dx
- **Planned at**: commit `3fe4c9f`, 2026-11-10

## Why this matters

The Garmin webhook answers a malformed delivery with a bare `400` or `415` and writes nothing to the logs. Automatic invocation logs are switched off on purpose (`cloudflare.config.ts`), because the delivery URL contains a credential. The result is that a whole category of Garmin data can be rejected forever and the operator has no signal. That is how the body composition bug in Plan 001 stayed invisible. After this plan, each rejection writes one log line made only of fixed labels: the event name, a reason, and the Garmin category key. It never contains a URL, a user ID, a summary ID or a payload value.

## Current state

- `src/push/handler.ts` — the webhook receiver `receivePush`. Every rejection is a bare `new Response(null, { status })`.
- `src/index.ts` — the exemplar for a fixed-label log line.
- `src/events/diagnostics.ts` — the exemplar for a typed, redacted diagnostic helper.
- `test/push.test.ts` — Worker tests for the receiver. New tests go here.

The rejection sites today in `src/push/handler.ts`:

```ts
// lines 35-47
if (!validPushCredential(credential, env.GARMIN_PUSH_TOKEN)) {
  return new Response(null, { status: 404 });
}

if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
  return new Response(null, { status: 415 });
}

const body = pushPayload.safeParse(await request.json().catch(() => null));

if (!body.success) {
  return new Response(null, { status: 400 });
}
```

```ts
// lines 54-61, inside `for (const [type, values] of Object.entries(body.data))`
if (type === "activityFiles") {
  const parsed = activityFileNotification.safeParse(value);

  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }
```

```ts
// lines 69-81
if (type === "deregistrations" || type === "userPermissionsChange") {
  const parsed = notification.safeParse(value);

  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }

  if (
    type === "userPermissionsChange" &&
    (!parsed.data.permissions || parsed.data.changeTimeInSeconds === undefined)
  ) {
    return new Response(null, { status: 400 });
  }
```

```ts
// lines 96-100
const parsed = summary.safeParse(value);

if (!parsed.success) {
  return new Response(null, { status: 400 });
}
```

The logging exemplar, `src/index.ts:10-12`:

```ts
// No URLs: the Garmin delivery route contains a private credential.
// oxlint-disable-next-line no-console -- Workers Logs receives only this fixed event name.
console.error(JSON.stringify({ event: "request_failed" }));
```

Facts you need:

- `type` in the loop is a key of the request body. `pushPayload` (in `src/push/schemas.ts:82-91`) is a `z.partialRecord` over a fixed `z.enum` of category names, so after `body.success` every `type` is one of a fixed list such as `bodyComps` or `activityFiles`. It is safe to log.
- `console` calls need the `oxlint-disable-next-line no-console -- <reason>` comment shown above, or lint fails.
- The privacy rule for this repo, from `src/events/diagnostics.ts:55`: "Only domain diagnostics: never accept raw payloads, URLs, identities, or errors."

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

- `src/push/handler.ts`
- `test/push.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- The `404` for a wrong credential. Do NOT log it. An unauthenticated caller could otherwise fill the logs at will.
- `purgeUser` in the same file. Its `401` and `400` stay as they are.
- `cloudflare.config.ts` — invocation logs and traces stay disabled.
- Response statuses and bodies. This plan adds log lines only; every status code stays exactly the same.

## Git workflow

- Branch: `advisor/002-log-rejected-garmin-deliveries`
- One commit. Suggested message: `Log rejected Garmin deliveries with fixed labels`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add failing tests

In `test/push.test.ts`, add `vi` to the existing `vitest` import (`import { expect, it } from "vitest";` becomes `import { expect, it, vi } from "vitest";`). Then add this test at the end of the file:

```ts
it("logs each rejected delivery with fixed labels and no delivered values", async () => {
  const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
  const id = `private-${crypto.randomUUID()}`;

  await push({
    sleeps: [{ userId: id, summaryId: "private-summary", calendarDate: "not-a-date" }],
  });
  await push({ activityFiles: [{ userId: id, callbackURL: "https://evil.example/file" }] });
  await push({ unknownCategory: [] });
  await push({ dailies: [{ userId: id, summaryId: "ok", calendarDate: "2026-10-23" }] });
  await push({ dailies: [] }, "wrong-credential");

  const lines = logs.mock.calls.map(([line]) => String(line));
  logs.mockRestore();

  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { event: "garmin_push_rejected", reason: "invalid_record", type: "sleeps" },
    { event: "garmin_push_rejected", reason: "invalid_record", type: "activityFiles" },
    { event: "garmin_push_rejected", reason: "invalid_payload" },
  ]);
  expect(lines.join("\n")).not.toContain("private-");
  expect(lines.join("\n")).not.toContain("evil.example");
});
```

This asserts five things: an invalid record is logged with its category, an unknown payload is logged without one, an accepted delivery logs nothing, a wrong credential logs nothing, and no delivered value reaches the log.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → the new test **fails** because `lines` is empty. All other tests pass.

### Step 2: Add the rejection helper

In `src/push/handler.ts`, add this above `receivePush`:

```ts
type PushRejection = "content_type" | "invalid_payload" | "invalid_record";

/** Invocation logs are disabled, so this is the only trace of a refused delivery. Labels only:
 * never URLs, account or summary IDs, or payload values. `type` is a key of the validated payload enum.
 */
function rejected(status: number, reason: PushRejection, type?: string): Response {
  // oxlint-disable-next-line no-console -- Workers Logs receives only these fixed labels.
  console.warn(
    JSON.stringify({ event: "garmin_push_rejected", reason, ...(type ? { type } : {}) }),
  );

  return new Response(null, { status });
}
```

**Verify**: `pnpm run typecheck` → exit 0 (an "unused function" lint finding at this point is expected and is resolved in Step 3).

### Step 3: Use it at every rejection after the credential check

In `receivePush`, replace the bare responses as follows. Do not change any status code.

| Location (see "Current state")                        | Replace with                                    |
| ----------------------------------------------------- | ----------------------------------------------- |
| Content-Type check, `status: 415`                     | `return rejected(415, "content_type");`         |
| `if (!body.success)`, `status: 400`                   | `return rejected(400, "invalid_payload");`      |
| `activityFiles` record fails, `status: 400`           | `return rejected(400, "invalid_record", type);` |
| `notification.safeParse` fails, `status: 400`         | `return rejected(400, "invalid_record", type);` |
| `userPermissionsChange` missing fields, `status: 400` | `return rejected(400, "invalid_record", type);` |
| `summary.safeParse` fails, `status: 400`              | `return rejected(400, "invalid_record", type);` |

Leave the first `return new Response(null, { status: 404 });` (wrong credential) untouched.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → all pass, including the new test.

**Verify**: `grep -c "new Response(null, { status: 400 })" src/push/handler.ts` → `1` (the one remaining is inside `purgeUser`).

### Step 4: Run the full gates

**Verify**:

- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm run format:check` → exit 0 (if it reports your files, run `pnpm exec oxfmt --write src/push/handler.ts test/push.test.ts` and re-check)
- `pnpm test` → all pass

## Test plan

- One new test in `test/push.test.ts`, shown in Step 1. It covers: an invalid summary record, an invalid file notification, an unknown payload key, silence on success, silence on a wrong credential, and redaction.
- Structural pattern for the console spy: `test/events.test.ts:49` (`vi.spyOn(console, "info").mockImplementation(() => {})`).
- Verification: `pnpm run build:apps && pnpm exec vitest run --project worker test/push.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` exits 0
- [ ] `pnpm test` exits 0; the new test exists and passes
- [ ] `grep -c "garmin_push_rejected" src/push/handler.ts` returns `1`
- [ ] `grep -c "rejected(4" src/push/handler.ts` returns `6`
- [ ] `git status --porcelain` lists only `src/push/handler.ts`, `test/push.test.ts` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The rejection sites in `src/push/handler.ts` don't match the excerpts in "Current state".
- An existing test asserts that nothing is written to `console.warn` during a rejected delivery and now fails.
- You find yourself wanting to log anything other than the three fields `event`, `reason` and `type`.
- Lint rejects the helper for a reason other than formatting or blank-line spacing, and one fix attempt does not resolve it.

## Maintenance notes

- Search Workers Logs for `garmin_push_rejected`. A steady stream for one `type` means Garmin sends a shape the envelope schema refuses. Compare against `docs/garmin-wellness-openapi.json`.
- Plan 005 adds a body size limit to this route. It should reuse `rejected` with a new reason `too_large`.
- A reviewer should confirm that no rejection path interpolates anything from the request into the log line.
