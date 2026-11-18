import icon from "../assets/icon.svg?raw";
import iconPng from "../assets/icon.png?inline";
import { env } from "cloudflare:workers";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import {
  authenticate,
  garminCredential,
  GARMIN_SCOPE,
  type AuthBroker,
  type AppBindings,
} from "./auth";
import { receivePush, purgeUser } from "./push/handler";
import { userStore } from "./push/store";
import { createServer } from "./mcp";
import { htmlHeaders } from "./page-headers";
import { HomePage } from "./pages/home";
import { PrivacyPage } from "./pages/privacy";

// Pages, metadata, disconnect and /mcp. The adapter parses JSON bodies up to 4 MiB for these routes.
const site = createMcpHonoApp({
  host: new URL(env.PUBLIC_URL).hostname,
  maxRequestBodySize: 4 * 1024 * 1024,
}).use<AppBindings>(jsxRenderer());

site.use("*", async (c, next) => {
  await next();

  if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
    for (const [name, value] of htmlHeaders()) {
      c.header(name, value);
    }
  }
});

site.get("/", (c) => c.render(<HomePage publicUrl={c.env.PUBLIC_URL} />));

site.get("/privacy", (c) => c.render(<PrivacyPage />));

site.get("/icon.svg", (c) =>
  c.body(icon, 200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=86400",
  }),
);

site.get("/icon.png", (c) =>
  c.body(Buffer.from(iconPng.slice(iconPng.indexOf(",") + 1), "base64"), 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  }),
);

site.get("/health", (c) => c.json({ status: "ok", service: "garmin-mcp" }));

type MetadataContext = { env: Env };

const metadata = (c: MetadataContext) => ({
  resource: `${c.env.PUBLIC_URL}/mcp`,
  authorization_servers: [c.env.AUTH_ISSUER],
  resource_name: "Garmin MCP",
  scopes_supported: [GARMIN_SCOPE],
  bearer_methods_supported: ["header"],
});

site.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(metadata(c)));

site.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata(c)));

site.get("/training", (c) => c.redirect("/#connect", 308));

site.get("/training/privacy", (c) => c.redirect("/privacy", 308));

site.post("/garmin/disconnect", (c) => purgeUser(c.req.raw, c.env));

site.all("/mcp", async (c) => {
  const auth = await authenticate(c.req.raw, c.env);

  if (auth.response) {
    return auth.response;
  }

  const { userId } = auth;
  // SAFETY: AUTH is the private GarminTokens Worker entrypoint; its reply is schema-checked below.
  const broker = c.env.AUTH as AuthBroker;
  const credential = garminCredential.safeParse(await broker.accessToken(userId));

  if (!credential.success || credential.data.expiresAt <= Date.now()) {
    return c.json(
      {
        error:
          "Garmin access is unavailable. Retry shortly. If Garmin is disconnected, reconnect it in Auth.",
      },
      503,
      { "Cache-Control": "no-store" },
    );
  }

  const { accessToken, garminUserId } = credential.data;
  const store = userStore(c.env, garminUserId);
  await store.bindActivityOwner(userId, garminUserId);

  const handler = createMcpHandler(
    () => createServer(accessToken, store, fetch, { subject: userId, garminUserId }),
    {
      maxRequestBodySize: 64 * 1024,
    },
  );

  // No parsedBody: the handler skips its 64 KiB check when it is handed an already-parsed body.
  return handler.fetch(c.req.raw);
});

// Garmin deliveries are registered before the adapter's JSON middleware, so the credential is
// checked before any body is read and the receiver applies its own limit.
export const app = new Hono<AppBindings>();

app.post("/webhook/garmin/:credential", (c) =>
  receivePush(c.req.raw, c.env, c.req.param("credential")),
);

// Keep existing Garmin configurations and queued deliveries working during migration.
app.post("/garmin/push/:credential", (c) =>
  receivePush(c.req.raw, c.env, c.req.param("credential")),
);

app.route("/", site);

app.notFound(() => new Response("Not found", { status: 404 }));

app.onError((error) => {
  // Unexpected errors reach the Worker's redacted logger, not Hono's default logger.
  throw error;
});
