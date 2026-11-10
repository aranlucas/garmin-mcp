import { z } from "zod";

const jsonRecord = z.record(z.string(), z.json());

export function storedJson(text: string) {
  return jsonRecord.parse(JSON.parse(text));
}

export function toolResult<Output extends Record<string, unknown>>(output: Output) {
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
}

/** Fixed, actionable messages only; never upstream bodies or validation issues. */
export function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

const KEEP_CONNECTED = "Stored data is unaffected; do not disconnect Garmin.";

/** One fixed sentence per failure class of a stored-data read. `status` is a GarminError status,
 * or undefined for a failure that did not come from Garmin. Never includes upstream text.
 */
export function readFailure(status: number | undefined): string {
  if (status === 403 || status === 412) {
    return "Garmin sharing permission for this data is not granted. Allow it in Garmin Connect, or reconnect Garmin in Auth to grant it.";
  }

  if (status === 401) {
    return "Garmin access expired or was revoked. Retry once; if it keeps failing, reconnect Garmin in Auth.";
  }

  if (status === 429) {
    return `Garmin's rate limit was reached while checking sharing permissions. Wait a few minutes and retry. ${KEEP_CONNECTED}`;
  }

  if (status === 499) {
    return "The request was cancelled.";
  }

  if (status === undefined) {
    return `Stored Garmin data could not be read right now. Retry shortly. ${KEEP_CONNECTED}`;
  }

  return `Garmin could not be reached to confirm sharing permissions. Retry shortly. ${KEEP_CONNECTED}`;
}
