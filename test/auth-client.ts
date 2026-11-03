import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createAuthClient } from "better-auth/client";

/** Better Auth client for the deployed Auth issuer, as live and smoke tests call it. */
export function liveAuthClient(issuer: string) {
  return createAuthClient({
    baseURL: issuer,
    fetchOptions: { redirect: "manual", retry: 0 },
    plugins: [oauthProviderClient(), oauthProviderResourceClient()],
  });
}
