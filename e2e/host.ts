// Fixture MCP Apps host: the official AppBridge and PostMessageTransport drive the real built view.
// Tool replies are held until the test releases them, so journeys control their order and timing.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import { required } from "../test/support";
import bundle from "../build/mcp-apps/garmin-app.html?raw";

const frame = required(document.querySelector("iframe"), "fixture frame");
const view = required(frame.contentWindow, "frame window");
const calls = required(document.querySelector("#calls"), "call log");
const context = required(document.querySelector("#context"), "model context log");
const settled = required(document.querySelector("#settled"), "reply barrier");

// Day requests for this date fail with Garmin's fixed error text, as an unavailable day would.
const failing = new URLSearchParams(location.search).get("fail");

/** Activity IDs derive from the day, so the screen shows which reply it rendered. */
const activityFor = (date: string) => date.replaceAll("-", "");

const envelope = (data: z.infer<ReturnType<typeof z.json>>): CallToolResult => ({
  content: [],
  structuredContent: { source: "Garmin Connect", data },
});

const day = (date: string): CallToolResult =>
  date === failing
    ? { isError: true, content: [{ type: "text", text: "Garmin day unavailable." }] }
    : envelope({
        date,
        sections: {
          activities: {
            availability: "available",
            records: [{ summaryId: `s-${date}`, activityId: activityFor(date) }],
          },
        },
      });

const log = (list: Element, text: string) => {
  const item = document.createElement("li");

  item.textContent = text;
  list.append(item);
};

const message = z.looseObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]) });
const toolCall = message.extend({ method: z.literal("tools/call") });

// MCP results are objects; requests carry neither key, so they never count as replies.
const reply = z.union([
  message.extend({ result: z.looseObject({}) }),
  message.extend({ error: z.looseObject({ code: z.number() }) }),
]);

// tools/call request IDs the view sent and the host has not yet answered.
const unanswered = new Set<string | number>();
let processed = 0;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== view) {
    return;
  }

  const call = toolCall.safeParse(event.data);
  const rendered = z.object({ auditRendered: z.number() }).safeParse(event.data);

  if (call.success) {
    unanswered.add(call.data.id);
  }

  if (rendered.success) {
    settled.textContent = String(rendered.data.auditRendered);
  }
});

const transport = new PostMessageTransport(view, view);
const send = transport.send.bind(transport);

// After each tool reply, the view echoes a barrier once it has handled and painted that reply.
transport.send = async (outgoing, options) => {
  await send(outgoing, options);
  const answered = reply.safeParse(outgoing);

  if (answered.success && unanswered.delete(answered.data.id)) {
    view.postMessage({ auditBarrier: ++processed }, "*");
  }
};

const bridge = new AppBridge(
  null,
  { name: "Audit fixture", version: "1" },
  { serverTools: {}, updateModelContext: { text: {} } },
  { hostContext: { timeZone: "UTC", locale: "en-US" } },
);

bridge.onupdatemodelcontext = ({ content }) => {
  for (const block of content ?? []) {
    log(context, block.type === "text" ? block.text : block.type);
  }

  return Promise.resolve({});
};

const pending: (() => void)[] = [];

bridge.oncalltool = (params) => {
  const date = String(params.arguments?.date);
  const activityId = String(params.arguments?.activityId);

  log(calls, `${params.name} ${params.name === "get_garmin_day" ? date : activityId}`);

  return new Promise((resolve) => {
    pending.push(() =>
      resolve(
        params.name === "get_garmin_day"
          ? day(date)
          : envelope({
              activityId,
              summary: { activityName: "Late activity", activityType: "RUNNING" },
              details: null,
              fit: null,
            }),
      ),
    );
  });
};

required(document.querySelector("#resolve"), "resolve button").addEventListener("click", () => {
  // Newest request first, so a stale completion arrives after the reply that should win.
  for (const resolve of pending.splice(0).toReversed()) {
    resolve();
  }
});

bridge.addEventListener("initialized", () => {
  void bridge
    .sendToolInput({ arguments: { date: "2026-10-20" } })
    .then(() => bridge.sendToolResult(day("2026-10-20")))
    .catch((error: Error) => {
      log(calls, `host error: ${error.message}`);
    });
});

await bridge.connect(transport);

const barrier = `<script>
window.addEventListener("message", async (event) => {
  if (event.source !== parent || typeof event.data?.auditBarrier !== "number") return;
  // Replies are handled in the message task; two frames let React commit and paint the result.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  parent.postMessage({ auditRendered: event.data.auditBarrier }, "*");
});
</script>`;

for (const marker of ['<html lang="en">', "</head>"]) {
  if (!bundle.includes(marker)) {
    throw new Error(`MCP Apps bundle is missing ${marker}`);
  }
}

// The same day-view selection as src/mcp-apps/resources.ts appHtml, plus the barrier.
frame.srcdoc = bundle
  .replace('<html lang="en">', '<html lang="en" data-view="day">')
  .replace("</head>", `${barrier}</head>`);
