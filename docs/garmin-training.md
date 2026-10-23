# Garmin Training API v2

The optional Training connector publishes structured workouts and calendar entries to Garmin Connect for synchronization to compatible devices. It has a separate MCP resource (`/training/mcp`) and OAuth issuer (`/training`); Personal API keys continue to authorize the read-only `/mcp` connector.

The implementation was reconciled on 2026-10-23 against the approved portal's **Training API V2 2.0** (2026-10-15) and **OAuth2PKCE 2.0** references. The portal is accessible after developer-program approval. Reference documents remain outside this repository. Contract and local HTTP end-to-end tests use synthetic Garmin responses. A separate real-account lifecycle test passed against the deployed Worker on 2026-10-23, including cleanup and local grant revocation.

## Application setup

Register an app in [Garmin's developer portal](https://developerportal.garmin.com/developer-programs/connect-developer-api) with Training API access. For the hosted deployment use:

- Name: Garmin Training MCP
- OAuth redirect: `https://garmin-mcp.aranlucas.workers.dev/training/callback`
- Website: `https://garmin-mcp.aranlucas.workers.dev`
- Privacy: `https://garmin-mcp.aranlucas.workers.dev/privacy`
- Branding: `https://garmin-mcp.aranlucas.workers.dev/icon.png` (Garmin’s image validator does not accept SVG dimensions; `/icon.svg` serves the same artwork)

The hosted Garmin Training MCP app was registered on 2026-10-23 with an approved key and Starter access enabled. This deployment defaults to Training enabled with its public client ID in `cloudflare.config.ts`; its secret is installed in Cloudflare. For another app, set `GARMIN_TRAINING_CLIENT_ID` in the build environment and install `GARMIN_TRAINING_CLIENT_SECRET` as a Worker secret. Set `GARMIN_TRAINING_ENABLED=false` to disable Training. Enabled builds declare that secret with `bindings.secret()`; disabled builds do not require it. Missing credentials fail closed with a redacted 503. Persist any overrides in CI so later builds use the same application. No secret belongs in tracked configuration or chat.

For local browser development, supply the secret in an ignored `.dev.vars` file and export the flag and client ID when starting Vite:

```sh
GARMIN_TRAINING_ENABLED=true GARMIN_TRAINING_CLIENT_ID=<client-id> pnpm dev
```

The redirect must be registered with Garmin. The server uses the request's origin for discovery, redirects and audiences, so register an HTTPS development/preview origin if Garmin does not accept localhost. `.dev.vars` supplies declared secrets; text bindings are selected when evaluating `cloudflare.config.ts`.

When disabled, the Training protocol routes return 404, including existing sessions. Privacy disclosures remain public for Garmin app registration. `/training` requires enabled, configured credentials. Turning off the feature does not revoke upstream consent or erase grants.

## Sign-in, credentials and consent

Garmin sign-in uses S256 PKCE at `https://connect.garmin.com/oauth2Confirm`. Code and refresh exchanges run only on the Worker at `https://diauth.garmin.com/di-oauth2-service/oauth/token`, using HTTP Basic client authentication as shown in the current reference. The client secret never enters browser authorization URLs or MCP results. Credential-bearing redirects are rejected.

The current identity and permission routes are `/partner-gateway/rest/user/id` and `/partner-gateway/rest/user/permissions`. Permissions have the envelope `{ "permissions": ["WORKOUT_IMPORT"] }`. Workout Import must be granted during sign-in and is checked again before every tool execution. Garmin scopes are fixed by the application and are not supplied as selectable authorization scopes.

The existing `@cloudflare/workers-oauth-provider` owns MCP client registration, browser-bound consent/upstream state, MCP PKCE, encrypted grants, refresh and revocation. Training requests require `garmin:workouts:write`; sessions requesting `offline_access` receive refresh tokens. Personal and Training resource audiences cannot authorize one another. Consent discloses create/read/update/delete access and processing by the chosen MCP client, including its AI provider when applicable.

Garmin access/refresh tokens are encrypted in KV grants. An MCP access token lasts at most one hour and expires at least 600 seconds before its Garmin access token. Near-expiry Garmin credentials are refreshed during MCP refresh; replacement credentials are persisted in the encrypted grant. Transient failures preserve the grant; terminal refresh failures invalidate it. Local refresh access lasts at most 30 days and never exceeds Garmin refresh expiry. Workout payloads are request-local and excluded from application logs.

Revoke the MCP refresh token at the issuer's advertised revocation endpoint to remove the local grant. Remove the app in **Garmin Connect → Connected Apps** to revoke Garmin consent. Local revocation does not call Garmin's registration deletion endpoint. This connector provides no partner-side account-deletion control or permission/deregistration webhook. Permissions are checked synchronously before operations. Previously published workouts and client conversation history remain until deleted through their respective controls.

## Tools and verified reference paths

| Tool                      | Method and path                                    |
| ------------------------- | -------------------------------------------------- |
| `create_workout`          | `POST /workoutportal/workout/v2`                   |
| `get_workout`             | `GET /training-api/workout/v2/{workoutId}`         |
| `update_workout`          | `PUT /training-api/workout/v2/{workoutId}`         |
| `delete_workout`          | `DELETE /training-api/workout/v2/{workoutId}`      |
| `schedule_workout`        | `POST /training-api/schedule/`                     |
| `get_workout_schedule`    | `GET /training-api/schedule/{scheduleId}`          |
| `update_workout_schedule` | `PUT /training-api/schedule/{scheduleId}`          |
| `delete_workout_schedule` | `DELETE /training-api/schedule/{scheduleId}`       |
| `list_workout_schedules`  | `GET /training-api/schedule?startDate=…&endDate=…` |

All paths are pinned to `https://apis.garmin.com`. The create-workout route intentionally follows the reference’s `workoutportal` path and passed the live test. There is no fallback that could duplicate a write.

V2 workout payloads contain `segments`, each with `segmentOrder`, `sport` and `steps`. The old top-level `steps` payload is rejected. Create a workout, retain its returned `workoutId`, then schedule it separately:

```json
{
  "workout": {
    "workoutName": "Easy run - 30 minutes",
    "sport": "RUNNING",
    "segments": [
      {
        "segmentOrder": 1,
        "sport": "RUNNING",
        "steps": [
          {
            "type": "WorkoutStep",
            "stepOrder": 1,
            "intensity": "ACTIVE",
            "durationType": "TIME",
            "durationValue": 1800,
            "targetType": "OPEN"
          }
        ]
      }
    ]
  }
}
```

Then call `schedule_workout` with `{ "workoutId": 123, "date": "2026-10-26" }`. Updates supply complete workout details and the `ownerId` returned by Garmin; server-assigned IDs are excluded from create input. Update/delete tools carry destructive annotations and require the assistant to confirm the requested changes.

Garmin returns a numeric ID from schedule creation; the adapter validates it and returns `{ "scheduleId": 123 }`. Reads return full schedule objects. Garmin also documents 204 as a successful mutation response; empty 200/204 responses return `{ "accepted": true }` without an invented ID. If creation yields no ID, inspect Garmin Connect before any subsequent action; never repeat creation just to obtain an ID. Timeouts, transport failures and malformed success responses can leave a write's outcome unknown. The server does not automatically retry writes. Successful scheduling confirms a Garmin Connect operation; device synchronization requires Garmin Connect and cannot be established by this API response.

## Supported input subset and limits

The adapter supports the eight documented segment sports plus `MULTI_SPORT`, up to 25 segments, 100 total steps for single sport and 250 for multisport, counting repeat children. Segment and step order are globally increasing. Provider/source fields default to `Garmin MCP` and are capped at Garmin's 20-character limit. Workout descriptions are capped at 1024 characters and step descriptions at 512.

Steps support `TIME`, `DISTANCE`, `REPS` and `OPEN`; one fixed-count repeat-block level is supported. Nested repeats, secondary targets and advanced duration types are outside this input subset and fail validation. Running/cycling pace and speed use meters per second; time uses seconds, distance uses meters, and strength weights use kilograms regardless of display units. Heart-rate/power targets accept a saved zone or an ordered range; percentage values use `targetValueType: "PERCENT"`. Swim steps use `SWIM_STROKE`; unspecified pool sizes are allowed. Multisport swim pool settings must match workout-level settings. Exercise identifiers must match Garmin's supplied appendix; the adapter bounds their strings but does not ship that confidential exercise catalog.

Dates are Garmin calendar dates (`YYYY-MM-DD`), without UTC conversion. Schedule queries have a local limit of 31 inclusive calendar dates. JSON responses are limited to 1 MiB, token responses to 64 KiB, and outbound requests to 20 seconds with cancellation propagation. These local safeguards do not replace Garmin's app/user quotas.

## Verification

`pnpm run check` runs type generation, TypeScript, lint, formatting and the Workers-runtime tests. `pnpm run build` verifies the production bundle. Tests include a complete registration → consent → upstream PKCE → encrypted grant → authenticated Streamable HTTP → all nine operations → local revocation flow, as well as upstream refresh rotation, scope/resource isolation, per-call permission withdrawal, malformed responses, cancellation, 204 success and ambiguous write failure. Garmin calls in these tests are mocked.

`pnpm run smoke` tests the deployed Personal discovery/consent flow and the public branding/privacy URLs. It does not authorize a Garmin account or publish workouts. Chrome verification exercises the real local UI and catches configuration or browser-cookie/CSP issues that HTTP mocks cannot prove.

The opt-in `training-live` Vitest project exercises real Garmin writes after a browser-authorized session has been saved outside the repository. Run:

```sh
GARMIN_E2E_SESSION_FILE=/absolute/private/session.json pnpm exec vitest run --project training-live
```

The private JSON contains `base`, `clientId` and `refreshToken` for the disposable MCP authorization. The test refreshes the session, creates a clearly named synthetic 60-second run, reads and updates it, schedules and moves it, and removes its calendar entry and workout in cleanup. It verifies that the test workout has no remaining calendar entries across both test dates, then revokes the test MCP grant and confirms its access token returns 401. A private records journal retains only synthetic fixture identifiers and cleanup status for investigation if a run fails. Never commit the session file or pass its contents in chat. Production unit tests and smoke tests do not run this project.

Verification completed on 2026-10-23:

- Real Chrome developer-portal app registration, published PNG/SVG branding and privacy URLs, and Garmin Workout Import consent.
- Real Garmin authorization-code exchange, current permission envelope, user-ID lookup and encrypted MCP grant issuance.
- Real MCP refresh, all nine Training operations, workout and calendar readback, movement to a second date, cleanup and test-grant revocation.
- Workers-runtime regression tests reproduce and fix the unsupported `redirect: "error"` mode in both Garmin clients. The implementation uses `manual` and rejects 3xx responses. The real browser flow also caught the required `sso.garmin.com` form-action allowance.
- The live schedule response was confirmed to be a numeric ID and is covered by a contract regression test.

The passing live run removed its synthetic workout and calendar entry. Its temporary MCP grant was revoked; the app remains available for new connections. The Personal connector’s live health reads still require a real Personal API key and were not performed in this session. Physical watch synchronization and near-expiry upstream Garmin refresh/revocation remain unverified live; upstream refresh rotation and removed-permission handling are covered by mocked runtime tests. Do not label Garmin Connect API success as watch-delivery verification.

Sources:

- [Approved portal documentation](https://developerportal.garmin.com/developer-programs/programs-docs)
- [Training API V2 2.0 archive](https://developerportal.garmin.com/sites/default/files/Training%20API%20V2%202.0.zip)
- [OAuth2PKCE 2.0](https://developerportal.garmin.com/sites/default/files/OAuth2PKCE%202.0.pdf)
- [Program Start Guide 2.0](https://developerportal.garmin.com/sites/default/files/Garmin%20Developer%20Program_Start_Guide_2.0.pdf)
- [Cloudflare configuration and conditional secret bindings](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
