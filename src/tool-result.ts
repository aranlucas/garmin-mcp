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
