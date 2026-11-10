import { timingSafeEqual } from "node:crypto";
import { readRequestBody } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  isActivityType,
  notification,
  publicSummary,
  pushPayload,
  summary,
  summaryDate,
  summaryType,
  userId,
} from "./schemas";
import { userStore } from "./store";
import type { StoredSummary } from "./schemas";
import { activityFileNotification, type ActivityFileNotification } from "../activity/files";

interface PermissionChange {
  userId: string;
  permissions: string[];
  time: number;
}

export function validPushCredential(value: string, expected: string) {
  const actual = Buffer.from(value);
  const secret = Buffer.from(expected);

  return secret.length >= 32 && actual.length === secret.length && timingSafeEqual(actual, secret);
}

type PushRejection = "content_type" | "invalid_payload" | "invalid_record" | "too_large";

const REJECTION_EVENT = "garmin_push_rejected";

interface PushRejectionLog {
  event: typeof REJECTION_EVENT;
  reason: PushRejection;
  type?: string;
}

/** Invocation logs are disabled, so this is the only trace of a refused delivery. Labels only:
 * never URLs, account or summary IDs, or payload values. `type` is a key of the validated payload enum.
 */
function rejected(status: number, reason: PushRejection, type?: string): Response {
  const line: PushRejectionLog = { event: REJECTION_EVENT, reason };

  if (type) {
    line.type = type;
  }

  // oxlint-disable-next-line no-console -- Workers Logs receives only these fixed labels.
  console.warn(JSON.stringify(line));

  return new Response(null, { status });
}

/** Twice the 4 MiB the router used to impose by accident. Garmin's largest real delivery is not
 * known; search Workers Logs for `garmin_push_rejected` with reason `too_large` before raising it.
 */
export const MAX_PUSH_BYTES = 8 * 1024 * 1024;

export async function receivePush(
  request: Request,
  env: Env,
  credential: string,
): Promise<Response> {
  if (!validPushCredential(credential, env.GARMIN_PUSH_TOKEN)) {
    return new Response(null, { status: 404 });
  }

  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    return rejected(415, "content_type");
  }

  const read = await readRequestBody(request, MAX_PUSH_BYTES);

  if (read.tooLarge) {
    return rejected(413, "too_large");
  }

  let body: ReturnType<typeof pushPayload.safeParse>;

  try {
    body = pushPayload.safeParse(JSON.parse(read.text));
  } catch {
    return rejected(400, "invalid_payload");
  }

  if (!body.success) {
    return rejected(400, "invalid_payload");
  }

  const groups = new Map<string, StoredSummary[]>();
  const files = new Map<string, ActivityFileNotification[]>();
  const revoke = new Set<string>();
  const permissionChanges: PermissionChange[] = [];

  for (const [type, values] of Object.entries(body.data)) {
    for (const value of values ?? []) {
      if (type === "activityFiles") {
        const parsed = activityFileNotification.safeParse(value);

        if (!parsed.success) {
          return rejected(400, "invalid_record", type);
        }

        const rows = files.get(parsed.data.userId) ?? [];
        rows.push(parsed.data);
        files.set(parsed.data.userId, rows);
        continue;
      }

      if (type === "deregistrations" || type === "userPermissionsChange") {
        const parsed = notification.safeParse(value);

        if (!parsed.success) {
          return rejected(400, "invalid_record", type);
        }

        if (
          type === "userPermissionsChange" &&
          (!parsed.data.permissions || parsed.data.changeTimeInSeconds === undefined)
        ) {
          return rejected(400, "invalid_record", type);
        }

        if (type === "deregistrations") {
          revoke.add(parsed.data.userId);
        } else {
          permissionChanges.push({
            userId: parsed.data.userId,
            permissions: parsed.data.permissions ?? [],
            time: parsed.data.changeTimeInSeconds ?? 0,
          });
        }

        continue;
      }

      const parsed = summary.safeParse(value);

      if (!parsed.success) {
        return rejected(400, "invalid_record", type);
      }

      const item = parsed.data;
      const records = groups.get(item.userId) ?? [];

      const row: StoredSummary = {
        type: summaryType.parse(type),
        summaryId: item.summaryId,
        date: summaryDate(item),
        receivedAt: Date.now(),
        data: publicSummary(item),
      };

      if (!isActivityType(type) && item.startTimeInSeconds !== undefined) {
        row.startTime = item.startTimeInSeconds;
        row.duration = item.durationInSeconds ?? 0;
      }

      records.push(row);
      groups.set(item.userId, records);
    }
  }

  // Only durable acceptance before acknowledgement; no upstream calls or AI processing on delivery.
  await Promise.all(
    permissionChanges.map((change) =>
      userStore(env, change.userId).permissions(change.permissions, change.time),
    ),
  );
  await Promise.all(
    // ingest() discards records for revoked accounts; skip only same-delivery deregistrations.
    [...groups].flatMap(([id, records]) =>
      revoke.has(id) ? [] : [userStore(env, id).ingest(records)],
    ),
  );
  await Promise.all([...revoke].map((id) => userStore(env, id).revoke()));
  await Promise.all(
    [...files].flatMap(([id, rows]) =>
      revoke.has(id) ? [] : [userStore(env, id).ingestActivityFiles(rows)],
    ),
  );

  return new Response(null, { status: 200 });
}

export async function purgeUser(request: Request, env: Env) {
  if (
    !validPushCredential(
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "",
      env.GARMIN_PUSH_TOKEN,
    )
  ) {
    return new Response(null, { status: 401 });
  }

  const parsed = z
    .object({ userId, action: z.enum(["disconnect", "activate"]).default("disconnect") })
    .safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }

  const store = userStore(env, parsed.data.userId);

  if (parsed.data.action === "activate") {
    await store.activate();
  } else {
    await store.revoke();
  }

  return new Response(null, { status: 204 });
}
