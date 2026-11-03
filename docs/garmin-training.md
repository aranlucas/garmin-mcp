# Garmin Training in the unified connector

Training shares the authenticated `/mcp` endpoint and private Auth broker with Health/Activity reads. See [configuration](../README.md#configuration).

The Training client follows the approved Training API V2 2.0 contract:

- Create with `POST /workoutportal/workout/v2`.
- Read, replace, and delete with `/training-api/workout/v2/{workoutId}`.
- Calendar create/list with `/training-api/schedule/`; read, replace, and delete with `/training-api/schedule/{scheduleId}`.
- Validate `WORKOUT_IMPORT` on each tool call using the partner-gateway permissions endpoint.
- Use segments, globally increasing step order, bounded repeat nesting, and Garmin calendar dates. PACE/SPEED targets use meters per second, TIME uses seconds, DISTANCE uses meters and weights use kilograms.
- Preserve numeric schedule-create IDs. An empty successful mutation becomes `accepted:true`, without fabricating an ID.
- Never retry ambiguous writes automatically or claim that a watch received a workout.

[Worker tests](../test/training.test.ts) exercise all nine tools with mocked responses, schema bounds, redaction, abort handling, response limits and redirects. Do not create real-account workouts or calendar entries for testing: deleted fixtures previously left broken cards in Garmin Connect summaries. The opt-in [read-only exchange check](../README.md#deployment-and-opt-in-live-verification) is the live Training verification path. API success does not establish physical watch synchronization or real near-expiry token refresh.

Official reference material is available to approved developers in the [Garmin developer portal](https://developerportal.garmin.com/developer-programs/programs-docs). Confidential source PDFs and app credentials are not checked into this repository.
