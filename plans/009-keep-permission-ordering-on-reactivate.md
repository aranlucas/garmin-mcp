# Plan 009: Reconnecting keeps the permission-change ordering, so a late withdrawal cannot undo it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 07e3182..HEAD -- src/push/store.ts test/credential-retention.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (the fix must never ignore a real, current consent withdrawal)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `07e3182`, 2026-11-11

## Why this matters

Auth's reconnect sends `action: "activate"` to `/garmin/disconnect` (`src/push/handler.ts`, `purgeUser`), which calls `GarminUserData.activate()`. That method deletes **all** settings: the `revoked` tombstone, but also `permissionTime`, the only guard against stale `userPermissionsChange` deliveries. A delayed or retried withdrawal that is older than the reconnect is then applied. It purges the category the user has just granted again and blocks its ingest. The user sees only empty results, which the tools describe as "not received", so nothing tells them anything went wrong.

## Current state

`src/push/store.ts` (`grep -n "activate() {" src/push/store.ts`):

```ts
  activate() {
    this.ctx.storage.sql.exec("DELETE FROM settings");
  }
  permissions(permissions: string[], changedAt: number) {
    if (changedAt <= (this.setting("permissionTime") ?? -1)) {
      return;
    }
```

The settings keys in use are `revoked`, `permissionTime`, `HEALTH_EXPORT`, `ACTIVITY_EXPORT` and `fileNextAttempt`. Event permission keys come from `eventPermission(name)` in `src/events/protocol.ts`, and those values are `HEALTH_EXPORT` or `ACTIVITY_EXPORT`. Confirm with `grep -n "setSetting(" src/push/store.ts src/events/*.ts`.

## Scope

**In scope**: `activate()` in `src/push/store.ts`, plus `test/credential-retention.test.ts`.

**Out of scope**: deregistration ordering. Deregistrations carry no timestamp, so fixing it needs a design decision (for example, asking Garmin's permission endpoint before tombstoning). Record that as a follow-up rather than implementing it here.

## Steps

### Step 1

Change `activate()` to delete every setting except `permissionTime`:

```sql
DELETE FROM settings WHERE key<>'permissionTime'
```

The per-category flags are still cleared, so reconnecting re-enables collection until the next permission change arrives.

### Step 2: Tests

Model them on the disconnect tests in `test/credential-retention.test.ts`:

1. Permission change at time T2 (both granted). Then `revoke()` (which purges data), then `activate()`, then ingest a fresh Health summary, then deliver a delayed Health withdrawal stamped T1 < T2. Assert that the withdrawal is ignored and the fresh summary remains readable.
2. A withdrawal stamped T3 > T2 after `activate()` is applied. Assert that the category is purged.

## Done criteria

- [ ] `pnpm run typecheck && pnpm run lint` exit 0
- [ ] `pnpm exec vitest run --project worker test/credential-retention.test.ts test/push.test.ts` passes, including both new tests

## STOP conditions

- Auth's reconnect relies on `permissionTime` being reset, for example because Garmin resends the same timestamp after a re-grant. Check `docs/authorization-retention.md`. If that is unclear, stop and ask.

## Maintenance notes

The deregistration-after-activate race remains. List it in the plans README as a follow-up that needs a design decision.
