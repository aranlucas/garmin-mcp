import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { expect, it, onTestFinished, vi } from "vitest";
import { createServer } from "../src/mcp";
import { userStore } from "../src/push/store";
import { requestUrl } from "./support";
import { receivePush } from "../src/push/handler";
import { summaryType } from "../src/push/schemas";
import { z } from "zod";

const categories = {
  health: [
    "dailies",
    "epochs",
    "sleeps",
    "bodyComps",
    "stressDetails",
    "userMetrics",
    "pulseox",
    "allDayRespiration",
    "healthSnapshot",
    "hrv",
    "bloodPressures",
    "skinTemp",
    "nutrition",
    "hydration",
    "breathingVariations",
  ],
  activity: ["activities", "activityDetails", "manuallyUpdatedActivities", "moveIQActivities"],
};

async function connect(garminId: string, permissions: string[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
    expect(requestUrl(input)).toBe("https://apis.garmin.com/partner-gateway/rest/user/permissions");

    return Promise.resolve(Response.json({ permissions }));
  });

  const store = userStore(env, garminId);
  const server = createServer("private-access", store, fetcher);
  const client = new Client({ name: "summary-protocol-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, store, fetcher };
}

it("gathers every day category with health measurements and lightweight activity references", async () => {
  const id = crypto.randomUUID();
  const { client, store, fetcher } = await connect(id, ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]);
  const date = "2026-10-23";

  const delivered = await receivePush(
    new Request("https://delivery.example/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        Object.fromEntries(
          summaryType.options.map((type) => [
            type,
            [
              {
                userId: id,
                summaryId: `${type}-1`,
                calendarDate: date,
                activityId: 123,
                value: 0,
                measurements: [{ value: 12, unit: "provider-unit", accessToken: "private-field" }],
                samples: [{ value: 34 }],
              },
            ],
          ]),
        ),
      ),
    }),
    env,
    env.GARMIN_PUSH_TOKEN,
  );

  expect(delivered.status).toBe(200);
  await store.ingest([
    {
      type: "hrv",
      summaryId: "another-day",
      date: "2026-10-22",
      receivedAt: Date.now(),
      data: '{"summaryId":"another-day","value":999}',
    },
  ]);
  await userStore(env, crypto.randomUUID()).ingest([
    {
      type: "hrv",
      summaryId: "another-account",
      date,
      receivedAt: Date.now(),
      data: '{"summaryId":"another-account","value":999}',
    },
  ]);
  fetcher.mockClear();

  const day = await client.callTool({ name: "get_garmin_day", arguments: { date } });

  expect(day.isError).not.toBe(true);

  expect(summaryType.options.toSorted()).toEqual(
    [...categories.health, ...categories.activity].toSorted(),
  );

  for (const type of [...categories.health, ...categories.activity]) {
    const reference = { summaryId: `${type}-1` };

    expect(day.structuredContent).toMatchObject({
      source: "Garmin Connect",
      data: {
        date,
        sections: {
          [type]: {
            availability: "available",
            records: [
              categories.activity.includes(type)
                ? { ...reference, activityId: "123" }
                : {
                    ...reference,
                    summary: {
                      summaryId: `${type}-1`,
                      value: 0,
                      measurements: [{ value: 12, unit: "provider-unit" }],
                    },
                  },
            ],
            hasMore: false,
            nextOffset: null,
          },
        },
      },
    });
  }

  expect(day.structuredContent).not.toHaveProperty(
    "data.sections.activityDetails.records.0.summary",
  );
  expect(day.structuredContent).not.toHaveProperty(
    "data.sections.activityDetails.records.0.samples",
  );

  const serialized = JSON.stringify(day);
  expect(serialized).not.toContain("another-day");
  expect(serialized).not.toContain("another-account");
  expect(serialized).not.toContain("private-field");
  expect(serialized).not.toContain("private-access");
  expect(serialized).not.toContain(id);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  { permissions: ["HEALTH_EXPORT"], health: "not_received", activity: "permission_denied" },
  { permissions: ["ACTIVITY_EXPORT"], health: "permission_denied", activity: "not_received" },
  { permissions: [], health: "permission_denied", activity: "permission_denied" },
])("distinguishes missing day data from denied permissions: $permissions", async (testCase) => {
  const { client, store } = await connect(crypto.randomUUID(), testCase.permissions);
  // Stored data must remain inaccessible even if upstream permissions change without a push.
  await store.ingest(
    ["hrv", "activities"].map((type) => ({
      type: summaryType.parse(type),
      summaryId: "protected-record",
      date: "2026-10-22",
      receivedAt: Date.now(),
      data: '{"summaryId":"protected-record","value":999}',
    })),
  );

  const day = await client.callTool({
    name: "get_garmin_day",
    arguments: { date: "2026-10-22" },
  });

  const deniedType = testCase.health === "permission_denied" ? "hrv" : "activities";
  expect(day.structuredContent).toMatchObject({
    data: {
      sections: {
        [deniedType]: {
          availability: "permission_denied",
          records: [],
          hasMore: false,
          nextOffset: null,
        },
        bloodPressures: { availability: testCase.health, records: [] },
        moveIQActivities: { availability: testCase.activity, records: [] },
      },
    },
  });
});

it("keeps multiple measurements and exposes pagination back to the summary tools", async () => {
  const { client, store } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);
  const date = "2026-10-23";
  const receivedAt = Date.parse("2026-10-24T01:02:03.000Z");
  await store.ingest(
    ["bp-1", "bp-2", "bp-3"].map((summaryId) => ({
      type: "bloodPressures" as const,
      summaryId,
      date,
      receivedAt,
      data: JSON.stringify({ summaryId, systolic: 120 }),
    })),
  );

  const day = await client.callTool({
    name: "get_garmin_day",
    arguments: { date, limitPerType: 2 },
  });

  expect(day.structuredContent).toMatchObject({
    data: {
      sections: {
        bloodPressures: {
          availability: "available",
          records: [
            { summaryId: "bp-1", receivedAt: "2026-10-24T01:02:03.000Z" },
            { summaryId: "bp-2", receivedAt: "2026-10-24T01:02:03.000Z" },
          ],
          hasMore: true,
          nextOffset: 2,
        },
        hrv: { availability: "not_received", records: [], hasMore: false, nextOffset: null },
      },
    },
  });

  const remaining = await client.callTool({
    name: "list_garmin_summaries",
    arguments: { type: "bloodPressures", startDate: date, endDate: date, offset: 2 },
  });

  expect(remaining.structuredContent).toMatchObject({
    data: { records: [{ summary: { summaryId: "bp-3" } }], hasMore: false },
  });
});

it("uses the stored device-local date and tolerates activity references without activity IDs", async () => {
  const id = crypto.randomUUID();
  const { client } = await connect(id, ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]);
  await receivePush(
    new Request("https://delivery.example/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hrv: [
          {
            userId: id,
            summaryId: "device-local",
            startTimeInSeconds: Date.parse("2026-10-24T01:00:00Z") / 1000,
            startTimeOffsetInSeconds: -7 * 3600,
          },
        ],
        moveIQActivities: [{ userId: id, summaryId: "move-iq", calendarDate: "2026-10-23" }],
      }),
    }),
    env,
    env.GARMIN_PUSH_TOKEN,
  );

  const day = await client.callTool({
    name: "get_garmin_day",
    arguments: { date: "2026-10-23" },
  });

  expect(day.structuredContent).toMatchObject({
    data: {
      sections: {
        hrv: { records: [{ summaryId: "device-local" }] },
        moveIQActivities: { records: [{ summaryId: "move-iq", activityId: null }] },
      },
    },
  });
});

it("blocks day reads after revocation and fails safely when current permissions are unavailable", async () => {
  const { client, store, fetcher } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);
  await store.revoke();

  const day = await client.callTool({
    name: "get_garmin_day",
    arguments: { date: "2026-10-23" },
  });

  expect(day.structuredContent).toMatchObject({
    data: {
      sections: { hrv: { availability: "permission_denied", records: [] } },
    },
  });

  fetcher.mockRejectedValueOnce(new Error("private-upstream-error"));

  const failed = await client.callTool({
    name: "get_garmin_day",
    arguments: { date: "2026-10-23" },
  });

  expect(failed.isError).toBe(true);
  expect(failed.structuredContent).toBeUndefined();
  expect(JSON.stringify(failed)).not.toContain("private-upstream-error");
});

it.each([
  { date: "2026-02-30" },
  { date: "today" },
  { date: "2026-10-23", userId: "another-account" },
  { date: "2026-10-23", limitPerType: 0 },
  { date: "2026-10-23", limitPerType: 101 },
])("rejects invalid day inputs: $date / $limitPerType", async (args) => {
  const { client, fetcher } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);
  expect((await client.callTool({ name: "get_garmin_day", arguments: args })).isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it("returns only the signed-in account's stored summaries through the MCP protocol", async () => {
  const id = crypto.randomUUID();
  const { client, store } = await connect(id, ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]);
  await store.ingest([
    {
      type: "dailies",
      summaryId: "own",
      date: "2026-10-23",
      receivedAt: Date.now(),
      data: '{"summaryId":"own","steps":123}',
    },
  ]);
  await userStore(env, crypto.randomUUID()).ingest([
    {
      type: "dailies",
      summaryId: "other",
      date: "2026-10-23",
      receivedAt: Date.now(),
      data: '{"summaryId":"other","steps":999}',
    },
  ]);

  const listed = await client.callTool({
    name: "list_garmin_summaries",
    arguments: { type: "dailies", startDate: "2026-10-23", endDate: "2026-10-23" },
  });

  expect(listed.isError).not.toBe(true);
  expect(listed.structuredContent).toMatchObject({
    source: "Garmin Connect",
    data: { records: [{ summary: { summaryId: "own", steps: 123 } }], hasMore: false },
  });
  expect(JSON.stringify(listed)).not.toContain("private-access");
  expect(JSON.stringify(listed)).not.toContain('"other"');

  const detail = await client.callTool({
    name: "get_garmin_summary",
    arguments: { type: "dailies", summaryId: "own" },
  });

  expect(detail.structuredContent).toMatchObject({ data: { steps: 123 } });

  const missing = await client.callTool({
    name: "get_garmin_summary",
    arguments: { type: "dailies", summaryId: "other" },
  });

  expect(missing.structuredContent).toMatchObject({ data: null });

  const invalid = await client.callTool({
    name: "list_garmin_summaries",
    arguments: {
      type: "dailies",
      startDate: "2026-10-23",
      endDate: "2026-12-23",
      userId: "someone-else",
    },
  });

  expect(invalid.isError).toBe(true);
});

it("rechecks Garmin permissions even when data remains stored", async () => {
  const { client, store } = await connect(crypto.randomUUID(), ["WORKOUT_IMPORT"]);
  await store.ingest([
    {
      type: "dailies",
      summaryId: "blocked",
      date: "2026-10-23",
      receivedAt: Date.now(),
      data: '{"steps":123}',
    },
  ]);

  const denied = await client.callTool({
    name: "get_garmin_summary",
    arguments: { type: "dailies", summaryId: "blocked" },
  });

  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).not.toContain("123");
});

it("requires explicit confirmation before deleting stored data and can collect afterward", async () => {
  const { client, store } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);

  const row = {
    type: "dailies" as const,
    summaryId: "delete",
    date: "2026-10-23",
    receivedAt: Date.now(),
    data: '{"steps":123}',
  };

  await store.ingest([row]);
  expect(
    (await client.callTool({ name: "delete_stored_garmin_data", arguments: { confirm: false } }))
      .isError,
  ).toBe(true);
  expect(await store.get("dailies", "delete")).not.toBeNull();
  expect(
    (await client.callTool({ name: "delete_stored_garmin_data", arguments: { confirm: true } }))
      .structuredContent,
  ).toMatchObject({ data: { deleted: true } });
  expect(await store.get("dailies", "delete")).toBeNull();
  await store.ingest([row]);
  expect(await store.get("dailies", "delete")).not.toBeNull();
});

it.each([
  {
    name: "a Garmin rate limit",
    reply: () => Promise.resolve(new Response(null, { status: 429 })),
    says: "rate limit",
    reconnect: false,
  },
  {
    name: "a Garmin outage",
    reply: () => Promise.resolve(new Response(null, { status: 503 })),
    says: "could not be reached",
    reconnect: false,
  },
  {
    name: "a network failure",
    reply: () => Promise.reject(new Error("private-upstream-error")),
    says: "could not be reached",
    reconnect: false,
  },
  {
    name: "a rejected Garmin token",
    reply: () => Promise.resolve(new Response(null, { status: 401 })),
    says: "expired or was revoked",
    reconnect: true,
  },
])("explains $name without wrongly advising a reconnect", async ({ reply, says, reconnect }) => {
  const { client, fetcher } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);
  const range = { startDate: "2026-10-23", endDate: "2026-10-23" };

  const calls = [
    { name: "get_garmin_day", arguments: { date: "2026-10-23" } },
    { name: "get_garmin_week", arguments: { startDate: "2026-10-19" } },
    { name: "list_garmin_summaries", arguments: { type: "dailies", ...range } },
    { name: "get_garmin_summary", arguments: { type: "dailies", summaryId: "any" } },
    { name: "get_garmin_activity", arguments: { activityId: "123" } },
  ];

  for (const call of calls) {
    fetcher.mockImplementationOnce(reply);
    // oxlint-disable-next-line no-await-in-loop -- Each tool consumes one queued Garmin reply.
    const text = JSON.stringify(await client.callTool(call));

    expect(text).toContain('"isError":true');
    expect(text).toContain(says);
    expect(/reconnect/i.test(text)).toBe(reconnect);
    expect(text).not.toContain("private-upstream-error");
  }
});

it("names the missing sharing permission instead of a generic failure", async () => {
  const { client } = await connect(crypto.randomUUID(), ["ACTIVITY_EXPORT"]);

  const text = JSON.stringify(
    await client.callTool({
      name: "list_garmin_summaries",
      arguments: { type: "dailies", startDate: "2026-10-23", endDate: "2026-10-23" },
    }),
  );

  expect(text).toContain('"isError":true');
  expect(text).toContain("sharing permission");
});

function dailiesOn(userId: string, dates: string[]) {
  return dates.map((calendarDate) => ({
    userId,
    summaryId: `dailies-${calendarDate}`,
    calendarDate,
    steps: 0,
    timeOffsetHeartRateSamples: { "0": 61, "15": 62 },
  }));
}

async function deliver(body: Record<string, unknown[]>) {
  const response = await receivePush(
    new Request("https://delivery.example/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    env.GARMIN_PUSH_TOKEN,
  );

  expect(response.status).toBe(200);
}

const week = [
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
  "2026-10-24",
  "2026-10-25",
];

it("reviews seven dates with a per-category coverage matrix and cited, sample-free evidence", async () => {
  const id = crypto.randomUUID();
  const { client, fetcher } = await connect(id, ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]);

  await deliver({
    // Six of seven dates, plus one record on each side of the week that must not be counted.
    dailies: dailiesOn(id, ["2026-10-18", ...week.slice(0, 6), "2026-10-26"]),
    sleeps: [
      { userId: id, summaryId: "sleep-1", calendarDate: "2026-10-20", durationInSeconds: 0 },
    ],
    hrv: [{ userId: id, summaryId: "hrv-1", calendarDate: "2026-10-22", lastNightAvg: 41 }],
    activities: ["run-1", "run-2"].map((summaryId, index) => ({
      userId: id,
      summaryId,
      activityId: 9001 + index,
      calendarDate: "2026-10-21",
      activityType: "RUNNING",
      durationInSeconds: 1800,
      samples: [{ heartRate: 150 }],
    })),
  });
  // Another account's daily summary must not fill this account's missing date.
  await userStore(env, crypto.randomUUID()).ingest([
    {
      type: "dailies",
      summaryId: "another-account",
      date: "2026-10-25",
      receivedAt: Date.now(),
      data: '{"summaryId":"another-account"}',
    },
  ]);
  fetcher.mockClear();

  const review = await client.callTool({
    name: "get_garmin_week",
    arguments: { startDate: "2026-10-19" },
  });

  expect(review.isError).not.toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);

  const absent = Object.fromEntries(week.map((date) => [date, 0]));

  expect(review.structuredContent).toMatchObject({
    source: "Garmin Connect",
    data: {
      startDate: "2026-10-19",
      endDate: "2026-10-25",
      dates: week,
      complete: false,
      missingDates: ["2026-10-25"],
      unavailableCategories: [],
      coverage: {
        dailies: {
          availability: "available",
          counts: { ...Object.fromEntries(week.map((date) => [date, 1])), "2026-10-25": 0 },
        },
        activities: { availability: "available", counts: { ...absent, "2026-10-21": 2 } },
        hrv: { availability: "available", counts: { ...absent, "2026-10-22": 1 } },
        bloodPressures: { availability: "not_received", counts: absent },
        activityDetails: { availability: "not_received", counts: absent },
      },
      evidence: {
        sleeps: {
          availability: "available",
          records: [
            {
              date: "2026-10-20",
              summaryId: "sleep-1",
              fields: { summaryId: "sleep-1", durationInSeconds: 0 },
            },
          ],
          hasMore: false,
          nextOffset: null,
        },
        activities: {
          availability: "available",
          records: [
            {
              date: "2026-10-21",
              summaryId: "run-1",
              activityId: "9001",
              fields: { activityType: "RUNNING", durationInSeconds: 1800 },
            },
            { date: "2026-10-21", summaryId: "run-2", activityId: "9002" },
          ],
          hasMore: false,
        },
      },
    },
  });

  const { data } = z
    .object({
      data: z.object({
        evidence: z.object({
          dailies: z.object({
            records: z.array(
              z.object({ date: z.string(), fields: z.record(z.string(), z.json()) }),
            ),
          }),
        }),
      }),
    })
    .parse(review.structuredContent);

  expect(data.evidence.dailies.records.map((record) => record.date)).toEqual(week.slice(0, 6));
  // Zero stays a measurement; nested samples stay behind get_garmin_day.
  expect(data.evidence.dailies.records[0]?.fields).toEqual({
    summaryId: "dailies-2026-10-19",
    calendarDate: "2026-10-19",
    steps: 0,
  });

  const serialized = JSON.stringify(review);
  expect(serialized).not.toContain("samples");
  expect(serialized).not.toContain("timeOffsetHeartRateSamples");
  expect(serialized).not.toContain("another-account");
  expect(serialized).not.toContain("dailies-2026-10-18");
  expect(serialized).not.toContain("dailies-2026-10-26");
  expect(serialized).not.toContain(id);
  expect(serialized).not.toContain("private-access");
});

it("marks a week complete only when every date has a daily summary and nothing is withheld", async () => {
  const id = crypto.randomUUID();
  const { client } = await connect(id, ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]);
  await deliver({ dailies: dailiesOn(id, week) });

  const review = await client.callTool({
    name: "get_garmin_week",
    arguments: { startDate: "2026-10-19" },
  });

  expect(review.structuredContent).toMatchObject({
    data: { complete: true, missingDates: [], unavailableCategories: [] },
  });
});

it.each([
  {
    permissions: ["HEALTH_EXPORT"],
    withheld: ["activities", "activityDetails", "manuallyUpdatedActivities", "moveIQActivities"],
    missingDates: ["2026-10-25"],
  },
  {
    permissions: ["ACTIVITY_EXPORT"],
    withheld: categories.health,
    missingDates: week,
  },
])(
  "withholds records and counts for denied categories: $permissions",
  async ({ permissions, withheld, missingDates }) => {
    const id = crypto.randomUUID();
    const { client } = await connect(id, permissions);
    // Stored before access changed: still unreadable while Garmin reports the permission missing.
    await deliver({
      dailies: dailiesOn(id, week.slice(0, 6)),
      activities: [{ userId: id, summaryId: "hidden-run", activityId: 1, calendarDate: week[0] }],
    });

    const review = await client.callTool({
      name: "get_garmin_week",
      arguments: { startDate: "2026-10-19" },
    });

    const denied = withheld.includes("activities") ? "activities" : "dailies";

    expect(review.structuredContent).toMatchObject({
      data: {
        complete: false,
        missingDates,
        unavailableCategories: withheld,
        coverage: { [denied]: { availability: "permission_denied", counts: null } },
        evidence: {
          [denied]: { availability: "permission_denied", records: [], hasMore: false },
        },
      },
    });
    expect(JSON.stringify(review)).not.toContain(
      denied === "activities" ? "hidden-run" : "dailies-2026-10-19",
    );
  },
);

it("withholds the whole week after revocation", async () => {
  const id = crypto.randomUUID();
  const { client, store } = await connect(id, ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]);
  await deliver({ dailies: dailiesOn(id, week) });
  await store.revoke();

  const review = await client.callTool({
    name: "get_garmin_week",
    arguments: { startDate: "2026-10-19" },
  });

  expect(review.structuredContent).toMatchObject({
    data: {
      complete: false,
      missingDates: week,
      unavailableCategories: summaryType.options,
      coverage: { dailies: { availability: "permission_denied", counts: null } },
    },
  });
});

it("pages week evidence back to list_garmin_summaries over the same dates", async () => {
  const id = crypto.randomUUID();
  const { client } = await connect(id, ["ACTIVITY_EXPORT"]);
  await deliver({
    activities: ["a", "b", "c"].map((summaryId, index) => ({
      userId: id,
      summaryId,
      activityId: index + 1,
      calendarDate: week[index],
    })),
  });

  const review = await client.callTool({
    name: "get_garmin_week",
    arguments: { startDate: "2026-10-19", limitPerType: 2 },
  });

  expect(review.structuredContent).toMatchObject({
    data: {
      coverage: { activities: { counts: { "2026-10-21": 1 } } },
      evidence: {
        activities: {
          records: [{ summaryId: "a" }, { summaryId: "b" }],
          hasMore: true,
          nextOffset: 2,
        },
      },
    },
  });

  const remaining = await client.callTool({
    name: "list_garmin_summaries",
    arguments: {
      type: "activities",
      startDate: "2026-10-19",
      endDate: "2026-10-25",
      offset: 2,
    },
  });

  expect(remaining.structuredContent).toMatchObject({
    data: { records: [{ summary: { summaryId: "c" } }], hasMore: false },
  });
});

it("spans month, year and leap-day boundaries in calendar dates", async () => {
  const { client } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);

  for (const [startDate, dates] of [
    [
      "2026-12-29",
      [
        "2026-12-29",
        "2026-12-30",
        "2026-12-31",
        "2027-01-01",
        "2027-01-02",
        "2027-01-03",
        "2027-01-04",
      ],
    ],
    [
      "2028-02-26",
      [
        "2028-02-26",
        "2028-02-27",
        "2028-02-28",
        "2028-02-29",
        "2028-03-01",
        "2028-03-02",
        "2028-03-03",
      ],
    ],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- Each case is asserted on its own.
    const review = await client.callTool({ name: "get_garmin_week", arguments: { startDate } });

    expect(review.structuredContent).toMatchObject({
      data: { startDate, endDate: dates[6], dates },
    });
  }
});

it.each([
  { startDate: "2026-02-30" },
  { startDate: "this week" },
  { startDate: "2026-10-19", endDate: "2026-10-30" },
  { startDate: "2026-10-19", userId: "another-account" },
  { startDate: "2026-10-19", limitPerType: 0 },
  { startDate: "2026-10-19", limitPerType: 101 },
])("rejects invalid week inputs: %o", async (args) => {
  const { client, fetcher } = await connect(crypto.randomUUID(), ["HEALTH_EXPORT"]);
  expect((await client.callTool({ name: "get_garmin_week", arguments: args })).isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
