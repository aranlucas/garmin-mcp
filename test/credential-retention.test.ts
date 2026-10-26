import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthBroker } from "../src/auth";
import { userStore } from "../src/push/store";
import { purgeUser } from "../src/push/handler";
import { decodeActivityFile } from "../src/activity/fit";
import { recordedFitFixture, requestUrl, required } from "./support";

interface BrokerFixture extends AuthBroker {
  setReplies(subject: string, values: unknown[]): Promise<void>;
}

type Store = ReturnType<typeof userStore>;

type Unavailable = "null" | "expired" | "malformed";

type Counts = { summaries: number; subscriptions: number; deliveries: number; occurrences: number };

type FileState = { state: string; has_callback: number };

// SAFETY: vitest.config.ts installs this private test entrypoint with setReplies.
const broker = env.AUTH as BrokerFixture;

const credential = (id: string) => ({
  accessToken: `fixture-${id}`,
  expiresAt: Date.now() + 60_000,
  garminUserId: id,
});

function unavailable(kind: Unavailable, id: string) {
  return {
    null: null,
    expired: { ...credential(id), expiresAt: Date.now() - 1 },
    malformed: { ...credential(id), accessToken: "" },
  }[kind];
}

const notification = (id: string, activityId: string) => ({
  userId: id,
  activityId,
  summaryId: `${activityId}-file`,
  fileType: "FIT" as const,
  startTimeInSeconds: 1792807200,
  callbackURL: `https://apis.garmin.com/wellness-api/rest/activityFile?id=${activityId}&token=fixture-only`,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const id = crypto.randomUUID();
  const store = userStore(env, id);
  const authState = { permissionStatus: 200 };

  const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = requestUrl(input);

    if (url.endsWith("/user/permissions")) {
      return Promise.resolve(
        authState.permissionStatus === 200
          ? Response.json({ permissions: ["ACTIVITY_EXPORT", "HEALTH_EXPORT"] })
          : new Response(null, { status: authState.permissionStatus }),
      );
    }

    if (url.includes("/activityFile?")) {
      return Promise.resolve(new Response(recordedFitFixture()));
    }

    expect(url).toBe("https://callback.example.com/retention");

    const body = z
      .object({ challenge: z.string().optional() })
      .parse(JSON.parse(z.string().parse(init?.body)));

    return Promise.resolve(Response.json({ challenge: body.challenge }));
  });

  vi.stubGlobal("fetch", fetcher);

  const subscribed = await store.subscribeEvent(
    { subject: id, garminUserId: id },
    {
      name: "garmin.activity.completed",
      arguments: {},
      delivery: {
        mode: "webhook",
        url: "https://callback.example.com/retention",
        secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
      },
    },
  );

  expect(subscribed.ok).toBe(true);
  await store.ingest([
    {
      type: "dailies",
      summaryId: "health",
      date: "2026-10-26",
      receivedAt: Date.now(),
      data: '{"steps":42}',
    },
    {
      type: "activities",
      summaryId: "123",
      date: "2026-10-26",
      receivedAt: Date.now(),
      data: '{"activityId":123}',
    },
  ]);
  await store.ingestActivityFiles([notification(id, "222")]);
  const cached = await store.claimActivityFile("222");
  await store.finishActivityFile("222", required(cached.version, "cached version"), {
    ...decodeActivityFile(recordedFitFixture()),
    activityId: "222",
    fileSummaryId: "222-file",
    source: "Garmin Activity API FIT file",
  });
  await store.ingestActivityFiles([notification(id, "123")]);
  await store.bindActivityOwner(id, id);
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec("UPDATE event_deliveries SET next_at=?", Date.now() + 600_000);
  });
  fetcher.mockClear();

  return { id, store, fetcher, state: authState };
}

async function retained(store: Store) {
  const counts = await runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<Counts>(`SELECT
      (SELECT count(*) FROM summaries) AS summaries,
      (SELECT count(*) FROM event_subscriptions) AS subscriptions,
      (SELECT count(*) FROM event_deliveries) AS deliveries,
      (SELECT count(*) FROM event_occurrences) AS occurrences`)
      .one(),
  );

  return {
    counts,
    health: await store.get("dailies", "health"),
    cached: await store.claimActivityFile("222"),
  };
}

function fileState(store: Store) {
  return runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<FileState>(
        "SELECT state,callback IS NOT NULL AS has_callback FROM activity_files WHERE activity_id='123'",
      )
      .one(),
  );
}

function makeFileDue(store: Store) {
  return runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec("UPDATE settings SET value=0 WHERE key='fileNextAttempt'");
  });
}

function makeEventDue(store: Store) {
  return runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO settings VALUES ('fileNextAttempt',?)",
      Date.now() + 600_000,
    );
    state.storage.sql.exec("UPDATE event_deliveries SET next_at=0");
  });
}

it.each<Unavailable>(["null", "expired", "malformed"])(
  "preserves all retained state and retries an unclaimed file after a %s broker reply",
  async (kind) => {
    const f = await fixture();
    const before = await retained(f.store);
    expect(before.counts).toEqual({
      summaries: 2,
      subscriptions: 1,
      deliveries: 1,
      occurrences: 1,
    });
    await broker.setReplies(f.id, [unavailable(kind, f.id)]);
    const started = Date.now();
    expect(await runDurableObjectAlarm(f.store)).toBe(true);
    expect(await f.store.isRevoked()).toBe(false);
    expect(await retained(f.store)).toEqual(before);
    expect(await fileState(f.store)).toEqual({ state: "pending", has_callback: 1 });
    expect(f.fetcher).not.toHaveBeenCalled();
    const alarm = await runInDurableObject(f.store, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(started + 60_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000);

    await broker.setReplies(f.id, []);
    await makeFileDue(f.store);
    // Simulate an abrupt restart; recovery must depend on durable state, not the old instance.
    await abortAllDurableObjects();
    f.store = userStore(env, f.id);
    await runDurableObjectAlarm(f.store);
    expect(await f.store.claimActivityFile("123")).toMatchObject({ state: "available" });
    expect(await retained(f.store)).toEqual(before);
  },
);

it.each<Unavailable>(["null", "expired", "malformed"])(
  "preserves unrelated state after a post-download %s reply and never retries the consumed URL",
  async (kind) => {
    const f = await fixture();
    const before = await retained(f.store);
    await broker.setReplies(f.id, [credential(f.id), unavailable(kind, f.id)]);
    await runDurableObjectAlarm(f.store);
    expect(await f.store.isRevoked()).toBe(false);
    expect(await retained(f.store)).toEqual(before);
    expect(await fileState(f.store)).toEqual({ state: "download_failed", has_callback: 0 });
    expect(
      f.fetcher.mock.calls.filter(([input]) => requestUrl(input).includes("/activityFile?")),
    ).toHaveLength(1);

    await broker.setReplies(f.id, []);
    await makeFileDue(f.store);
    await f.store.ingestActivityFiles([notification(f.id, "123")]);
    await abortAllDurableObjects();
    f.store = userStore(env, f.id);
    await runDurableObjectAlarm(f.store);
    expect(await fileState(f.store)).toEqual({ state: "download_failed", has_callback: 0 });
    expect(
      f.fetcher.mock.calls.filter(([input]) => requestUrl(input).includes("/activityFile?")),
    ).toHaveLength(1);
  },
);

it("retries an event authorization null without deleting the subscription or sending data", async () => {
  const f = await fixture();
  await runInDurableObject(f.store, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO settings VALUES ('fileNextAttempt',?)",
      Date.now() + 600_000,
    );
    state.storage.sql.exec("UPDATE event_deliveries SET next_at=0");
  });
  await broker.setReplies(f.id, [null]);
  await runDurableObjectAlarm(f.store);
  expect((await retained(f.store)).counts).toEqual({
    summaries: 2,
    subscriptions: 1,
    deliveries: 1,
    occurrences: 1,
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  await broker.setReplies(f.id, []);
  await runInDurableObject(f.store, (_instance, state) => {
    state.storage.sql.exec("UPDATE event_deliveries SET next_at=0");
  });
  await runDurableObjectAlarm(f.store);
  expect((await retained(f.store)).counts).toEqual({
    summaries: 2,
    subscriptions: 1,
    deliveries: 0,
    occurrences: 0,
  });
  expect(
    f.fetcher.mock.calls.some(([input]) => requestUrl(input).includes("callback.example.com")),
  ).toBe(true);
});

it.each([401, 403, 412])(
  "retains event subscriptions when permission lookup returns HTTP %s",
  async (status) => {
    const f = await fixture();
    f.state.permissionStatus = status;
    await makeEventDue(f.store);
    await runDurableObjectAlarm(f.store);
    expect((await retained(f.store)).counts).toEqual({
      summaries: 2,
      subscriptions: 1,
      deliveries: 1,
      occurrences: 1,
    });
    expect(
      f.fetcher.mock.calls.every(([input]) => requestUrl(input).endsWith("/user/permissions")),
    ).toBe(true);
    f.state.permissionStatus = 200;
    await makeEventDue(f.store);
    await runDurableObjectAlarm(f.store);
    expect((await retained(f.store)).counts).toEqual({
      summaries: 2,
      subscriptions: 1,
      deliveries: 0,
      occurrences: 0,
    });
  },
);

it.each(["before", "after"])(
  "still revokes a verified account mismatch %s the download",
  async (stage) => {
    const f = await fixture();
    const mismatch = credential("different-account");
    await broker.setReplies(f.id, stage === "before" ? [mismatch] : [credential(f.id), mismatch]);
    await runDurableObjectAlarm(f.store);
    expect(await f.store.isRevoked()).toBe(true);
    expect((await retained(f.store)).counts).toEqual({
      summaries: 0,
      subscriptions: 0,
      deliveries: 0,
      occurrences: 0,
    });
    expect(await f.store.claimActivityFile("222")).toMatchObject({ state: "permission_denied" });
  },
);

it("authenticated explicit disconnect still purges all data and blocks late delivery", async () => {
  const f = await fixture();

  const response = await purgeUser(
    new Request("https://worker.example/garmin/disconnect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GARMIN_PUSH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: f.id, action: "disconnect" }),
    }),
    env,
  );

  expect(response.status).toBe(204);
  expect(await f.store.isRevoked()).toBe(true);
  await f.store.ingestActivityFiles([notification(f.id, "123")]);
  expect((await retained(f.store)).counts).toEqual({
    summaries: 0,
    subscriptions: 0,
    deliveries: 0,
    occurrences: 0,
  });
  expect(await f.store.claimActivityFile("123")).toMatchObject({ state: "permission_denied" });
});
