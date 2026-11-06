import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/client";
import { z } from "zod";
import { required } from "../test/support";
import bundle from "../build/mcp-apps/garmin-app.html?raw";

const frame = required(document.querySelector("iframe"), "fixture frame");
const calls = required(document.querySelector("#calls"), "call log");
let responseCount = 0;
const pending: (() => void)[] = [];

const result = (data: z.infer<ReturnType<typeof z.json>>) => ({
  content: [],
  structuredContent: { source: "Garmin Connect", data },
});

const day = (date: string) =>
  result({
    date,
    sections: {
      activities: {
        availability: "available",
        records: [{ summaryId: "a1", activityId: "123" }],
      },
    },
  });

const transport: Transport = {
  start: () => Promise.resolve(),
  send: (message) => {
    required(frame.contentWindow, "frame window").postMessage(message, "*");

    if (
      z
        .object({
          result: z.union([
            z.object({ hostInfo: z.unknown() }),
            z.object({ structuredContent: z.unknown() }),
          ]),
        })
        .safeParse(message).success
    ) {
      const count = ++responseCount;
      required(frame.contentWindow, "frame window").postMessage({ auditBarrier: count }, "*");
    }

    return Promise.resolve();
  },
  close: () => Promise.resolve(),
};

window.addEventListener("message", (event: MessageEvent<JSONRPCMessage>) => {
  if (event.source === frame.contentWindow) {
    if ("auditRendered" in event.data) {
      required(document.querySelector("#settled"), "response barrier").textContent = String(
        event.data.auditRendered,
      );
    } else {
      transport.onmessage?.(event.data);
    }
  }
});

const bridge = new AppBridge(
  null,
  { name: "Audit fixture", version: "1" },
  {
    serverTools: {},
    updateModelContext: { text: {} },
  },
  { hostContext: { timeZone: "UTC", locale: "en-US" } },
);

bridge.onupdatemodelcontext = ({ content }) => {
  required(document.querySelector("#context"), "context log").textContent +=
    JSON.stringify(content);

  return Promise.resolve({});
};

bridge.oncalltool = (params) => {
  calls.textContent += JSON.stringify(params) + "\n";

  return new Promise((resolve) => {
    pending.push(() =>
      resolve(
        params.name === "get_garmin_day"
          ? day(String(params.arguments?.date))
          : result({
              activityId: "123",
              summary: { activityName: "Late activity", activityType: "RUNNING" },
              details: null,
              fit: null,
            }),
      ),
    );
  });
};

required(document.querySelector("#resolve"), "resolve button").addEventListener("click", () => {
  // Deliberately return the newest request first to expose stale completion bugs.
  for (const resolve of pending.splice(0).toReversed()) {
    resolve();
  }
});

bridge.addEventListener("initialized", () => {
  void bridge
    .sendToolInput({ arguments: { date: "2026-10-20" } })
    .then(() => bridge.sendToolResult(day("2026-10-20")))
    .catch((error: Error) => {
      calls.textContent = error.message;
    });
});

await bridge.connect(transport);

frame.srcdoc = bundle
  .replace(
    "</head>",
    `<script>
window.addEventListener("message", async (event) => {
  if (!event.data.auditBarrier) return;
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  parent.postMessage({ auditRendered: event.data.auditBarrier }, "*");
});
</script></head>`,
  )
  .replace('<html lang="en">', '<html lang="en" data-view="day">');
