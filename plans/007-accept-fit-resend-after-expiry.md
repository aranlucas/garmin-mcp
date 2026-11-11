# Plan 007: A re-sent FIT notification replaces an expired or failed file record

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 07e3182..HEAD -- src/activity/store.ts test/activity.test.ts docs/strength-activity-files.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `07e3182`, 2026-11-11

## Why this matters

A FIT callback can expire without being downloaded, for example when the account made no MCP request within 24 hours. A claimed download can also fail for good. Either way, the only recovery Garmin offers is a manual resend from its developer portal. `docs/strength-activity-files.md` and `README.md` both tell operators how to get the `userID` for that resend. The resend arrives as a new `activityFiles` notification for the same `activityId`, with a fresh one-use URL. Today the store silently ignores it, so the activity reports `expired` or `download_failed` forever. The only way out is `delete_stored_garmin_data`, which deletes all of the user's history.

## Current state

`src/activity/store.ts:34-45`:

```ts
  ingest(file: ActivityFileNotification) {
    // Duplicate delivery must neither extend token lifetime nor consume a one-use URL twice.
    this.sql.exec(
      "INSERT OR IGNORE INTO activity_files VALUES (?,?,?,?,?,?,NULL)",
      file.activityId,
      file.summaryId,
      file.fileType === "FIT" ? file.callbackURL : null,
      Date.now() + FILE_WINDOW,
      file.fileType === "FIT" ? "pending" : "unsupported_file_type",
      crypto.randomUUID(),
    );
  }
```

- `expire()` (`:47-57`) sets `state='expired'` with `callback=NULL`, or moves a stale `downloading` claim to `download_failed`.
- `finish()` (`:139-145`) stores `download_failed` when decoding returned null.
- `claim()` (`:92-94`) returns any non-pending state unchanged.
- The duplicate-delivery invariant in the comment must still hold for `pending`, `downloading` and `available` rows. A live URL must never be consumed twice or have its lifetime extended.
- `docs/authorization-retention.md` ("File state and recovery") states: "A thrown post-claim lookup or process crash leaves a consumed claim that becomes unavailable on lease expiry; it is never automatically downloaded again." A resend is not automatic: it carries a new URL, so this rule still holds.

Test pattern: `test/activity.test.ts:378-402` ("expires private callback URLs with the shared alarm..."). It forces `expires_at=0` with `runInDurableObject`, runs `runDurableObjectAlarm`, then reads through `get_garmin_activity`. `pushFiles(id, override)` (`:39-49`) delivers a notification.

## Commands you will need

| Purpose   | Command                                                                                         | Expected |
| --------- | ----------------------------------------------------------------------------------------------- | -------- |
| Typecheck | `pnpm run typecheck`                                                                            | exit 0   |
| Lint      | `pnpm run lint`                                                                                 | exit 0   |
| Tests     | `pnpm exec vitest run --project worker test/activity.test.ts test/credential-retention.test.ts` | all pass |

## Scope

**In scope**: `src/activity/store.ts` (`ingest` only), `test/activity.test.ts`, and one sentence in `docs/strength-activity-files.md`.

**Out of scope**: `claim`, `finish`, `expire`, the alarm schedule, and any automatic retry of a consumed URL.

## Steps

### Step 1: Replace only terminal, URL-less rows

Change the statement to:

```sql
INSERT INTO activity_files VALUES (?,?,?,?,?,?,NULL)
  ON CONFLICT(activity_id) DO UPDATE SET
    summary_id=excluded.summary_id, callback=excluded.callback, expires_at=excluded.expires_at,
    state=excluded.state, version=excluded.version, data=NULL
  WHERE activity_files.callback IS NULL
    AND activity_files.data IS NULL
    AND activity_files.state IN ('expired','download_failed')
```

The new `version` UUID makes any old in-flight `finish()` for that activity a no-op, because `finish` matches on version. Update the comment to say that terminal rows accept a resend.

**Verify**: `pnpm run typecheck` → exit 0.

### Step 2: Tests

In `test/activity.test.ts`:

1. Expire a file, deliver it again with a different `callbackURL` token, and call `get_garmin_activity`. Assert that `fit` is available, and that exactly one file download used the new token and none used the old one.
2. Deliver a second notification while the first is still `pending`. Assert that the stored callback and `expires_at` are unchanged. This keeps the existing invariant.
3. Deliver a second notification after `available`. Assert that the decoded data is retained and nothing is downloaded again.

**Verify**: the tests command above → all pass.

### Step 3: Docs

In `docs/strength-activity-files.md`, under the resend paragraph, add: "A resend replaces only an expired or failed file record; pending, in-progress and decoded files ignore duplicates."

## Done criteria

- [ ] All commands above exit 0, and the three new tests exist and pass
- [ ] `grep -n "INSERT OR IGNORE INTO activity_files" src/activity/store.ts` → no match
- [ ] Only in-scope files are modified

## STOP conditions

- An existing test in `test/credential-retention.test.ts` fails. The ordering guarantees there take precedence; report which one failed.
- Garmin's resend turns out to use a different `activityId`. Then this fix does not apply.

## Maintenance notes

If an `unsupported_file_type` row should ever accept a later FIT delivery, add that state to the `WHERE` list deliberately, together with a test.
