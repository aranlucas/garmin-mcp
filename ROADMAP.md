# Garmin MCP feature roadmap

Updated 2026-10-26. Proposed release order, not delivery dates or evidence of customer demand. Targets below are pilot decision gates, not measured results.

## User and outcome

A Garmin user who wants a useful weekly training review and an easy way to put their chosen next workouts on the calendar.

## Current baseline

The connector already exposes pushed health/activity summaries, day/activity reads including decoded FIT data, and workout/calendar CRUD. Starter data begins when pushes arrive; automatic historical backfill is unavailable.

Planning evidence: [README](README.md), [MCP surface](src/mcp.ts) and [training tools](src/training/mcp.ts) at `d4986b7d1059`. This focused product pass does not claim a complete new code audit or live-provider validation.

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

Authorization outages must preserve retained data before relying on historical reviews; check the current retention fix at integration time. Keep exercise choices user-reviewed, label provider data gaps and avoid diagnostic or guaranteed-performance claims. Historical backfill requires actual provider support.

Engineering work belongs in the milestone only when it enables that acceptance criterion. Prefer existing native libraries and test runners. Update this roadmap when a user-visible increment ships, recording the outcome and remaining limits rather than checking off implementation activity alone.
