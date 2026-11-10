# Plan 003: Stored-data tools say what actually failed, and never suggest reconnecting for a temporary fault

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3fe4c9f..HEAD -- src/mcp.ts src/activity/mcp.ts src/tool-result.ts test/summaries.test.ts`
> If any of these files changed since this plan was written, compare the
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

Four tools read stored Garmin data: `get_garmin_day`, `list_garmin_summaries`, `get_garmin_summary` and `get_garmin_activity`. Each one first asks Garmin for the user's current sharing permissions. Each one catches every possible failure and returns one fixed sentence that ends in "Reconnect Garmin in Auth and try again." That sentence is wrong for a rate limit, a timeout, a Garmin outage, or an internal storage error. It is also dangerous: disconnecting Garmin in Auth purges the user's stored history, and this connector cannot backfill it. A user who follows the advice during a short Garmin outage can destroy their data. After this plan, each failure class has its own fixed, safe sentence, and only a real permission or credential problem mentions reconnecting.

## Current state

- `src/mcp.ts` — registers the MCP server and three of the four read tools. Contains the `permitted` helper and three identical catch blocks.
- `src/activity/mcp.ts` — registers `get_garmin_activity`. Contains the fourth catch block.
- `src/tool-result.ts` — `toolResult` and `toolError`. The new mapping goes here.
- `src/garmin-error.ts` — `GarminError`, an `Error` with a numeric `status`. Every failed Garmin HTTP call already throws it.
- `src/training/client.ts` — `TrainingClient.getPermissions` (the permission lookup). It imports `GarminError` under the name `TrainingError`.
- `test/summaries.test.ts` — protocol-level tests for the read tools. New tests go here.

`src/garmin-error.ts` in full:

```ts
/** Only safe messages leave this boundary; upstream bodies can contain personal data. */
export class GarminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
```

Statuses that the permission lookup can throw (`src/training/client.ts:21-64` and `:75-108`):

| `status`          | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `401`             | Garmin rejected the access token                              |
| `403`, `412`      | Garmin refused the request for missing permission or approval |
| `429`             | Garmin rate limit                                             |
| `499`             | the MCP request was cancelled by the client                   |
| `502`             | network failure, timeout, or an unreadable Garmin response    |
| any other non-2xx | passed through from Garmin, for example `500` or `503`        |

The permission helper today, `src/mcp.ts:79-87`:

```ts
async function permitted(type: z.infer<typeof summaryType>, signal: AbortSignal) {
  const permissions = await client.getPermissions(signal);

  const needed = summaryPermission(type);

  if (!permissions.includes(needed)) {
    throw new Error(`Garmin ${needed} permission is missing. Reconnect Garmin in Auth.`);
  }
}
```

The four catch blocks today:

```ts
// src/mcp.ts:118-122 (get_garmin_day)
} catch {
  return toolError(
    "Garmin day data is unavailable. Check your connection and permissions in Auth and try again.",
  );
}
```

```ts
// src/mcp.ts:158-162 (list_garmin_summaries) and src/mcp.ts:193-197 (get_garmin_summary), identical
} catch {
  return toolError(
    "Garmin data is unavailable or permission was withdrawn. Reconnect Garmin in Auth and try again.",
  );
}
```

```ts
// src/activity/mcp.ts:81-85 (get_garmin_activity)
} catch {
  return toolError(
    "Garmin activity is unavailable or permission was withdrawn. Reconnect Garmin in Auth and try again.",
  );
}
```

The convention to match, from `src/training/mcp.ts:71-78`. The Training tools already branch on the error class and only ever return fixed text:

```ts
} catch (error) {
  const message =
    error instanceof TrainingError
      ? error.message
      : "The Garmin Training request failed. Check Garmin Connect before retrying a write.";

  return toolError(message);
}
```

Rules that apply:

- `src/tool-result.ts:16`: "Fixed, actionable messages only; never upstream bodies or validation issues." Never return `error.message` from these four tools. The permission lookup's own messages say "Garmin Training…", which is wrong for a health read. Map by `status` instead.
- Lint forbids function parameters typed `unknown` (rule `anti-slop/no-unknown-parameters`). Do the `instanceof GarminError` check inside the `catch` block and pass a `number | undefined` to the helper.
- Tests follow `AGENTS.md`: assert an independently justified result, and "Do not reproduce implementation logic in assertions or mocks." Assert on short key phrases, not on whole sentences copied from the implementation.

## Commands you will need

These come from `package.json` and `.github/workflows/ci.yml`. They were not run in the planning session.

| Purpose           | Command                                                                                                     | Expected on success |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| Install           | `pnpm install`                                                                                              | exit 0              |
| Read-tool tests   | `pnpm run build:apps && pnpm exec vitest run --project worker test/summaries.test.ts test/activity.test.ts` | all pass            |
| Typecheck         | `pnpm run typecheck`                                                                                        | exit 0, no errors   |
| Lint              | `pnpm run lint`                                                                                             | exit 0              |
| Format check      | `pnpm run format:check`                                                                                     | exit 0              |
| Full Worker suite | `pnpm test`                                                                                                 | all pass            |

Always run `pnpm run build:apps` before `vitest` in a fresh checkout.

## Scope

**In scope** (the only files you should modify):

- `src/tool-result.ts`
- `src/mcp.ts`
- `src/activity/mcp.ts`
- `test/summaries.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/training/mcp.ts` and `src/training/client.ts` — the Training tools already report distinct errors. Their wording is a separate concern.
- The `garmin://account` resource error in `src/mcp.ts:52-57`. `test/account.test.ts` pins its exact text.
- `delete_stored_garmin_data` — it has no permission lookup and no catch block.
- `test/mcp-apps.browser.test.ts` — it uses its own fixture error text and does not depend on the server wording.
- Successful results. Only the text of error results changes.

## Git workflow

- Branch: `advisor/003-truthful-read-tool-errors`
- One commit. Suggested message: `Report distinct causes when a stored Garmin read fails`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add failing tests

In `test/summaries.test.ts`, add this test at the end of the file. It reuses the file's `connect(garminId, permissions)` helper, which returns `{ client, store, fetcher }`. `fetcher` is a `vi.fn` that answers the Garmin permission lookup.

```ts
it.each([
  {
    name: "a Garmin rate limit",
    reply: () => Promise.resolve(new Response(null, { status: 429 })),
    says: "rate limit",
    reconnect: false,
  },
  {
    name: "a Garmin outage",
    reply: () => Promise.resolve(new Response(null, { status: 503 })),
    says: "could not be reached",
    reconnect: false,
  },
  {
    name: "a network failure",
    reply: () => Promise.reject(new Error("private-upstream-error")),
    says: "could not be reached",
    reconnect: false,
  },
  {
    name: "a rejected Garmin token",
    reply: () => Promise.resolve(new Response(null, { status: 401 })),
    says: "expired or was revoked",
    reconnect: true,
  },
])("explains $name without wrongly advising a reconnect", async ({ reply, says, reconnect }) => {
  const { client, fetcher } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);
  const range = { startDate: "2026-10-23", endDate: "2026-10-23" };

  const calls = [
    { name: "get_garmin_day", arguments: { date: "2026-10-23" } },
    { name: "list_garmin_summaries", arguments: { type: "dailies", ...range } },
    { name: "get_garmin_summary", arguments: { type: "dailies", summaryId: "any" } },
    { name: "get_garmin_activity", arguments: { activityId: "123" } },
  ];

  for (const call of calls) {
    fetcher.mockImplementationOnce(reply);
    // oxlint-disable-next-line no-await-in-loop -- Each tool consumes one queued Garmin reply.
    const text = JSON.stringify(await client.callTool(call));

    expect(text).toContain('"isError":true');
    expect(text).toContain(says);
    expect(/reconnect/i.test(text)).toBe(reconnect);
    expect(text).not.toContain("private-upstream-error");
  }
});

it("names the missing sharing permission instead of a generic failure", async () => {
  const { client } = await connect(crypto.randomUUID(), ["ACTIVITY_EXPORT"]);

  const text = JSON.stringify(
    await client.callTool({
      name: "list_garmin_summaries",
      arguments: { type: "dailies", startDate: "2026-10-23", endDate: "2026-10-23" },
    }),
  );

  expect(text).toContain('"isError":true');
  expect(text).toContain("sharing permission");
});
```

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/summaries.test.ts` → the new tests **fail** (the rate-limit, outage and network cases fail on `toContain(says)` or on the reconnect check). Existing tests pass.

### Step 2: Add the status-to-message mapping

In `src/tool-result.ts`, add below `toolError`:

```ts
const KEEP_CONNECTED = "Stored data is unaffected; do not disconnect Garmin.";

/** One fixed sentence per failure class of a stored-data read. `status` is a GarminError status,
 * or undefined for a failure that did not come from Garmin. Never includes upstream text.
 */
export function readFailure(status: number | undefined): string {
  if (status === 403 || status === 412) {
    return "Garmin sharing permission for this data is not granted. Allow it in Garmin Connect, or reconnect Garmin in Auth to grant it.";
  }

  if (status === 401) {
    return "Garmin access expired or was revoked. Retry once; if it keeps failing, reconnect Garmin in Auth.";
  }

  if (status === 429) {
    return `Garmin's rate limit was reached while checking sharing permissions. Wait a few minutes and retry. ${KEEP_CONNECTED}`;
  }

  if (status === 499) {
    return "The request was cancelled.";
  }

  if (status === undefined) {
    return `Stored Garmin data could not be read right now. Retry shortly. ${KEEP_CONNECTED}`;
  }

  return `Garmin could not be reached to confirm sharing permissions. Retry shortly. ${KEEP_CONNECTED}`;
}
```

**Verify**: `pnpm run typecheck` → exit 0.

### Step 3: Throw a typed error for a missing permission

In `src/mcp.ts`:

1. Add `import { GarminError } from "./garmin-error";`.
2. In `permitted`, replace the `throw new Error(...)` line with:

   ```ts
   throw new GarminError(`Garmin ${needed} permission is missing.`, 403);
   ```

**Verify**: `pnpm run typecheck` → exit 0.

### Step 4: Use the mapping in all four catch blocks

1. In `src/mcp.ts`, change the import from `./tool-result` to also import `readFailure`.
2. Replace each of the three catch blocks shown in "Current state" (`get_garmin_day`, `list_garmin_summaries`, `get_garmin_summary`) with:

   ```ts
   } catch (error) {
     return toolError(readFailure(error instanceof GarminError ? error.status : undefined));
   }
   ```

3. In `src/activity/mcp.ts`, add `import { GarminError } from "../garmin-error";`, add `readFailure` to the existing `../tool-result` import, and replace its catch block with the same three lines.

**Verify**: `grep -rn "permission was withdrawn\|Check your connection and permissions" src/` → no matches.

**Verify**: `pnpm run build:apps && pnpm exec vitest run --project worker test/summaries.test.ts test/activity.test.ts` → all pass, including the new tests.

### Step 5: Run the full gates

**Verify**:

- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm run format:check` → exit 0 (if it reports your files, run `pnpm exec oxfmt --write` on those files and re-check)
- `pnpm test` → all pass

## Test plan

- New tests in `test/summaries.test.ts`, shown in Step 1: four failure classes across all four read tools, and one missing-permission case.
- Structural pattern: the existing test `"distinguishes missing day data from denied permissions: $permissions"` in the same file (line 170) for `it.each`, and line 298 for queuing one Garmin reply.
- Verification: `pnpm run build:apps && pnpm exec vitest run --project worker test/summaries.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` exits 0
- [ ] `pnpm test` exits 0; the new tests exist and pass
- [ ] `grep -rn "permission was withdrawn" src/` returns no matches
- [ ] `grep -c "readFailure(" src/mcp.ts` returns `3` and `grep -c "readFailure(" src/activity/mcp.ts` returns `1`
- [ ] `git status --porcelain` lists only the five in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The catch blocks or the `permitted` helper don't match the excerpts in "Current state".
- An existing test pins one of the old sentences and fails. `grep -rn "permission was withdrawn" test/` found only `test/mcp-apps.browser.test.ts`, which supplies its own fixture text; anything else is unexpected.
- `get_garmin_activity` with `activityId: "123"` on an empty store does not reach the permission lookup first (the new test depends on `access.permitted(signal)` being the first awaited call, as in `src/activity/mcp.ts:62`).
- You are tempted to return `error.message` from any of the four tools.

## Maintenance notes

- If a new stored-data read tool is added, its catch block must use `readFailure` too.
- `README.md` says "Permission lookup failures return a tool error rather than an empty day." That stays true.
- A reviewer should read the six sentences in `readFailure` for tone and accuracy. They are product copy that an assistant relays to the user.
- Deferred: the Training tools still return the permission lookup's "Garmin Training…" wording. That is correct for those tools.
