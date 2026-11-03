/** Display-only formatting for MCP App views. Missing values render as an em dash, never zero. */

export const DASH = "—";

/** Garmin omits or nulls unmeasured values; both render as missing, never zero. */
export type Measure = number | null | undefined;

export function count(value: Measure, digits = 0): string {
  return value === undefined || value === null
    ? DASH
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function clock(seconds: Measure): string {
  if (seconds === undefined || seconds === null) {
    return DASH;
  }

  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function hoursMinutes(seconds: Measure): string {
  if (seconds === undefined || seconds === null) {
    return DASH;
  }

  const minutes = Math.round(seconds / 60);

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m` : `${minutes}m`;
}

export function kilometers(meters: Measure): string {
  return meters === undefined || meters === null ? DASH : `${count(meters / 1000, 2)} km`;
}

/** Garmin speed and pace targets are meters per second. */
export function pace(metersPerSecond: Measure): string {
  if (!metersPerSecond) {
    return DASH;
  }

  return `${clock(1000 / metersPerSecond)} /km`;
}

/** Seconds after local midnight as HH:MM. */
export function timeOfDay(secondsAfterMidnight: number): string {
  const minutes = Math.floor(secondsAfterMidnight / 60) % (24 * 60);

  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function longDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);

  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
}

export function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);

  return parsed.toISOString().slice(0, 10);
}

export function words(value: string): string {
  const lower = value.replaceAll("_", " ").toLowerCase();

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
