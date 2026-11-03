import * as z from "zod";

const MAX_RANGE_DAYS = 31;

export const DATE_RANGE_MESSAGE = `Use a date range in order, covering at most ${MAX_RANGE_DAYS} calendar days. Split larger requests.`;

export const calendarDate = z.iso.date().describe("Calendar date as YYYY-MM-DD.");

export function isBoundedDateRange(start: string | undefined, end: string | undefined): boolean {
  if (start === undefined || end === undefined) {
    return true;
  }

  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;

  return days >= 0 && days < MAX_RANGE_DAYS;
}
