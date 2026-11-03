// SDK AppBridge handles MCP Apps; Playwright adapts its transport to a real sandboxed iframe.
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  deserializeMessage,
  type CallToolRequestParams,
  type CallToolResult,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { afterAll, beforeAll, onTestFinished } from "vitest";
import { appHtml } from "../src/mcp-apps/resources";
import type { AppView } from "../src/mcp-apps/views";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

type ToolArguments = NonNullable<Parameters<AppBridge["sendToolInput"]>[0]["arguments"]>;

/** Answers the view's own tools/call requests, standing in for the Garmin MCP server. */
export type ToolHandler = (params: CallToolRequestParams) => CallToolResult;

export interface OpenAppOptions {
  view: AppView;
  input: ToolArguments;
  result: CallToolResult;
  width?: number;
  theme?: "light" | "dark";
  hostContext?: McpUiHostContext;
  tools?: ToolHandler;
}

/** The `{ source, data }` envelope every Garmin MCP tool returns. */
export function envelope<T>(data: T, extra: Record<string, string> = {}): CallToolResult {
  const payload = { source: "Garmin Connect", ...extra, data };

  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/** Render one view's HTML resource inside a sandboxed iframe host. */
export async function openApp({
  view,
  input,
  result,
  width = 640,
  theme = "light",
  hostContext,
  tools,
}: OpenAppOptions) {
  // Emulate the opposite OS scheme so assertions prove the host theme wins.
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    colorScheme: theme === "dark" ? "light" : "dark",
  });

  onTestFinished(() => page.close());
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith("https://garmin-app.test/")) {
      externalRequests.push(request.url());
    }
  });
  await page.route("https://garmin-app.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe title="Garmin app" sandbox="allow-scripts allow-same-origin" style="width:100%;height:880px;border:0"></iframe>',
    }),
  );
  await page.goto("https://garmin-app.test/");

  const transport: Transport = {
    start: () => Promise.resolve(),
    send: async (message) => {
      await page.evaluate(
        `document.querySelector("iframe").contentWindow.postMessage(${JSON.stringify(message)}, "*")`,
      );
    },
    close: () => Promise.resolve(),
  };

  await page.exposeBinding("deliver", (_source, value: JSONRPCMessage) => {
    transport.onmessage?.(deserializeMessage(JSON.stringify(value)));
  });
  await page.evaluate('window.addEventListener("message", (event) => window.deliver(event.data))');

  const bridge = new AppBridge(
    null,
    { name: "Fixture host", version: "1.0.0" },
    { serverTools: {}, updateModelContext: { text: {} }, message: { text: {} } },
    {
      hostContext: {
        theme,
        displayMode: "inline",
        timeZone: "UTC",
        locale: "en-US",
        ...hostContext,
      },
    },
  );

  const calls: CallToolRequestParams[] = [];
  const modelContext: string[] = [];
  const messages: string[] = [];

  bridge.oncalltool = (params) => {
    calls.push(params);

    return Promise.resolve(
      tools?.(params) ?? {
        isError: true,
        content: [{ type: "text", text: "Unexpected tool call." }],
      },
    );
  };

  bridge.onupdatemodelcontext = ({ content }) => {
    modelContext.push(...(content ?? []).map((block) => (block.type === "text" ? block.text : "")));

    return Promise.resolve({});
  };

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge request handlers return the ui/message result; listeners cannot.
  bridge.onmessage = ({ content }) => {
    messages.push(...content.map((block) => (block.type === "text" ? block.text : "")));

    return Promise.resolve({});
  };

  const initialized = new Promise<void>((resolve) => {
    bridge.addEventListener("initialized", () => {
      bridge
        .sendToolInput({ arguments: { ...input } })
        .then(() => bridge.sendToolResult(result))
        .then(() => resolve())
        .catch((error: Error) => errors.push(error.message));
    });
  });

  onTestFinished(() => bridge.close());
  await bridge.connect(transport);
  await page.locator("iframe").evaluate((frame, source) => {
    frame.setAttribute("srcdoc", source);
  }, appHtml(view));

  const frame = page.frameLocator("iframe");

  await Promise.race([
    initialized,
    delay(5000).then(() => {
      throw new Error(`MCP Apps handshake failed: ${JSON.stringify(errors)}`);
    }),
  ]);

  return { bridge, page, frame, errors, externalRequests, calls, modelContext, messages };
}

/** The view fits its width: no horizontal scroll at phone sizes. */
export function fitsWidth(frame: FrameLocator): Promise<boolean> {
  return frame.locator("body").evaluate((el) => el.scrollWidth <= el.clientWidth);
}

/** Optional visual review: set MCP_APP_SCREENSHOTS to a directory to keep screenshots. */
export async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.MCP_APP_SCREENSHOTS;

  if (dir) {
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}
