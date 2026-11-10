type CountRow = { n: number };

/* oxlint-disable no-await-in-loop -- Each delivery in these scenarios depends on the previous state transition. */
import { z } from "zod";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm, evictDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { receivePush } from "../src/push/handler";
import { userStore } from "../src/push/store";
import { summaryDate, summary } from "../src/push/schemas";

function push(body: z.infer<ReturnType<typeof z.json>>, credential = env.GARMIN_PUSH_TOKEN) {
  return receivePush(
    new Request("https://delivery.example/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    credential,
  );
}

const record = (userId: string, summaryId = "daily-1", steps = 123) => ({
  userId,
  summaryId,
  calendarDate: "2026-10-23",
  startTimeInSeconds: 1792713600,
  steps,
});

const rejectionLog = z.strictObject({
  event: z.literal("garmin_push_rejected"),
  reason: z.enum(["content_type", "invalid_payload", "invalid_record"]),
  type: z.string().optional(),
});

it("authenticates delivery, rejects invalid payloads and does not accept ping/file URLs", async () => {
  expect((await push({ dailies: [record("a")] }, "public-client-id")).status).toBe(404);

  for (const body of [
    { dailies: [{ userId: "a", callbackURL: "https://evil.example/token" }] },
    { activityFiles: [{ userId: "a", callbackURL: "https://evil.example/file" }] },
    { dailies: [{ ...record("a"), calendarDate: "invalid" }] },
    { unknown: [] },
  ]) {
    expect((await push(body)).status).toBe(400);
  }
});

it("persists idempotent updates and separates Garmin accounts across eviction", async () => {
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();

  const store = userStore(env, id);
  expect((await push({ dailies: [record(id), record(other)] })).status).toBe(200);
  await push({ dailies: [record(id, "daily-1", 456)] });
  await evictDurableObject(store);
  const rows = await store.list("dailies", "2026-10-23", "2026-10-23", 50, 0);
  expect(rows.records).toHaveLength(1);
  expect(rows.records[0]?.summaryJSON).toContain('"steps":456');
  expect(await userStore(env, other).get("dailies", "daily-1")).toContain('"steps":123');
  expect(rows.records[0]?.summaryJSON).not.toContain("userId");
});

it("drops all credentials and callback URLs even in nested summaries", async () => {
  const id = crypto.randomUUID();
  await push({
    activityDetails: [
      {
        ...record(id),
        accessToken: "private",
        samples: [
          { callbackURL: "https://x/?token=private", refreshToken: "private", heartRate: 120 },
        ],
      },
    ],
  });
  const row = await userStore(env, id).get("activityDetails", "daily-1");
  expect(row).not.toContain("private");
  expect(row).toContain("heartRate");
});

it("preserves provider-supplied strength fields in JSON activity details", async () => {
  const id = crypto.randomUUID();
  const sets = [{ repetitions: 8, weightKg: 22.5, exercise: "benchPress", restSeconds: 60 }];
  await push({ activityDetails: [{ ...record(id), sets, workoutId: 123 }] });
  const stored = await userStore(env, id).get("activityDetails", "daily-1");
  expect(JSON.parse(stored ?? "null")).toMatchObject({ sets, workoutId: 123 });
});

it("supports pagination, durable deletion and subsequent collection", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  await push({ activities: [record(id, "1"), record(id, "2"), record(id, "3")] });
  expect((await store.list("activities", "2026-10-23", "2026-10-23", 2, 0)).hasMore).toBe(true);
  expect((await store.list("activities", "2026-10-23", "2026-10-23", 2, 2)).records).toHaveLength(
    1,
  );
  await store.clear();
  expect(await store.get("activities", "1")).toBeNull();
  await push({ activities: [record(id)] });
  expect(await store.get("activities", "daily-1")).not.toBeNull();
});

it("deletes on deregistration and permission withdrawal and blocks late retries", async () => {
  for (const payload of ["deregistrations", "userPermissionsChange"]) {
    const id = crypto.randomUUID();
    const store = userStore(env, id);

    await push({ dailies: [record(id)] });
    expect(
      (
        await push({
          [payload]: [
            {
              userId: id,
              summaryId: "notification-id",
              permissions: ["WORKOUT_IMPORT"],
              changeTimeInSeconds: 1,
            },
          ],
        })
      ).status,
    ).toBe(200);
    await push({ dailies: [record(id)] });
    expect(await store.get("dailies", "daily-1")).toBeNull();
    await store.activate();
    await push({ dailies: [record(id)] });
    expect(await store.get("dailies", "daily-1")).not.toBeNull();
  }
});

it("retains old records across eviction and safely handles legacy cleanup alarms", async () => {
  const store = userStore(env, crypto.randomUUID());
  await store.ingest([
    {
      type: "dailies",
      summaryId: "old",
      date: "2026-10-23",
      receivedAt: Date.now() - 91 * 86400000,
      data: '{"steps":1}',
    },
  ]);
  expect(await store.get("dailies", "old")).toBe('{"steps":1}');
  expect((await store.list("dailies", "2026-10-23", "2026-10-23", 50, 0)).records).toHaveLength(1);
  expect(
    await runInDurableObject(store, (_instance, state) => state.storage.getAlarm()),
  ).toBeNull();
  await evictDurableObject(store);
  expect(await store.get("dailies", "old")).toBe('{"steps":1}');

  // Simulate a cleanup alarm scheduled by the previous production version.
  await runInDurableObject(store, (_instance, state) =>
    state.storage.setAlarm(Date.now() + 86400_000),
  );
  expect(await runDurableObjectAlarm(store)).toBe(true);

  const count = await runInDurableObject(
    store,
    (_instance, state) =>
      state.storage.sql.exec<CountRow>("SELECT count(*) AS n FROM summaries").one().n,
  );

  expect(count).toBe(1);
  expect(await store.get("dailies", "old")).toBe('{"steps":1}');
  expect(
    await runInDurableObject(store, (_instance, state) => state.storage.getAlarm()),
  ).toBeNull();
});

it("uses the provider calendar date or device offset, including nested activity details", () => {
  expect(
    summaryDate(
      summary.parse({
        ...record("a"),
        calendarDate: undefined,
        startTimeInSeconds: 86400,
        startTimeOffsetInSeconds: -3600,
      }),
    ),
  ).toBe("1970-01-01");
  expect(
    summaryDate(
      summary.parse({
        userId: "a",
        summaryId: "a",
        summary: { startTimeInSeconds: 86400, startTimeOffsetInSeconds: 3600 },
      }),
    ),
  ).toBe("1970-01-02");
});

it("stores body composition and blood pressure deliveries by their measurement time", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  // Shapes follow ClientBodyComp and ClientBloodPressure in docs/garmin-wellness-openapi.json.
  const delivered = await push({
    bodyComps: [
      {
        userId: id,
        summaryId: "weight-1",
        measurementTimeInSeconds: 1792713600,
        measurementTimeOffsetInSeconds: -25200,
        weightInGrams: 70500,
      },
    ],
    bloodPressures: [
      {
        userId: id,
        summaryId: "pressure-1",
        measurementTimeInSeconds: 1792713600,
        measurementTimeOffsetInSeconds: 3600,
        systolic: 120,
        diastolic: 80,
      },
    ],
  });

  expect(delivered.status).toBe(200);

  const weights = await store.list("bodyComps", "2026-10-22", "2026-10-22", 50, 0);
  expect(weights.records).toHaveLength(1);
  expect(weights.records[0]?.summaryJSON).toContain('"weightInGrams":70500');

  const pressures = await store.list("bloodPressures", "2026-10-23", "2026-10-23", 50, 0);
  expect(pressures.records).toHaveLength(1);
  expect(pressures.records[0]?.summaryJSON).toContain('"systolic":120');
});

it("still rejects a summary that has no date, start time or measurement time", async () => {
  expect((await push({ bodyComps: [{ userId: "a", summaryId: "no-time" }] })).status).toBe(400);
});

it("keeps the latest complete health summary when Garmin changes its summary ID", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  await push({ epochs: [{ ...record(id, "short"), durationInSeconds: 720 }] });
  await push({ epochs: [{ ...record(id, "complete", 456), durationInSeconds: 900 }] });
  await push({ epochs: [{ ...record(id, "late-short"), durationInSeconds: 720 }] });
  const rows = await store.list("epochs", "2026-10-23", "2026-10-23", 50, 0);
  expect(rows.records).toHaveLength(1);
  expect(rows.records[0]?.summaryJSON).toContain("complete");
});

it("keeps one epoch per activity type for the same window and replaces only a revision", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  // Shape follows ClientEpoch in docs/garmin-wellness-openapi.json.
  const epoch = (summaryId: string, activityType: string, steps: number) => ({
    ...record(id, summaryId, steps),
    activityType,
    durationInSeconds: 900,
    activeTimeInSeconds: 450,
  });

  await push({ epochs: [epoch("walk-1", "WALKING", 600), epoch("still-1", "SEDENTARY", 0)] });
  const both = await store.list("epochs", "2026-10-23", "2026-10-23", 50, 0);
  expect(both.records).toHaveLength(2);

  await push({ epochs: [epoch("walk-2", "WALKING", 640)] });
  const revised = await store.list("epochs", "2026-10-23", "2026-10-23", 50, 0);
  const stored = revised.records.map((row) => row.summaryJSON).join("\n");

  expect(revised.records).toHaveLength(2);
  expect(stored).toContain("walk-2");
  expect(stored).toContain("still-1");
  expect(stored).not.toContain("walk-1");
});

it("withdraws only the affected data category and ignores stale permission events", async () => {
  const id = crypto.randomUUID();
  const store = userStore(env, id);

  await push({ dailies: [record(id)], activities: [record(id)] });
  await push({
    userPermissionsChange: [{ userId: id, permissions: ["HEALTH_EXPORT"], changeTimeInSeconds: 2 }],
  });
  await push({
    userPermissionsChange: [
      { userId: id, permissions: ["HEALTH_EXPORT", "ACTIVITY_EXPORT"], changeTimeInSeconds: 1 },
    ],
  });
  await push({ activities: [record(id)] });
  expect(await store.get("activities", "daily-1")).toBeNull();
  expect(await store.get("dailies", "daily-1")).not.toBeNull();
});

it("logs each rejected delivery with fixed labels and no delivered values", async () => {
  const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
  const id = `private-${crypto.randomUUID()}`;

  await push({
    sleeps: [{ userId: id, summaryId: "private-summary", calendarDate: "not-a-date" }],
  });
  await push({ activityFiles: [{ userId: id, callbackURL: "https://evil.example/file" }] });
  await push({ unknownCategory: [] });
  await push({ dailies: [{ userId: id, summaryId: "ok", calendarDate: "2026-10-23" }] });
  await push({ dailies: [] }, "wrong-credential");

  const lines = logs.mock.calls.map(([line]) => String(line));
  logs.mockRestore();

  expect(lines.map((line) => rejectionLog.parse(JSON.parse(line)))).toEqual([
    { event: "garmin_push_rejected", reason: "invalid_record", type: "sleeps" },
    { event: "garmin_push_rejected", reason: "invalid_record", type: "activityFiles" },
    { event: "garmin_push_rejected", reason: "invalid_payload" },
  ]);
  expect(lines.join("\n")).not.toContain("private-");
  expect(lines.join("\n")).not.toContain("evil.example");
});
