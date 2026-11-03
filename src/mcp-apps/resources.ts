import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
// Self-contained build output of vite.apps.config.ts; `pnpm run build:apps` creates it.
import bundle from "../../build/mcp-apps/garmin-app.html?raw";
import { appViews, type AppView } from "./views";

/** One ui:// resource per view; each serves the same bundle with its view preselected. */
export const appUris = {
  day: "ui://garmin/day.html",
  activity: "ui://garmin/activity.html",
  workout: "ui://garmin/workout.html",
} as const satisfies Record<AppView, string>;

const titles: Record<AppView, string> = {
  day: "Garmin day",
  activity: "Garmin activity",
  workout: "Garmin workout",
};

const htmlTag = '<html lang="en">';

// No CDN, network, or frame access: the view only talks to the host over postMessage.
const ui = { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } };

/** Tool `_meta` that links a tool to its view in MCP Apps hosts; other hosts ignore it. */
export function appMeta(view: AppView) {
  return { ui: { resourceUri: appUris[view] } };
}

export function appHtml(view: AppView): string {
  if (!bundle.includes(htmlTag)) {
    throw new Error("MCP Apps bundle is missing its <html> tag.");
  }

  return bundle.replace(htmlTag, `<html lang="en" data-view="${view}">`);
}

export function registerApps(server: McpServer): void {
  for (const view of appViews) {
    const uri = appUris[view];

    registerAppResource(
      server,
      `garmin-${view}`,
      uri,
      {
        title: titles[view],
        description: `Interactive ${titles[view].toLowerCase()} view.`,
        _meta: { ui },
      },
      () => ({
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: appHtml(view), _meta: { ui } }],
      }),
    );
  }
}
