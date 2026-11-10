import { DurableObject } from "cloudflare:workers";
import { summaryPermission, type SummaryType, type StoredSummary } from "./schemas";
import { GarminEvents } from "../events/store";
import { logEvent, type IngestDiagnostic } from "../events/diagnostics";
import { ActivityFiles } from "../activity/store";
import type { ActivityFileNotification, FitDetails } from "../activity/files";
import { decodeClaimedActivityFile } from "../activity/files";
import { classifyGarminCredential, type AuthBroker, type GarminCredential } from "../auth";
import { TrainingClient } from "../training/client";
import {
  eventPermission,
  eventReply,
  type EventOwner,
  type SubscribeParams,
  type UnsubscribeParams,
} from "../events/protocol";

type DataRow = { data: string };

type ReceivedRow = DataRow & { received_at: number };

type ValueRow = { value: number };

type TypeRow = { type: SummaryType };

type ActivitySummaryRow = DataRow & { type: string };

type ActivityOwner = { subject: string; garmin_id: string };

// Garmin sends one epoch per activity type for the same window, so only a revision of the same
// activity type replaces an earlier epoch. Every other category keeps one row per start time.
const SAME_SLOT =
  "(type<>'epochs' OR json_extract(data,'$.activityType') IS json_extract(?,'$.activityType'))";

/** One SQLite object per immutable Garmin account ID, never per client-supplied tool input. */
export class GarminUserData extends DurableObject<Env> {
  private readonly events: GarminEvents;
  private readonly files: ActivityFiles;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS summaries (type TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, received_at INTEGER NOT NULL, data TEXT NOT NULL, start_time INTEGER, duration INTEGER, PRIMARY KEY(type,id))`,
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS summaries_date ON summaries(type,date,id)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS summaries_start ON summaries(type,start_time)",
    );
    this.files = new ActivityFiles(this.ctx.storage.sql);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS activity_owner (id INTEGER PRIMARY KEY CHECK(id=1),subject TEXT NOT NULL,garmin_id TEXT NOT NULL)",
    );
    this.events = new GarminEvents(
      ctx,
      env,
      (name) => this.isRevoked() || this.setting(eventPermission(name)) === 0,
      () => this.schedule(),
    );
  }
  async ingest(records: StoredSummary[]) {
    await this.events.prepareIngest();

    if (this.isRevoked()) {
      return;
    }

    const diagnostics: IngestDiagnostic[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const row of records) {
        const permission = summaryPermission(row.type);

        if (this.setting(permission) === 0) {
          continue;
        }

        const known =
          this.ctx.storage.sql
            .exec(
              "SELECT id FROM summaries WHERE type=? AND (id=? OR (? IS NOT NULL AND start_time=?)) LIMIT 1",
              row.type,
              row.summaryId,
              row.startTime ?? null,
              row.startTime ?? null,
            )
            .toArray().length > 0;

        if (row.startTime !== undefined) {
          const newer = this.ctx.storage.sql
            .exec(
              `SELECT id FROM summaries WHERE type=? AND start_time=? AND duration>? AND ${SAME_SLOT}`,
              row.type,
              row.startTime,
              row.duration ?? 0,
              row.data,
            )
            .toArray();

          if (newer.length) {
            continue;
          }

          this.ctx.storage.sql.exec(
            `DELETE FROM summaries WHERE type=? AND start_time=? AND id<>? AND ${SAME_SLOT}`,
            row.type,
            row.startTime,
            row.summaryId,
            row.data,
          );
        }

        this.ctx.storage.sql.exec(
          "INSERT INTO summaries VALUES (?,?,?,?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET date=excluded.date,received_at=excluded.received_at,data=excluded.data,start_time=excluded.start_time,duration=excluded.duration WHERE json_extract(excluded.data,'$.importSource') IS NOT 'garmin-personal-api' OR json_extract(summaries.data,'$.importSource') = 'garmin-personal-api'",
          row.type,
          row.summaryId,
          row.date,
          row.receivedAt,
          row.data,
          row.startTime ?? null,
          row.duration ?? null,
        );
        const diagnostic = this.events.enqueue(row, known);

        if (diagnostic) {
          diagnostics.push(diagnostic);
        }
      }
    });

    // An aborted batch must never report a queued event as durable acceptance.
    for (const diagnostic of diagnostics) {
      logEvent(diagnostic);
    }

    await this.schedule();
  }
  list(type: SummaryType, startDate: string, endDate: string, limit: number, offset: number) {
    const rows = this.ctx.storage.sql
      .exec<ReceivedRow>(
        "SELECT data,received_at FROM summaries WHERE type=? AND date>=? AND date<=? ORDER BY date,id LIMIT ? OFFSET ?",
        type,
        startDate,
        endDate,
        limit + 1,
        offset,
      )
      .toArray();

    return {
      records: rows.slice(0, limit).map((row) => ({
        receivedAt: new Date(row.received_at).toISOString(),
        summaryJSON: row.data,
      })),
      hasMore: rows.length > limit,
    };
  }
  get(type: SummaryType, id: string) {
    const row = this.ctx.storage.sql
      .exec<DataRow>("SELECT data FROM summaries WHERE type=? AND id=?", type, id)
      .toArray()[0];

    return row?.data ?? null;
  }
  getActivity(activityId: string) {
    const rows = this.ctx.storage.sql
      .exec<ActivitySummaryRow>(
        "SELECT type,data FROM summaries WHERE type IN ('activities','manuallyUpdatedActivities','activityDetails') AND CAST(json_extract(data,'$.activityId') AS TEXT)=? ORDER BY received_at DESC",
        activityId,
      )
      .toArray();

    const activity = rows.find((row) => row.type !== "activityDetails");
    const details = rows.find((row) => row.type === "activityDetails");

    return rows.length || this.files.has(activityId)
      ? { summary: activity?.data ?? null, details: details?.data ?? null }
      : null;
  }
  private activityBlocked() {
    return this.isRevoked() || this.setting("ACTIVITY_EXPORT") === 0;
  }
  private activityOwner() {
    return this.ctx.storage.sql
      .exec<ActivityOwner>("SELECT subject,garmin_id FROM activity_owner WHERE id=1")
      .toArray()[0];
  }
  private async schedule() {
    const candidates = [this.events.nextAlarm(), this.nextActivityWork()].filter(
      (time) => time !== null,
    );

    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...candidates)));
    }
  }
  private nextActivityWork() {
    const expires = this.files.nextExpiry();

    if (!this.activityOwner() || !this.files.pendingId()) {
      return expires;
    }

    const attempt = this.setting("fileNextAttempt") ?? Date.now() + 2000;

    return Math.min(expires ?? attempt, attempt);
  }
  async bindActivityOwner(subject: string, garminUserId: string) {
    const existing = this.activityOwner();

    if (existing?.subject === subject && existing.garmin_id === garminUserId) {
      return;
    }

    await this.ctx.storage.setAlarm(Date.now() + 1000);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO activity_owner VALUES (1,?,?)",
      subject,
      garminUserId,
    );
    await this.schedule();
  }
  private pendingActivityDownload() {
    const owner = this.activityOwner();
    const activityId = this.files.pendingId();

    if (!owner || !activityId || this.activityBlocked()) {
      return;
    }

    if ((this.setting("fileNextAttempt") ?? 0) > Date.now()) {
      return;
    }

    this.setSetting("fileNextAttempt", Date.now() + 60_000);

    return { owner, activityId };
  }

  private async activityCredential(owner: ActivityOwner): Promise<GarminCredential | null> {
    // SAFETY: AUTH is the existing private GarminTokens RPC contract, validated below.
    const broker = this.env.AUTH as AuthBroker;

    const access = classifyGarminCredential(
      await broker.accessToken(owner.subject),
      owner.garmin_id,
      Date.now(),
    );

    if (access.status === "mismatch") {
      await this.revoke();

      return null;
    }

    return access.status === "allowed" ? access.credential : null;
  }

  private async activityPermission(client: TrainingClient) {
    if ((await client.getPermissions()).includes("ACTIVITY_EXPORT")) {
      return true;
    }

    this.files.clear();

    return false;
  }

  private async downloadClaimedFile(
    owner: ActivityOwner,
    activityId: string,
    credential: GarminCredential,
    client: TrainingClient,
  ) {
    const file = this.files.claim(activityId);

    if (!file.callback || !file.version || !file.summaryId) {
      return;
    }

    const decoded = await decodeClaimedActivityFile(
      file.callback,
      credential.accessToken,
      AbortSignal.timeout(20_000),
      fetch,
      activityId,
      file.summaryId,
    );

    if (!(await this.activityPermission(client))) {
      return;
    }

    const current = await this.activityCredential(owner);
    // After claim, failed authorization discards this payload, never unrelated retained data.
    this.finishActivityFile(activityId, file.version, current ? decoded : null);

    if (current) {
      this.setSetting("fileNextAttempt", Date.now() + 2000);
    }
  }

  private async downloadActivityFile() {
    const pending = this.pendingActivityDownload();

    if (!pending) {
      return;
    }

    try {
      const credential = await this.activityCredential(pending.owner);

      if (!credential) {
        return;
      }

      const client = new TrainingClient(credential.accessToken);

      if (!(await this.activityPermission(client)) || this.activityBlocked()) {
        return;
      }

      await this.downloadClaimedFile(pending.owner, pending.activityId, credential, client);
    } catch {
      // Retry unclaimed jobs; claimed URLs stay consumed and become unavailable on claim expiry.
    }
  }
  async ingestActivityFiles(files: ActivityFileNotification[]) {
    // Persist a wake-up before accepting token-bearing metadata, as with the event outbox.
    await this.ctx.storage.setAlarm(Date.now() + 1000);

    if (!this.activityBlocked()) {
      this.ctx.storage.transactionSync(() => {
        for (const file of files) {
          this.files.ingest(file);
        }
      });
    }

    await this.schedule();
  }
  async claimActivityFile(activityId: string) {
    if (this.activityBlocked()) {
      return { state: "permission_denied" };
    }

    const claimed = this.files.claim(activityId);
    await this.schedule();

    return claimed;
  }
  finishActivityFile(activityId: string, version: string, data: FitDetails | null) {
    return this.activityBlocked()
      ? null
      : this.ctx.storage.transactionSync(() => this.files.finish(activityId, version, data));
  }
  clear() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM summaries");
      this.files.clear();
      this.events.clear();
    });

    return this.schedule();
  }
  revoke() {
    // Keep a tombstone: late delivery retries cannot restore withdrawn health data.
    this.setSetting("revoked", 1);
    this.ctx.storage.sql.exec("DELETE FROM activity_owner");

    return this.clear();
  }
  activate() {
    this.ctx.storage.sql.exec("DELETE FROM settings");
  }
  permissions(permissions: string[], changedAt: number) {
    if (changedAt <= (this.setting("permissionTime") ?? -1)) {
      return;
    }

    this.ctx.storage.transactionSync(() => {
      this.setSetting("permissionTime", changedAt);

      for (const permission of ["HEALTH_EXPORT", "ACTIVITY_EXPORT"]) {
        const allowed = permissions.includes(permission);
        this.setSetting(permission, allowed ? 1 : 0);

        if (!allowed) {
          if (permission === "ACTIVITY_EXPORT") {
            this.files.clear();
          }

          this.events.clear(permission);

          for (const row of this.ctx.storage.sql
            .exec<TypeRow>("SELECT DISTINCT type FROM summaries")
            .toArray()) {
            if (summaryPermission(row.type) === permission) {
              this.ctx.storage.sql.exec("DELETE FROM summaries WHERE type=?", row.type);
            }
          }
        }
      }
    });

    return this.schedule();
  }
  isRevoked() {
    return this.setting("revoked") !== undefined;
  }
  private setting(key: string): number | undefined {
    return this.ctx.storage.sql
      .exec<ValueRow>("SELECT value FROM settings WHERE key=?", key)
      .toArray()[0]?.value;
  }
  private setSetting(key: string, value: number) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES (?,?)", key, value);
  }
  subscribeEvent(owner: EventOwner, params: SubscribeParams) {
    return eventReply(() => this.events.subscribe(owner, params));
  }
  unsubscribeEvent(owner: EventOwner, params: UnsubscribeParams) {
    return eventReply(() => this.events.unsubscribe(owner, params));
  }
  override async alarm() {
    // A crash during external I/O must not strand either domain’s durable work.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    this.files.expire();
    await this.downloadActivityFile();
    await this.events.alarm();
    await this.schedule();
  }
}

export function userStore(env: Env, id: string): DurableObjectStub<GarminUserData> {
  // SAFETY: USER_DATA targets the exported GarminUserData class; cf does not infer named RPC methods for string-based Durable Object references yet.
  return env.USER_DATA.getByName(id) as DurableObjectStub<GarminUserData>;
}
