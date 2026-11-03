import { readFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { encodeBasicCredentials } from "better-auth/oauth2";
import { expect, it } from "vitest";
import { z } from "zod";
import { schedulesResponse } from "../src/training/schemas";
import { liveAuthClient } from "./auth-client";
import { required } from "./support";

// Opt-in only: prepare a dedicated confidential client and consented subject token in Auth.
// The private file stays outside the repository; only read-only Garmin tools are invoked.
const sessionSchema = z.object({
  base: z.literal("https://garmin-mcp.aranlucas.workers.dev"),
  issuer: z.literal("https://auth.aranlucas.workers.dev/api/auth"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  subjectToken: z.string().min(1),
});

const exchangeGrant = "urn:ietf:params:oauth:grant-type:token-exchange";

const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";

const exchangedTokens = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.literal(accessTokenType),
  token_type: z.literal("Bearer"),
  scope: z.literal("garmin:access"),
  refresh_token: z.undefined().optional(),
  id_token: z.undefined().optional(),
});

it("exchanges a live Auth token and reads Garmin's workout calendar through MCP", async () => {
  const path = required(process.env.GARMIN_E2E_EXCHANGE_FILE, "GARMIN_E2E_EXCHANGE_FILE");
  const session = sessionSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const resource = `${session.base}/mcp`;

  const auth = liveAuthClient(session.issuer);
  const discovery = await auth.$fetch("/.well-known/oauth-authorization-server", { method: "GET" });

  expect(discovery.error).toBeNull();

  const metadata = z
    .object({
      issuer: z.literal(session.issuer),
      token_endpoint: z.literal(`${session.issuer}/oauth2/token`),
      jwks_uri: z.literal(`${session.issuer}/jwks`),
      grant_types_supported: z.array(z.string()),
    })
    .parse(discovery.data);

  expect(metadata.grant_types_supported).toContain(exchangeGrant);

  const verify = (token: string) =>
    auth.verifyBearerToken(token, {
      jwksUrl: metadata.jwks_uri,
      verifyOptions: {
        issuer: session.issuer,
        audience: resource,
        algorithms: ["RS256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "exp", "iat"],
      },
      requiredScopes: ["garmin:access"],
    });

  const subject = await verify(session.subjectToken);

  // The token endpoint requires form encoding; better-fetch sends URLSearchParams unchanged.
  const exchange = await auth.$fetch("/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: encodeBasicCredentials(session.clientId, session.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: exchangeGrant,
      subject_token: session.subjectToken,
      subject_token_type: accessTokenType,
      resource,
      scope: "garmin:access",
    }),
  });

  expect(exchange.error).toBeNull();
  const tokens = exchangedTokens.parse(exchange.data);
  const exchanged = await verify(tokens.access_token);
  expect(exchanged.sub).toBe(subject.sub);
  expect([exchanged.aud].flat()).toEqual([resource]);
  expect(exchanged.scope).toBe("garmin:access");
  expect(exchanged.client_id).toBe(session.clientId);
  expect(exchanged.sid).toBe(subject.sid);
  expect(exchanged.reference_id).toBe(subject.reference_id);
  expect(exchanged.exp).toBeLessThanOrEqual(subject.exp ?? 0);

  const client = new Client({ name: "garmin-exchange-e2e", version: "1.0.0" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["create_workout", "list_garmin_summaries", "get_garmin_summary"]),
    );

    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const calendar = await client.callTool({
      name: "list_workout_schedules",
      arguments: { startDate: date, endDate: date },
    });

    expect(calendar.isError).not.toBe(true);

    const result = z
      .object({ source: z.literal("Garmin Connect"), data: schedulesResponse })
      .parse(calendar.structuredContent);

    // Keep workout details private while recording the date and result count as test evidence.
    // oxlint-disable-next-line no-console -- Opt-in live-test evidence, without returned personal data.
    console.info(
      JSON.stringify({ tool: "list_workout_schedules", date, count: result.data.length }),
    );
  } finally {
    await client.close();
  }
});
