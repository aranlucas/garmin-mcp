import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export const GARMIN_SCOPE = "garmin:access";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const claims = z.object({ sub: z.string().min(1).max(255), scope: z.string() });

export async function authenticate(request: Request, env: Env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  let keys = keySets.get(env.AUTH_ISSUER);

  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${env.AUTH_ISSUER}/jwks`));
    keySets.set(env.AUTH_ISSUER, keys);
  }

  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys, {
      issuer: env.AUTH_ISSUER,
      audience: new URL("/mcp", env.PUBLIC_URL).href,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });

    const identity = claims.parse(payload);

    return identity.scope.split(/\s+/).includes(GARMIN_SCOPE) ? identity.sub : null;
  } catch {
    return null;
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
