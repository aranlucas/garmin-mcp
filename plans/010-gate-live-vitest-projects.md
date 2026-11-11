# Plan 010: A bare `vitest` run never reaches production services

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 07e3182..HEAD -- vitest.config.ts test/smoke.test.ts test/push-live.test.ts test/exchange-live.test.ts test/personal-backfill-live.test.ts package.json README.md`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `07e3182`, 2026-11-11

## Why this matters

`vitest.config.ts` defines the projects `push-live`, `exchange-live`, `personal-backfill-live` and `smoke` alongside `worker`, and nothing gates them. Package scripts always pass `--project`. But `pnpm exec vitest`, watch mode, or an editor's Vitest extension runs every project. `test/smoke.test.ts` then defaults to the production Worker URL, and the live tests throw without their private settings files. A contributor gets production traffic and failures that look like breakage.

## Current state

- `vitest.config.ts` lists the live projects after `apps`. Find them with `grep -n "name:" vitest.config.ts`.
- `test/smoke.test.ts:5` reads `SMOKE_BASE_URL`, falling back to the production URL.
- The live tests read `GARMIN_E2E_PUSH_SECRET_FILE`, `GARMIN_E2E_EXCHANGE_FILE` and `GARMIN_BACKFILL_SETTINGS_FILE` (README "Deployment and opt-in live verification").
- `package.json` has the script `"smoke": "vitest run --project smoke"`.

## Scope

**In scope**: the four live test files, `package.json` (one script), and the README deployment section.

**Out of scope**: the `worker` and `apps` projects, and CI.

## Steps

1. In each live test file, wrap the tests in `describe.skipIf(!process.env.<VAR>)`, using the file's own settings variable. For smoke, use a new opt-in `GARMIN_SMOKE=1`. Update the `smoke` script to `GARMIN_SMOKE=1 vitest run --project smoke`.
2. Add `"test:watch": "pnpm run build:apps && vitest --project worker"`.
3. In the README, note that live projects are skipped unless their variable is set.

## Done criteria

- [ ] `pnpm exec vitest run --project smoke` with no environment reports every test skipped and makes no network request
- [ ] `pnpm run typecheck && pnpm run lint && pnpm run format:check` exit 0

## STOP conditions

- Workers Builds or CI invokes these projects without the variables. Check `.github/workflows/*.yml` and stop if they do.
