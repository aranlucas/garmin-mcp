import { expect, it } from "vitest";
import { z } from "zod";
import { liveAuthClient } from "./auth-client";

const base = process.env.SMOKE_BASE_URL ?? "https://garmin-mcp.aranlucas.workers.dev";

const issuer = "https://auth.aranlucas.workers.dev/api/auth";

const metadataSchema = z.object({
  issuer: z.literal(issuer),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  registration_endpoint: z.url(),
  revocation_endpoint: z.url(),
  jwks_uri: z.url(),
  scopes_supported: z.array(z.string()),
});

it("advertises shared Auth and protects the single merged MCP endpoint", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST" });
  expect(r.status).toBe(401);
  expect(r.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  expect(
    await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json(),
  ).toMatchObject({
    resource: `${base}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["garmin:access"],
  });

  const auth = liveAuthClient(issuer);
  const discovery = await auth.$fetch("/.well-known/oauth-authorization-server", { method: "GET" });
  const metadata = metadataSchema.parse(discovery.data);

  expect(metadata.scopes_supported).toContain("garmin:access");
  expect(metadata.registration_endpoint).toBe(`${issuer}/oauth2/register`);

  const registration = await auth.oauth2.register({
    client_name: "Garmin deployment smoke",
    redirect_uris: ["http://localhost:9876/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "garmin:access offline_access",
  });

  expect(registration.error).toBeNull();
  expect(z.object({ client_id: z.string().min(1) }).safeParse(registration.data).success).toBe(
    true,
  );
});

it("serves keyless setup, honest privacy, and app branding", async () => {
  const home = await (await fetch(base)).text();
  expect(home).toContain("Sign in with Auth");
  expect(home).not.toContain("Create your Garmin key");
  const privacy = await (await fetch(`${base}/privacy`)).text();
  expect(privacy).toContain("retained until you delete them or disconnect Garmin");
  expect(privacy).not.toContain("90 days");
  expect(privacy).toContain("historical backfill");
  expect(privacy).toContain("AI transparency");
  const icon = await fetch(`${base}/icon.svg`);
  expect(icon.status).toBe(200);
  expect(icon.headers.get("Content-Type")).toContain("image/svg+xml");
});

it("retires the Personal and separate Training issuers", async () => {
  const statuses = await Promise.all(
    ["/authorize", "/oauth/register", "/oauth/token", "/training/mcp", "/training/oauth/token"].map(
      async (path) => (await fetch(base + path)).status,
    ),
  );

  expect(statuses).toEqual([404, 404, 404, 404, 404]);
});
