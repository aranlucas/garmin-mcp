# Plan 005: Each route enforces its own request body limit, and the Garmin webhook checks its credential before reading the body

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3fe4c9f..HEAD -- src/app.tsx src/push/handler.ts test/worker.test.ts`
> `src/push/handler.ts` is expected to differ because Plan 002 lands first:
> it must contain a `rejected(status, reason, type?)` helper. If `src/app.tsx`
> changed, or `src/push/handler.ts` differs in any other way from the
> "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-log-rejected-garmin-deliveries.md
- **Category**: bug
- **Planned at**: commit `3fe4c9f`, 2026-11-10

## Why this matters

The app is built with `createMcpHonoApp`, which installs a middleware on every route that reads and parses any JSON body up to 4 MiB. That has three effects nobody chose:

1. The `/mcp` route configures `maxRequestBodySize: 64 * 1024`, but then hands the already-parsed body to the MCP handler. When a parsed body is supplied, the handler skips its own size check. The real `/mcp` limit is 4 MiB, not 64 KiB.
2. The Garmin webhook's limit is that same 4 MiB. Garmin activity-detail deliveries carry one sample per second of recording, so a long activity can exceed it. Such a delivery is answered `413` by the middleware, is never stored, and leaves no log line.
3. The webhook body is read and parsed before the delivery credential is checked, and then read and parsed a second time by the receiver.

After this plan, `/mcp` really is limited to 64 KiB, the webhook checks its credential first and reads the body once under its own explicit limit, and an oversized delivery is logged.

## Current state

- `src/app.tsx` — builds the Hono app and registers every route.
- `src/push/handler.ts` — `receivePush`, the webhook receiver.
- `src/index.ts` — the Worker entry. It imports `{ app }` from `./app` and calls `app.fetch`. Do not change it.
- `test/worker.test.ts` — HTTP-level tests that go through the Worker entry. New tests go here.

App construction today, `src/app.tsx:21-25`:

```ts
// One router for both OAuth dispatch paths; credentials remain request-local.
export const app = createMcpHonoApp({
  host: new URL(env.PUBLIC_URL).hostname,
  maxRequestBodySize: 4 * 1024 * 1024,
}).use<AppBindings>(jsxRenderer());
```

Webhook routes today, `src/app.tsx:75-82`:

```ts
app.post("/webhook/garmin/:credential", (c) =>
  receivePush(c.req.raw, c.env, c.req.param("credential")),
);

// Keep existing Garmin configurations and queued deliveries working during migration.
app.post("/garmin/push/:credential", (c) =>
  receivePush(c.req.raw, c.env, c.req.param("credential")),
);
```

The end of the `/mcp` route today, `src/app.tsx:114-122`:

```ts
const handler = createMcpHandler(
  () => createServer(accessToken, store, fetch, { subject: userId, garminUserId }),
  {
    maxRequestBodySize: 64 * 1024,
  },
);

return handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
```

The end of the file today, `src/app.tsx:124-130`:

```ts
app.notFound(() => new Response("Not found", { status: 404 }));

app.onError((error) => {
  // Unexpected errors reach the Worker's redacted logger, not Hono's default logger.
  throw error;
});
```

The receiver's body handling today (after Plan 002), in `src/push/handler.ts`:

```ts
if (!validPushCredential(credential, env.GARMIN_PUSH_TOKEN)) {
  return new Response(null, { status: 404 });
}

if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
  return rejected(415, "content_type");
}

const body = pushPayload.safeParse(await request.json().catch(() => null));

if (!body.success) {
  return rejected(400, "invalid_payload");
}
```

How the two libraries behave. This was read from `@modelcontextprotocol/hono@2.0.2` and `@modelcontextprotocol/server@2.3.1`; this repo pins server `2.4.0`, so Step 1 re-checks it.

- `createMcpHonoApp` registers `app.use("*", ...)`. For a request whose `Content-Type` is JSON it calls `parseJsonBody(c.req.raw.clone(), maxRequestBodySize)`, answers `413` when the body is too large, answers `400 "Invalid JSON"` when it does not parse, and otherwise stores the value with `c.set("parsedBody", ...)`. It reads a clone, so `c.req.raw` stays readable.
- The MCP handler only reads and size-checks the body when no parsed body was passed in: `if (options?.parsedBody === void 0) { const body = await readRequestBody(req, this._maxRequestBodySize); if (body.tooLarge) ... }`.
- `@modelcontextprotocol/server` exports `readRequestBody(request, maxBytes)`. It resolves to `{ tooLarge: true }` or `{ tooLarge: false, text }`.

Conventions that apply:

- `AGENTS.md`: "Before hand-writing general-purpose code, use a well-maintained library ... Reach for one already in the dependencies first." Use the SDK's `readRequestBody` for the bounded read; do not write a new stream reader.
- Hono runs matching handlers in registration order. A handler that returns a response without calling `next()` ends the chain, so a route registered before a middleware is not affected by it.
- `hono` is a direct dependency (`package.json`), so `import { Hono } from "hono"` is allowed.
- `console` calls need an `oxlint-disable-next-line no-console -- <reason>` comment. Plan 002's `rejected` helper already has one; reuse the helper.

## Commands you will need

These come from `package.json` and `.github/workflows/ci.yml`. They were not run in the planning session.

| Purpose           | Command                                                                                              | Expected on success |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------- |
| Install           | `pnpm install`                                                                                       | exit 0              |
| HTTP tests only   | `pnpm run build:apps && pnpm exec vitest run --project worker test/worker.test.ts test/push.test.ts` | all pass            |
| Typecheck         | `pnpm run typecheck`                                                                                 | exit 0, no errors   |
| Lint              | `pnpm run lint`                                                                                      | exit 0              |
| Format check      | `pnpm run format:check`                                                                              | exit 0              |
| Full Worker suite | `pnpm test`                                                                                          | all pass            |
| Production build  | `pnpm run build`                                                                                     | exit 0              |

Always run `pnpm run build:apps` before `vitest` in a fresh checkout.

## Scope

**In scope** (the only files you should modify):

- `src/app.tsx`
- `src/push/handler.ts`
- `test/worker.test.ts`
- `README.md` (one sentence, Step 6)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/index.ts` — the Worker entry and its redacted error logger.
- `purgeUser` and the `/garmin/disconnect` route. It stays behind the adapter middleware.
- The pages, icon, health and OAuth metadata routes. They only move with the rest of the existing app; their behavior must not change.
- Storage. A single summary larger than SQLite's per-value limit is a separate, unplanned finding (see Maintenance notes). Do not add chunking or size checks in `src/push/store.ts`.
- `cloudflare.config.ts` — logging configuration stays as it is.

## Git workflow

- Branch: `advisor/005-enforce-per-route-body-limits`
- Two commits are fine: one for `/mcp`, one for the webhook. Suggested messages: `Enforce the 64 KiB body limit on /mcp` and `Check the Garmin delivery credential before reading its body`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the library behavior in the installed versions

Run:

- `grep -n "parsedBody === void 0" node_modules/@modelcontextprotocol/server/dist/index.mjs` → at least one match, next to a `readRequestBody(` call.
- `grep -n "readRequestBody" node_modules/@modelcontextprotocol/server/dist/index.d.mts` → at least one match (it is exported).
- `grep -n 'app.use("\*", async (c, next)' node_modules/@modelcontextprotocol/hono/dist/index.mjs` → one match.

**Verify**: all three commands print matches. If the second prints nothing, see STOP conditions.

### Step 2: Add failing tests

In `test/worker.test.ts`, add the following tests after the test titled `"accepts and durably stores Garmin delivery at %s"`. They use the file's existing helpers `send(path, init, config)`, `bindings(token)`, `jwt()`, `jwk`, and `env`.

```ts
it("rejects an /mcp body over 64 KiB", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(Response.json({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] })),
    ),
  );

  const config = bindings({
    accessToken: "private-garmin-token",
    expiresAt: Date.now() + 3600000,
    garminUserId: "garmin-alice",
  });

  const response = await send(
    "/mcp",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await jwt()}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { padding: "x".repeat(100 * 1024) },
      }),
    },
    config,
  );

  expect(response.status).toBe(413);
});

it("checks the Garmin delivery credential before reading the body", async () => {
  const response = await send("/webhook/garmin/wrong", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });

  expect(response.status).toBe(404);
});

it("accepts a Garmin delivery larger than 4 MiB and refuses one over the delivery limit", async () => {
  const id = crypto.randomUUID();
  const path = `/webhook/garmin/${env.GARMIN_PUSH_TOKEN}`;
  const headers = { "Content-Type": "application/json" };

  // 60 records of about 90 KiB each: a large delivery made of ordinary-sized rows.
  const dailies = Array.from({ length: 60 }, (_, index) => ({
    userId: id,
    summaryId: `large-${index}`,
    calendarDate: "2026-10-23",
    padding: "x".repeat(90 * 1024),
  }));

  const large = JSON.stringify({ dailies });
  expect(large.length).toBeGreaterThan(4 * 1024 * 1024);

  const accepted = await send(path, { method: "POST", headers, body: large });
  expect(accepted.status).toBe(200);
  expect(await userStore(env, id).get("dailies", "large-59")).not.toBeNull();

  const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
  const tooLarge = JSON.stringify({ dailies: [{ padding: "x".repeat(8 * 1024 * 1024) }] });
  const refused = await send(path, { method: "POST", headers, body: tooLarge });
  const lines = logs.mock.calls.map(([line]) => String(line));
  logs.mockRestore();

  expect(refused.status).toBe(413);
  expect(lines).toEqual([JSON.stringify({ event: "garmin_push_rejected", reason: "too_large" })]);
});
```

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/worker.test.ts` → the three new tests **fail** as follows, and all existing tests pass:

- the `/mcp` test gets a status other than `413` (the oversized request is processed);
- the credential test gets `400`, not `404`;
- the large-delivery test gets `413`, not `200`, at its first status check.

If the `/mcp` test already passes, the installed SDK enforces the limit itself. Keep the test, skip Step 3, and say so in your report.

### Step 3: Let the MCP handler enforce its own limit

In `src/app.tsx`, change the last line of the `/mcp` route from

```ts
return handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
```

to

```ts
// No parsedBody: the handler skips its 64 KiB check when it is handed an already-parsed body.
return handler.fetch(c.req.raw);
```

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/worker.test.ts` → the `/mcp` test passes; every test that passed before still passes.

### Step 4: Register the webhook routes ahead of the adapter middleware

In `src/app.tsx`:

1. Add `import { Hono } from "hono";`.
2. Rename the existing `createMcpHonoApp(...)` constant from `app` to `site`, and stop exporting it. Rename every `app.` call that registers a page, metadata, redirect, `/garmin/disconnect` or `/mcp` route to `site.`. Update the comment above it:

   ```ts
   // Pages, metadata, disconnect and /mcp. The adapter parses JSON bodies up to 4 MiB for these routes.
   const site = createMcpHonoApp({
     host: new URL(env.PUBLIC_URL).hostname,
     maxRequestBodySize: 4 * 1024 * 1024,
   }).use<AppBindings>(jsxRenderer());
   ```

3. Delete the two webhook `post` registrations from their current place.
4. At the end of the file, replace the existing `notFound` and `onError` registrations with a new root app that registers the webhook routes first:

   ```ts
   // Garmin deliveries are registered before the adapter's JSON middleware, so the credential is
   // checked before any body is read and the receiver applies its own limit.
   export const app = new Hono<AppBindings>();

   app.post("/webhook/garmin/:credential", (c) =>
     receivePush(c.req.raw, c.env, c.req.param("credential")),
   );

   // Keep existing Garmin configurations and queued deliveries working during migration.
   app.post("/garmin/push/:credential", (c) =>
     receivePush(c.req.raw, c.env, c.req.param("credential")),
   );

   app.route("/", site);

   app.notFound(() => new Response("Not found", { status: 404 }));

   app.onError((error) => {
     // Unexpected errors reach the Worker's redacted logger, not Hono's default logger.
     throw error;
   });
   ```

**Verify**: `pnpm run typecheck` → exit 0.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/worker.test.ts` → the credential test now passes; all previously passing tests still pass (the large-delivery test may still fail until Step 5).

### Step 5: Read the delivery once, under an explicit limit

In `src/push/handler.ts`:

1. Add `import { readRequestBody } from "@modelcontextprotocol/server";`.
2. Add `"too_large"` to the `PushRejection` union from Plan 002.
3. Add an exported constant above `receivePush`:

   ```ts
   /** Twice the 4 MiB the router used to impose by accident. Garmin's largest real delivery is not
    * known; search Workers Logs for `garmin_push_rejected` with reason `too_large` before raising it.
    */
   export const MAX_PUSH_BYTES = 8 * 1024 * 1024;
   ```

4. Replace the two statements that parse the body (`const body = pushPayload.safeParse(await request.json()...)` and its `if (!body.success)` block) with:

   ```ts
   const read = await readRequestBody(request, MAX_PUSH_BYTES);

   if (read.tooLarge) {
     return rejected(413, "too_large");
   }

   let body: ReturnType<typeof pushPayload.safeParse>;

   try {
     body = pushPayload.safeParse(JSON.parse(read.text));
   } catch {
     return rejected(400, "invalid_payload");
   }

   if (!body.success) {
     return rejected(400, "invalid_payload");
   }
   ```

   The credential check and the Content-Type check stay above this, in their current order.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/worker.test.ts test/push.test.ts` → all pass, including the three new tests.

### Step 6: Record the limits where operators read

In `README.md`, in the "Architecture" section, find the paragraph that starts "Garmin's endpoint configuration supports URLs". Append this sentence to the end of that paragraph:

```
Deliveries are limited to 8 MiB and `/mcp` requests to 64 KiB; a larger delivery is refused with `413` and logged as `garmin_push_rejected` with reason `too_large`.
```

**Verify**: `grep -c "garmin_push_rejected" README.md` → `1`.

### Step 7: Run the full gates

**Verify**:

- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm run format:check` → exit 0 (if it reports your files, run `pnpm exec oxfmt --write` on those files and re-check)
- `pnpm test` → all pass
- `pnpm run build` → exit 0

## Test plan

- Three new tests in `test/worker.test.ts`, shown in Step 2: the `/mcp` limit, credential-before-body, and the delivery limit with its log line.
- Structural pattern: the existing test `"accepts and durably stores Garmin delivery at %s"` for webhook requests, and `"checks Auth exchange-shaped tokens with $name"` for an authenticated `/mcp` request, both in the same file.
- These tests must go through `send()`, which calls the Worker entry. Calling `receivePush` directly would bypass the router and prove nothing about route order.
- Verification: `pnpm run build:apps && pnpm exec vitest run --project worker test/worker.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` exits 0
- [ ] `pnpm test` exits 0; the three new tests exist and pass
- [ ] `pnpm run build` exits 0
- [ ] `grep -c "parsedBody" src/app.tsx` returns `1` (only the explanatory comment remains)
- [ ] `grep -c "request.json()" src/push/handler.ts` returns `1` (only `purgeUser` still uses it)
- [ ] `grep -c "MAX_PUSH_BYTES" src/push/handler.ts` returns `2`
- [ ] `git status --porcelain` lists only the five in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/app.tsx` doesn't match the excerpts in "Current state", or `src/push/handler.ts` has no `rejected` helper (Plan 002 has not landed).
- `readRequestBody` is not exported by the installed `@modelcontextprotocol/server` (Step 1, second command). Do not write a replacement reader without asking.
- After Step 4, any page, metadata, redirect or `/mcp` test that passed before now fails, and one fix attempt does not resolve it. That means mounting `site` under the root app changed routing in a way this plan did not expect.
- After Step 4, an unknown path no longer returns `404 "Not found"`, or an unexpected error no longer reaches the `request_failed` logger in `src/index.ts`.
- The accepted large delivery in the Step 2 test fails inside the store rather than at the router (for example a storage error instead of `413`). That is the separate oversized-record finding; report it.

## Maintenance notes

- `MAX_PUSH_BYTES` is an informed guess, not a Garmin-documented figure. Watch for `garmin_push_rejected` / `too_large` after deploying and adjust.
- Not addressed here: a **single** summary whose JSON exceeds SQLite's per-value limit makes the whole `ingest` transaction fail, so Garmin retries the same batch forever. Decoded FIT files are already split into 64 KiB chunks for this reason (`src/activity/store.ts:21`); stored summaries are not. This needs a product decision (chunk large summaries, or drop them with a log line) before it can be planned.
- `/mcp` bodies are still parsed once by the adapter middleware before authentication, up to 4 MiB, and then read again by the handler. Moving `/mcp` to the root app would remove that, but changes more than this plan should.
- A reviewer should check the route order in `src/app.tsx`: the two webhook routes must be registered before `app.route("/", site)`.
