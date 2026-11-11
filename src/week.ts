import { z } from "zod";
import { calendarDate } from "./tool-input";
import { summaryType, summaryPermission, type SummaryType } from "./push/schemas";
import type { GarminUserData } from "./push/store";
import { garminActivityId } from "./activity/files";

const WEEK_DAYS = 7;

/** Health and Activity sections whose received records are cited as evidence in the review. */
const evidenceTypes = ["dailies", "sleeps", "activities"] as const;

export const weekInput = z.strictObject({
  startDate: calendarDate.describe("First of the seven calendar dates to review, as YYYY-MM-DD."),
  limitPerType: z.number().int().min(1).max(100).default(50),
});

const availability = z.enum(["available", "not_received", "permission_denied"]);

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const storedSummary = z.looseObject({ summaryId: z.string().min(1).max(255) });

const evidenceRecord = z.object({
  date: calendarDate,
  summaryId: z.string(),
  receivedAt: z.iso.datetime(),
  fields: z.record(z.string(), scalar),
});

const activityRecord = evidenceRecord.extend({ activityId: garminActivityId.nullable() });

const evidenceSection = z.object({
  availability,
  // Activity records are tried first so a union match never strips their activityId.
  records: z.array(z.union([activityRecord, evidenceRecord])),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const coverageCell = z.object({
  availability,
  // Withheld categories reveal nothing about stored records, not even counts.
  counts: z.record(calendarDate, z.number().int().nonnegative()).nullable(),
});

const weekData = z.object({
  startDate: calendarDate,
  endDate: calendarDate,
  dates: z.array(calendarDate).length(WEEK_DAYS),
  complete: z.boolean(),
  missingDates: z.array(calendarDate),
  unavailableCategories: z.array(summaryType),
  coverage: z.record(summaryType, coverageCell),
  evidence: z.object({
    dailies: evidenceSection,
    sleeps: evidenceSection,
    activities: evidenceSection,
  }),
});

type CoverageCell = z.infer<typeof coverageCell>;

type EvidenceSection = z.infer<typeof evidenceSection>;

type CoverageEntry = readonly [SummaryType, CoverageCell];

type EvidenceEntry = readonly [SummaryType, EvidenceSection];

const denied: EvidenceSection = {
  availability: "permission_denied",
  records: [],
  hasMore: false,
  nextOffset: null,
};

/** The seven consecutive calendar dates beginning at `startDate`. */
export function weekDates(startDate: string): string[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);

  return Array.from({ length: WEEK_DAYS }, (_, day) =>
    new Date(start + day * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Top-level measurements only: sample arrays and nested structures stay behind their source reads. */
function scalarFields(summary: z.infer<typeof storedSummary>) {
  return Object.fromEntries(
    Object.entries(summary).flatMap(([key, value]) => {
      const parsed = scalar.safeParse(value);

      return parsed.success ? [[key, parsed.data] as const] : [];
    }),
  );
}

export async function getGarminWeek(
  store: DurableObjectStub<GarminUserData>,
  input: z.infer<typeof weekInput>,
  permissions: string[],
) {
  const dates = weekDates(input.startDate);
  const startDate = dates[0] ?? input.startDate;
  const endDate = dates.at(-1) ?? input.startDate;
  const { revoked, counts } = await store.coverage(summaryType.options, startDate, endDate);

  const allowed = (type: SummaryType) => !revoked && permissions.includes(summaryPermission(type));

  const coverage = new Map(
    summaryType.options.map((type): CoverageEntry => {
      if (!allowed(type)) {
        return [type, { availability: "permission_denied", counts: null }];
      }

      const perDate: Record<string, number> = Object.fromEntries(dates.map((date) => [date, 0]));

      for (const row of counts) {
        if (row.type === type) {
          perDate[row.date] = row.count;
        }
      }

      const received = Object.values(perDate).some((count) => count > 0);

      return [type, { availability: received ? "available" : "not_received", counts: perDate }];
    }),
  );

  const evidence = await Promise.all(
    evidenceTypes.map(async (type): Promise<EvidenceEntry> => {
      if (!allowed(type)) {
        return [type, denied];
      }

      const page = await store.list(type, startDate, endDate, input.limitPerType, 0);

      const records = page.records.map(({ date, receivedAt, summaryJSON }) => {
        const summary = storedSummary.parse(JSON.parse(summaryJSON));
        const record = { date, summaryId: summary.summaryId, receivedAt };
        const fields = scalarFields(summary);

        return type === "activities"
          ? {
              ...record,
              fields,
              activityId: garminActivityId.safeParse(summary.activityId).data ?? null,
            }
          : { ...record, fields };
      });

      return [
        type,
        {
          availability: records.length ? "available" : "not_received",
          records,
          hasMore: page.hasMore,
          nextOffset: page.hasMore ? records.length : null,
        },
      ];
    }),
  );

  const dailies = coverage.get("dailies")?.counts;
  // A date without a received daily summary is unconfirmed, never a day without activity.
  const missingDates = dates.filter((date) => !dailies?.[date]);
  const unavailableCategories = summaryType.options.filter((type) => !allowed(type));

  return weekData.parse({
    startDate,
    endDate,
    dates,
    complete: missingDates.length === 0 && unavailableCategories.length === 0,
    missingDates,
    unavailableCategories,
    coverage: Object.fromEntries(coverage),
    evidence: Object.fromEntries(evidence),
  });
}
