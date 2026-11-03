/** @jsxImportSource react */
import type {
  App,
  McpUiHostContext,
  McpUiToolInputNotification,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createContext, useContext } from "react";
import { z } from "zod";

/** Every Garmin MCP tool returns `{ source, data }`; errors carry one fixed text message. */
const envelope = z.looseObject({ data: z.unknown() });

type Envelope = z.infer<typeof envelope>;

const errorText = z.array(z.looseObject({ type: z.literal("text"), text: z.string() })).min(1);

export type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: T; envelope: Envelope };

type ServerToolArguments = NonNullable<Parameters<App["callServerTool"]>[0]["arguments"]>;

/** Arguments as the host forwards them; each view parses the fields it reads. */
export type ToolArguments = NonNullable<McpUiToolInputNotification["params"]["arguments"]>;

/** Tool notifications the host has delivered for the call that opened this view. */
export interface ToolSession {
  input: ToolArguments;
  result?: CallToolResult;
  cancelled: boolean;
}

export interface ViewProps {
  tool: ToolSession;
}

interface Host {
  app: App | null;
  connected: boolean;
  context: McpUiHostContext;
}

const HostState = createContext<Host>({ app: null, connected: false, context: {} });

export const HostProvider = HostState.Provider;

export function useHost(): Host {
  return useContext(HostState);
}

const unrecognized = "Garmin returned a result this view does not recognize.";

export function readResult<T>(result: CallToolResult | undefined, schema: z.ZodType<T>): Loaded<T> {
  if (!result) {
    return { state: "loading" };
  }

  if (result.isError) {
    const text = errorText.safeParse(result.content);

    return {
      state: "error",
      message: text.success ? text.data.map((block) => block.text).join(" ") : unrecognized,
    };
  }

  const parsed = envelope.safeParse(result.structuredContent);
  const data = parsed.success ? schema.safeParse(parsed.data.data) : undefined;

  return parsed.success && data?.success
    ? { state: "ready", data: data.data, envelope: parsed.data }
    : { state: "error", message: unrecognized };
}

/** Call a read-only Garmin tool from the view; failures become a displayable error. */
export async function callTool<T>(
  app: App | null,
  name: string,
  args: ServerToolArguments,
  schema: z.ZodType<T>,
): Promise<Loaded<T>> {
  if (!app) {
    return { state: "error", message: "Not connected to the host." };
  }

  try {
    return readResult(await app.callServerTool({ name, arguments: args }), schema);
  } catch {
    return { state: "error", message: "That Garmin data is unavailable right now. Try again." };
  }
}

/** Tell the model what the user looked at, when the host supports it. Never includes data. */
export function shareWithModel(app: App | null, text: string): void {
  if (!app?.getHostCapabilities()?.updateModelContext) {
    return;
  }

  app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
}

interface StatusProps {
  loaded: Loaded<unknown>;
  what: string;
}

export function Status({ loaded, what }: StatusProps) {
  return loaded.state === "error" ? (
    <p role="alert" className="error">
      {loaded.message}
    </p>
  ) : (
    <p className="muted" aria-live="polite">
      Loading {what}…
    </p>
  );
}
