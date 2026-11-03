# Garmin MCP feature roadmap

Updated 2026-10-26. Proposed release order, not delivery dates or evidence of customer demand. Targets below are pilot decision gates, not measured results.

## User and outcome

A Garmin user who wants a useful weekly training review and an easy way to put their chosen next workouts on the calendar.

## Prioritized releases

| Order | Feature                                     | User value and scope                                                                                                                           | Release acceptance                                                                                                                    |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Now   | A weekly review that explains its evidence  | Combine received activities and available daily summaries into a dated review, explicitly identifying missing days and unavailable categories. | Every observation links to its source dates/activities; a week with missing data remains incomplete rather than implying no activity. |
| Next  | Review a training week before scheduling it | Compose existing workout and calendar tools into a preview showing proposed sessions, dates, conflicts and changes to existing entries.        | The user approves a concrete plan; partial scheduling has recoverable status and retry does not create duplicate sessions.            |
| Next  | Planned-versus-completed follow-up          | Compare scheduled sessions with received activities and ask the user to resolve uncertain matches.                                             | Users can confirm or correct matches and see a useful weekly completion summary without treating ambiguous matches as facts.          |
| Later | Portable training history                   | Offer a user-selected export and a clearly scoped sharing report for a coach or another personal tool.                                         | The user selects dates/categories, previews what will leave the account and can export without exposing credentials.                  |

## Measure value before expanding

Baseline five weekly reviews: time needed to answer “what did I do and what data is missing?”, corrections to activity matching, and return use in the next week. Proposed first gate: every review accurately states coverage; at least three pilot users request a second review.

Collect the baseline before building the first slice. Use voluntary pilot feedback and minimal aggregate events; do not log private content or credentials to measure adoption. If the first workflow is not used again, revisit the problem before adding the later features. Revenue impact is unvalidated.

## Next shippable slice

Add one weekly-review resource/tool that composes existing reads and includes a coverage matrix, not a new scoring model.

## Dependencies and deliberate limits

Preserve [retained data during authorization outages](docs/authorization-retention.md) before relying on historical reviews. Keep exercise choices user-reviewed, label provider data gaps and avoid diagnostic or guaranteed-performance claims. Historical backfill requires actual provider support.

Update this roadmap when a user-visible increment ships, recording the outcome and remaining limits.

## Candidate event follow-ons

These remaining ideas from the October 24 event proposal are not commitments or a change to the release order above. [Available events](docs/mcp-events.md) already cover workout completion, sleep, body composition and Health Snapshot.

- **Recovery summary:** bundle available sleep, HRV and resting-heart-rate data for a morning review. Define completeness and a bounded wait, expose missing inputs, and never label it Garmin Training Readiness.
- **Activity updated:** notify meaningful corrections or newly available detail so an analysis can be revised. Suppress identical retries; consider a details-available filter before adding a separate event.
- **Daily goal reached:** use an explicit user-selected target because this connector has no goals API. Emit at most once per local day and target revision; define how corrected totals affect a previous crossing.
- **Workout due/missed:** require a scheduler, user time zone and grace period for delayed sync. Missing activity is not proof of a missed workout; expose uncertainty in schedule-to-activity matching.

Defer personal-best and all-time-record events until history completeness is known. Starter pushes and the optional activity import do not establish complete lifetime history. If client replay is added, use a durable journal sequence: mutable summaries whose receipt timestamps change on retry are not a reliable cursor. Deletion and withdrawal must also remove journal copies and define replay gaps.
