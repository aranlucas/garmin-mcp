import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { isAPIError } from "better-auth/api";
import { createAuthClient } from "better-auth/client";
import { parseAccessTokenAuthorization } from "better-auth/oauth2";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

export const GARMIN_SCOPE = "garmin:access";

/** Auth's Better Auth resource client: cached JWKS with key-rotation refetch and scope checks. */
const authClient = createAuthClient({
  baseURL: workerEnv.AUTH_ISSUER,
  fetchOptions: { redirect: "manual", retry: 0 },
  plugins: [oauthProviderResourceClient()],
});

const claims = z.object({ sub: z.string().min(1).max(255) });

function bearerChallenge(env: Env, invalidToken = false) {
  const discovery = `Bearer resource_metadata="${env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="${GARMIN_SCOPE}"`;

  const challenge = invalidToken
    ? `${discovery}, error="invalid_token", error_description="The MCP access token is invalid or expired."`
    : discovery;

  return new Response(null, {
    status: 401,
    headers: { "WWW-Authenticate": challenge, "Cache-Control": "no-store" },
  });
}

/** Verify the MCP bearer token and retain the distinction between authentication and scope errors. */
export async function authenticate(request: Request, env: Env) {
  const authorization = parseAccessTokenAuthorization(request.headers.get("Authorization"));

  if (authorization?.scheme !== "Bearer") {
    return { response: bearerChallenge(env) };
  }

  try {
    const payload = await authClient.verifyBearerToken(authorization.token, {
      jwksUrl: `${env.AUTH_ISSUER}/jwks`,
      verifyOptions: {
        issuer: env.AUTH_ISSUER,
        audience: new URL("/mcp", env.PUBLIC_URL).href,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
      },
      requiredScopes: [GARMIN_SCOPE],
    });

    const subject = claims.safeParse(payload);

    return subject.success
      ? { userId: subject.data.sub }
      : { response: bearerChallenge(env, true) };
  } catch (error) {
    if (isAPIError(error) && error.status === "FORBIDDEN") {
      const headers = new Headers(error.headers);
      headers.set("Cache-Control", "no-store");

      return { response: new Response(null, { status: 403, headers }) };
    }

    if (isAPIError(error) && error.status === "UNAUTHORIZED") {
      return { response: bearerChallenge(env, true) };
    }

    return {
      response: Response.json(
        { error: "Auth could not verify the MCP access token. Retry shortly." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }
}

export const garminCredential = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().positive(),
  garminUserId: z.string().min(1).max(255),
});

export type GarminCredential = z.infer<typeof garminCredential>;

type CredentialAccess =
  | { status: "allowed"; credential: GarminCredential }
  | { status: "unavailable" | "mismatch" };

/** A null/invalid/expired broker reply denies access but does not prove consent withdrawal. */
export function classifyGarminCredential(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC parsing boundary; Zod validates unknown replies before use.
  value: unknown,
  garminUserId: string,
  now: number,
): CredentialAccess {
  const parsed = garminCredential.safeParse(value);

  if (!parsed.success || parsed.data.expiresAt <= now) {
    return { status: "unavailable" };
  }

  if (parsed.data.garminUserId !== garminUserId) {
    return { status: "mismatch" };
  }

  return { status: "allowed", credential: parsed.data };
}

// cf infers external service bindings as Fetcher; the private RPC contract is validated at this boundary.
export interface AuthBroker extends Fetcher {
  /** Auth returns null for both absent links and temporary refresh failures; never infer revocation. */
  accessToken(userId: string): Promise<GarminCredential | null>;
}

export type AppBindings = { Bindings: Env; Variables: { parsedBody: unknown } };
