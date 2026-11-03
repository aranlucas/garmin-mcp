import { expect, it } from "vitest";
import { envelope, fitsWidth, openApp, screenshot } from "./mcp-app-host";

const SEMICIRCLES = 2 ** 31 / 180;
const midnight = Date.UTC(2026, 10, 1, 8) / 1000;
const offset = -8 * 3600;

const every = (step: number, value: (seconds: number) => number) =>
  Object.fromEntries(
    Array.from({ length: 86_400 / step }, (_, i) => [
      String(i * step),
      Math.round(value(i * step)),
    ]),
  );

const record = <Summary extends object>(summary: Summary) => ({
  summaryId: `s-${Object.keys(summary).length}`,
  receivedAt: "2026-11-02T08:00:00.000Z",
  summary,
});

const section = (records: unknown[]) => ({
  availability: records.length ? "available" : "not_received",
  records,
  hasMore: false,
  nextOffset: null,
});

function day(date: string, steps: number) {
  return {
    date,
    sections: {
      dailies: section([
        record({
          calendarDate: date,
          startTimeInSeconds: midnight,
          startTimeOffsetInSeconds: offset,
          durationInSeconds: 86_400,
          steps,
          stepsGoal: 10_000,
          distanceInMeters: 6400,
          activeKilocalories: 612,
          floorsClimbed: 7,
          floorsClimbedGoal: 10,
          moderateIntensityDurationInSeconds: 1800,
          vigorousIntensityDurationInSeconds: 900,
          intensityDurationGoalInSeconds: 9000,
          restingHeartRateInBeatsPerMinute: 52,
          minHeartRateInBeatsPerMinute: 48,
          maxHeartRateInBeatsPerMinute: 171,
          averageStressLevel: 31,
          bodyBatteryChargedValue: 64,
          bodyBatteryDrainedValue: 58,
          timeOffsetHeartRateSamples: every(900, (s) => 62 + 30 * Math.sin(s / 9000) ** 2),
        }),
      ]),
      sleeps: section([
        record({
          calendarDate: date,
          durationInSeconds: 24_600,
          deepSleepDurationInSeconds: 5400,
          lightSleepDurationInSeconds: 12_600,
          remSleepInSeconds: 5400,
          awakeDurationInSeconds: 1200,
          overallSleepScore: { value: 82, qualifierKey: "GOOD" },
        }),
      ]),
      hrv: section([record({ lastNightAvg: 48, lastNight5MinHigh: 71 })]),
      stressDetails: section([
        record({
          startTimeInSeconds: midnight,
          startTimeOffsetInSeconds: offset,
          durationInSeconds: 86_400,
          timeOffsetBodyBatteryValues: every(1800, (s) => 90 - (s / 86_400) * 60),
        }),
      ]),
      pulseox: section([]),
      activities: section([
        { summaryId: "a1", receivedAt: "2026-11-02T08:00:00.000Z", activityId: "123" },
      ]),
    },
  };
}

const recordMesgs = Array.from({ length: 600 }, (_, i) => {
  const angle = (i / 600) * 2 * Math.PI;

  return {
    timestamp: 1_100_000_000 + i * 3,
    positionLat: Math.round(
      (47.6 + 0.01 * Math.sin(angle) + 0.002 * Math.sin(angle * 5)) * SEMICIRCLES,
    ),
    positionLong: Math.round((-122.3 + 0.015 * Math.cos(angle)) * SEMICIRCLES),
    heartRate: Math.round(130 + 30 * Math.sin(i / 90)),
    enhancedSpeed: 2.8 + 0.4 * Math.sin(i / 40),
    enhancedAltitude: 40 + 15 * Math.sin(angle * 2),
    distance: i * 8.4,
  };
});

const activity = {
  activityId: "123",
  summary: {
    activityName: "Morning Run",
    activityType: "RUNNING",
    deviceName: "Forerunner",
    durationInSeconds: 1800,
    distanceInMeters: 5040,
    averageHeartRateInBeatsPerMinute: 141,
    maxHeartRateInBeatsPerMinute: 162,
    averageSpeedInMetersPerSecond: 2.8,
    activeKilocalories: 402,
    totalElevationGainInMeters: 58,
  },
  details: null,
  fit: {
    availability: "available",
    messages: {
      recordMesgs,
      sessionMesgs: [{ totalDistance: 5040, totalTimerTime: 1800, avgHeartRate: 141 }],
      lapMesgs: [1, 2, 3].map((lap) => ({
        totalDistance: 1680,
        totalTimerTime: 600,
        avgHeartRate: 136 + lap * 3,
        enhancedAvgSpeed: 2.8,
      })),
    },
    sets: [],
  },
};

const workout = {
  workoutId: 871,
  ownerId: 52,
  workoutName: "Tuesday intervals",
  sport: "RUNNING",
  segments: [
    {
      segmentOrder: 1,
      sport: "RUNNING",
      steps: [
        {
          type: "WorkoutStep",
          stepOrder: 1,
          intensity: "WARMUP",
          durationType: "TIME",
          durationValue: 600,
          targetType: "OPEN",
        },
        {
          type: "WorkoutRepeatStep",
          stepOrder: 2,
          repeatType: "REPEAT_UNTIL_STEPS_CMPLT",
          repeatValue: 4,
          steps: [
            {
              type: "WorkoutStep",
              stepOrder: 3,
              intensity: "INTERVAL",
              durationType: "DISTANCE",
              durationValue: 400,
              targetType: "PACE",
              targetValueLow: 4.2,
              targetValueHigh: 4.6,
            },
            {
              type: "WorkoutStep",
              stepOrder: 4,
              intensity: "RECOVERY",
              durationType: "TIME",
              durationValue: 90,
              targetType: "OPEN",
            },
          ],
        },
        {
          type: "WorkoutStep",
          stepOrder: 5,
          intensity: "COOLDOWN",
          durationType: "TIME",
          durationValue: 600,
          targetType: "OPEN",
        },
      ],
    },
  ],
};

it("renders a Garmin day, navigates between days, and opens an activity in place", async () => {
  const host = await openApp({
    view: "day",
    input: { date: "2026-11-01" },
    result: envelope(day("2026-11-01", 8432)),
    tools: ({ name, arguments: args }) =>
      name === "get_garmin_day" ? envelope(day(String(args?.date), 12_034)) : envelope(activity),
  });

  const { frame } = host;

  await expect
    .poll(() => frame.getByRole("heading", { level: 1 }).textContent())
    .toContain("November 1, 2026");
  await expect.poll(() => frame.getByText("8,432 / 10,000").count()).toBe(1);
  await expect.poll(() => frame.getByText("Heart rate (bpm)").count()).toBe(1);
  await expect.poll(() => frame.getByText("Deep · 1h 30m").count()).toBe(1);
  await expect.poll(() => frame.getByText(/Not received for this day: Pulse Ox/).count()).toBe(1);
  // An unchanged day after "today" stays reachable only by going back.
  await expect.poll(() => frame.getByRole("button", { name: "Next day" }).isDisabled()).toBe(false);
  await screenshot(host.page, "day");

  await frame.getByRole("button", { name: "Previous day" }).click();
  await expect
    .poll(() => frame.getByRole("heading", { level: 1 }).textContent())
    .toContain("October 31, 2026");
  await expect.poll(() => frame.getByText("12,034 / 10,000").count()).toBe(1);

  await frame.getByRole("button", { name: "Open activity 123 →" }).click();
  await expect.poll(() => frame.getByText("Route, colored by heart rate").count()).toBe(1);
  await expect
    .poll(() => frame.getByRole("heading", { level: 1 }).textContent())
    .toBe("Morning Run");
  await frame.getByRole("button", { name: "← Back to day" }).click();
  await expect.poll(() => frame.getByText("12,034 / 10,000").count()).toBe(1);

  expect(host.calls.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
    { name: "get_garmin_day", arguments: { date: "2026-10-31" } },
    { name: "get_garmin_activity", arguments: { activityId: "123" } },
  ]);
  expect(host.modelContext.at(-1)).toBe("The user opened Garmin activity 123 from the day view.");
  expect(host.errors).toEqual([]);
  expect(host.externalRequests).toEqual([]);
});

it("replays an activity route with linked charts and laps", async () => {
  const host = await openApp({
    view: "activity",
    input: { activityId: "123" },
    result: envelope(activity),
  });

  const { frame } = host;

  await expect
    .poll(() => frame.getByRole("heading", { level: 1 }).textContent())
    .toContain("Morning Run");
  await expect.poll(() => frame.getByText("5.04 km").count()).toBeGreaterThan(0);
  await expect.poll(() => frame.locator(".route path").count()).toBeGreaterThan(3);
  await expect.poll(() => frame.locator("tbody tr").count()).toBe(3);

  await frame.getByLabel("Replay position").fill("300");
  await expect.poll(() => frame.locator(".readout").textContent()).toContain("15:00");
  await expect.poll(() => frame.locator(".chart-frame .tooltip").count()).toBe(3);
  await screenshot(host.page, "activity");

  await frame.getByRole("button", { name: "▶ Replay" }).click();
  await expect.poll(() => frame.getByRole("button", { name: "Pause" }).count()).toBe(1);

  expect(host.errors).toEqual([]);
  expect(host.externalRequests).toEqual([]);
});

it("draws a workout profile with expanded repeats and asks the model to schedule", async () => {
  const host = await openApp({
    view: "workout",
    input: { workoutId: 871 },
    result: envelope(workout, { deviceSync: "Sync Garmin Connect with your compatible device." }),
  });

  const { frame } = host;

  await expect
    .poll(() => frame.getByRole("heading", { level: 1 }).textContent())
    .toContain("Tuesday intervals");
  // Warm-up, four interval + recovery pairs, cool-down.
  await expect.poll(() => frame.locator('.profile svg path:not([fill="none"])').count()).toBe(10);
  await expect.poll(() => frame.getByText("Repeat ×4").count()).toBe(1);
  await expect.poll(() => frame.getByText(/3:37 \/km – 3:58 \/km/).count()).toBe(1);
  await screenshot(host.page, "workout");

  await frame.getByLabel("Put it on the calendar").fill("2026-11-04");
  await frame.getByRole("button", { name: "Ask to schedule" }).click();
  await expect
    .poll(() => host.messages)
    .toEqual(['Schedule my Garmin workout "Tuesday intervals" (workoutId 871) on 2026-11-04.']);
  expect(host.calls).toEqual([]);
  expect(host.errors).toEqual([]);
});

it("follows the host theme over the OS scheme and fits a phone width", async () => {
  const host = await openApp({
    view: "day",
    input: { date: "2026-11-01" },
    result: envelope(day("2026-11-01", 8432)),
    theme: "dark",
    width: 360,
  });

  await expect.poll(() => host.frame.getByText("8,432 / 10,000").count()).toBe(1);
  await expect
    .poll(() => host.frame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe("rgb(26, 26, 25)");
  expect(await fitsWidth(host.frame)).toBe(true);
  await screenshot(host.page, "day-dark-phone");
});

it("shows Garmin's fixed error text instead of a broken view", async () => {
  const host = await openApp({
    view: "activity",
    input: { activityId: "999" },
    result: {
      isError: true,
      content: [
        { type: "text", text: "Garmin activity is unavailable or permission was withdrawn." },
      ],
    },
  });

  await expect
    .poll(() => host.frame.getByRole("alert").textContent())
    .toBe("Garmin activity is unavailable or permission was withdrawn.");
  expect(host.errors).toEqual([]);
});
