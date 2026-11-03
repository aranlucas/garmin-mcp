import { env } from "cloudflare:workers";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createServer } from "../src/mcp";
import { appUris } from "../src/mcp-apps/resources";
import { userStore } from "../src/push/store";

const linkedTools = {
  get_garmin_day: appUris.day,
  get_garmin_activity: appUris.activity,
  get_workout: appUris.workout,
  create_workout: appUris.workout,
  update_workout: appUris.workout,
};

const htmlContent = z.object({
  uri: z.string(),
  mimeType: z.literal(RESOURCE_MIME_TYPE),
  text: z.string(),
  _meta: z.object({
    ui: z.object({
      prefersBorder: z.literal(true),
      csp: z.object({ connectDomains: z.array(z.never()), resourceDomains: z.array(z.never()) }),
    }),
  }),
});

async function connect() {
  const fetcher = vi.fn<typeof fetch>();
  const server = createServer("apps-token", userStore(env, "apps-fixture"), fetcher);
  const client = new Client({ name: "mcp-apps-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, fetcher };
}

it("serves each view as one self-contained, network-free MCP Apps resource", async () => {
  const { client, fetcher } = await connect();

  for (const [view, uri] of Object.entries(appUris)) {
    // oxlint-disable-next-line no-await-in-loop -- Each resource is read and asserted on its own.
    const resource = await client.readResource({ uri });
    const content = htmlContent.parse(resource.contents[0]);

    expect(resource.contents).toHaveLength(1);
    expect(content.uri).toBe(uri);
    expect(content.text).toContain(`<html lang="en" data-view="${view}">`);
    // The bundle is inlined: no external scripts, styles, or fonts for the host CSP to allow.
    expect(content.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(content.text).not.toContain("garmin-mcp.aranlucas.workers.dev");
  }

  expect(fetcher).not.toHaveBeenCalled();
});

it("links read and workout tools to their views without changing their results", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();

  const linked = Object.fromEntries(
    tools.flatMap((tool) => (tool._meta?.ui ? [[tool.name, tool._meta]] : [])),
  );

  // Hosts without MCP Apps support ignore _meta; both the current and legacy keys are set.
  expect(linked).toEqual(
    Object.fromEntries(
      Object.entries(linkedTools).map(([name, uri]) => [
        name,
        { ui: { resourceUri: uri }, "ui/resourceUri": uri },
      ]),
    ),
  );
});
