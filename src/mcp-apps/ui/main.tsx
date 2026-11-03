/** @jsxImportSource react */
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useEffect, useState, type CSSProperties, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { isAppView, type AppView } from "../views";
import { ActivityView } from "./activity-view";
import { DayView } from "./day-view";
import { HostProvider, type ToolSession, type ViewProps } from "./host";
import { WorkoutView } from "./workout-view";
import "./theme.css";

const views: Record<AppView, (props: ViewProps) => JSX.Element> = {
  day: DayView,
  activity: ActivityView,
  workout: WorkoutView,
};

// The Worker serves one bundle per ui:// resource with its view preselected.
const preselected = document.documentElement.dataset.view;
const view: AppView = isAppView(preselected) ? preselected : "day";

function insets(context: McpUiHostContext): CSSProperties | undefined {
  const area = context.safeAreaInsets;

  return area
    ? {
        paddingTop: area.top,
        paddingRight: area.right,
        paddingBottom: area.bottom,
        paddingLeft: area.left,
      }
    : undefined;
}

function GarminApp() {
  const [tool, setTool] = useState<ToolSession>({ input: {}, cancelled: false });
  const [context, setContext] = useState<McpUiHostContext>({});

  const { app, isConnected, error } = useApp({
    appInfo: { name: "Garmin MCP", version: "1.0.0" },
    capabilities: {},
    onAppCreated(created) {
      created.addEventListener("toolinput", ({ arguments: args }) =>
        setTool((previous) => ({ ...previous, input: args ?? {} })),
      );
      created.addEventListener("toolresult", (result) =>
        setTool((previous) => ({ ...previous, result })),
      );
      created.addEventListener("toolcancelled", () =>
        setTool((previous) => ({ ...previous, cancelled: true })),
      );
      created.addEventListener("hostcontextchanged", (changed) =>
        setContext((previous) => ({ ...previous, ...changed })),
      );
    },
  });

  useHostStyles(app, app?.getHostContext());

  useEffect(() => {
    if (app && isConnected) {
      setContext((changes) => ({ ...app.getHostContext(), ...changes }));
    }
  }, [app, isConnected]);

  const View = views[view];

  return (
    <HostProvider value={{ app, connected: isConnected && !error, context }}>
      <main className="app" style={insets(context)}>
        {error ? (
          <p role="alert">Open Garmin MCP in an MCP Apps host to view this result.</p>
        ) : tool.cancelled && !tool.result ? (
          <p className="muted">The Garmin request was cancelled.</p>
        ) : (
          <View tool={tool} />
        )}
      </main>
    </HostProvider>
  );
}

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Missing MCP Apps root.");
}

createRoot(root).render(
  <StrictMode>
    <GarminApp />
  </StrictMode>,
);
