import * as z from "zod";
import { readBounded } from "../garmin";
import { GarminError as TrainingError } from "../garmin-error";
import { createClient, type Client } from "../garmin-api/training/client";
import { client as trainingApi } from "../garmin-api/training/client.gen";
import * as training from "../garmin-api/training/sdk.gen";
import type { WorkoutV2 } from "../garmin-api/training/types.gen";
import * as user from "../garmin-api/user/sdk.gen";
import { client as userApi } from "../garmin-api/user/client.gen";
import type { WorkoutInput, ScheduleInput } from "./schemas";

export const TRAINING_BASE = "https://apis.garmin.com";

export { TrainingError };

/** Generated-SDK options shared by every call: raw body, so responses stay bounded and validated. */
type CallOptions = { client: Client; parseAs: "stream"; throwOnError: true };

type SdkResult = { request: Request; response: Response };

async function checkedFetch(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  deadline: AbortSignal,
): Promise<Response> {
  let response: Response;

  try {
    response = await fetcher(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([deadline, ...(init.signal ? [init.signal] : [])]),
    });
  } catch {
    throw new TrainingError(
      init.signal?.aborted
        ? "The Garmin Training request was cancelled."
        : "Garmin Training could not be reached. A write may have succeeded; check Garmin Connect before retrying.",
      init.signal?.aborted ? 499 : 502,
    );
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // A broken discard stream must not replace the safe HTTP error with upstream details.
    }

    const message =
      response.status === 401
        ? "Garmin Training access expired or was revoked. Refresh the MCP session or reconnect."
        : response.status === 403 || response.status === 412
          ? "Garmin requires Workout Import permission and an approved Training API application. Reconnect and allow workout access."
          : response.status === 429
            ? "Garmin Training rate limit reached. Wait before retrying."
            : `Garmin Training returned HTTP ${response.status}. Check Garmin Connect before retrying a write.`;

    throw new TrainingError(message, response.status);
  }

  return response;
}

const responseKind = z.union([
  z.string().transform(() => "string"),
  z.number().transform(() => "number"),
  z.boolean().transform(() => "boolean"),
  z.null().transform(() => "null"),
  z.array(z.unknown()).transform(() => "array"),
  z.record(z.string(), z.unknown()).transform(() => "object"),
]);

async function validatedJson<Output>(
  schema: z.ZodType<Output>,
  response: Response,
  limit = 1024 * 1024,
  signal?: AbortSignal,
  allowEmpty = false,
): Promise<Output> {
  let responseType = "unread";

  try {
    const bytes = await readBounded(response, limit);

    const data: unknown =
      bytes.length === 0 && allowEmpty
        ? { accepted: true }
        : JSON.parse(new TextDecoder().decode(bytes));

    responseType = responseKind.parse(data);

    return schema.parse(data);
  } catch {
    if (signal?.aborted) {
      throw new TrainingError("The Garmin Training request was cancelled.", 499);
    }

    // Record only structural diagnostics; never response values or validation issues.
    // oxlint-disable-next-line no-console -- Redacted diagnostics for Garmin contract drift.
    console.error(JSON.stringify({ event: "training_invalid_response", responseType }));
    throw new TrainingError(
      "Garmin Training returned an unrecognized response. Check Garmin Connect before retrying a write.",
      502,
    );
  }
}

/** Request-local client; only fixed official Training API paths can be called. */
export class TrainingClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<Output>(
    schema: z.ZodType<Output>,
    signal: AbortSignal | undefined,
    call: (options: CallOptions) => Promise<SdkResult>,
    api: Client = trainingApi,
  ): Promise<Output> {
    // Start the deadline when the tool call starts, not after the SDK prepares the request.
    const deadline = AbortSignal.timeout(20_000);

    // Per-request copy of the generated client: keeps the spec's base URL without sharing the token.
    const client = createClient({
      ...api.getConfig(),
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
      // The SDK hands over a built Request; pass its parts so checkedFetch owns redirect and abort.
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);

        const forwarded: RequestInit = {
          method: request.method,
          headers: request.headers,
          signal: signal ?? null,
        };

        if (request.body !== null) {
          forwarded.body = await request.text();
        }

        return checkedFetch(request.url, forwarded, this.fetcher, deadline);
      },
    });

    const { request, response } = await call({ client, parseAs: "stream", throwOnError: true });
    const write = request.method !== "GET";

    // Garmin documents 204 for successful mutations. Never invent an object ID.
    if (response.status === 204 && write) {
      await response.body?.cancel();

      return schema.parse({ accepted: true });
    }

    return validatedJson(schema, response, 1024 * 1024, signal, write);
  }

  getPermissions(signal?: AbortSignal): Promise<string[]> {
    const result = this.request(
      z.object({ permissions: z.array(z.string()) }),
      signal,
      (options) => user.userPermissions(options),
      userApi,
    );

    return result.then(({ permissions }) => permissions);
  }

  async requireWorkoutPermission(signal?: AbortSignal): Promise<void> {
    if (!(await this.getPermissions(signal)).includes("WORKOUT_IMPORT")) {
      throw new TrainingError(
        "Garmin Workout Import permission is missing. Reconnect and allow workout access.",
        403,
      );
    }
  }

  createWorkout<Output>(
    schema: z.ZodType<Output>,
    workout: WorkoutInput,
    signal?: AbortSignal,
  ): Promise<Output> {
    // The published spec only lists the V1 create; V2 create lives under /workoutportal.
    return this.request(schema, signal, ({ client, ...options }) =>
      client.post({
        ...options,
        baseUrl: TRAINING_BASE,
        url: "/workoutportal/workout/v2",
        body: workout,
      }),
    );
  }

  getWorkout<Output>(
    schema: z.ZodType<Output>,
    workoutId: number,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.getWorkout1({ ...options, path: { workoutId } }),
    );
  }

  scheduleWorkout<Output>(
    schema: z.ZodType<Output>,
    schedule: ScheduleInput,
    signal?: AbortSignal,
  ): Promise<Output> {
    // Keep the verified trailing slash; the spec's /schedule create has not been tried live.
    return this.request(schema, signal, ({ client, ...options }) =>
      client.post({ ...options, url: "/schedule/", body: schedule }),
    );
  }

  getSchedule<Output>(
    schema: z.ZodType<Output>,
    scheduleId: number,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.getWorkoutSchedule({ ...options, path: { workoutScheduleId: scheduleId } }),
    );
  }

  updateWorkout<Output>(
    schema: z.ZodType<Output>,
    workoutId: number,
    ownerId: number,
    workout: WorkoutInput,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.updateWorkout1({
        ...options,
        path: { workoutId },
        // SAFETY: workoutInput already parsed this body; Zod types optional keys as `T | undefined`
        // but omits absent keys, which is the shape WorkoutV2 expects.
        body: { ...workout, workoutId, ownerId } as WorkoutV2,
      }),
    );
  }

  deleteWorkout<Output>(
    schema: z.ZodType<Output>,
    workoutId: number,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.deleteWorkout1({ ...options, path: { workoutId } }),
    );
  }

  updateSchedule<Output>(
    schema: z.ZodType<Output>,
    scheduleId: number,
    schedule: ScheduleInput,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.updateWorkoutSchedule({
        ...options,
        path: { workoutScheduleId: scheduleId },
        body: { ...schedule, scheduleId },
      }),
    );
  }

  deleteSchedule<Output>(
    schema: z.ZodType<Output>,
    scheduleId: number,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.deleteWorkoutSchedule({ ...options, path: { workoutScheduleId: scheduleId } }),
    );
  }

  listSchedules<Output>(
    schema: z.ZodType<Output>,
    startDate: string,
    endDate: string,
    signal?: AbortSignal,
  ): Promise<Output> {
    return this.request(schema, signal, (options) =>
      training.queryWorkoutScheduleByDates({ ...options, query: { startDate, endDate } }),
    );
  }
}
