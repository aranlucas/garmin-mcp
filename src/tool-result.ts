import { z } from "zod";

const jsonRecord = z.record(z.string(), z.json());

/** Re-read a JSON object this connector stored after validating its provider payload. */
export function storedJson(text: string) {
  return jsonRecord.parse(JSON.parse(text));
}

/** Every tool returns the same envelope as structured content and serialized text. */
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
