import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            config: true,
            miniflare: {
              bindings: {
                GARMIN_PUSH_TOKEN: "test-only-delivery-credential-with-at-least-32-characters",
                // nodejs_compat exposes text bindings as process.env; CI's baseline reproduction sets it.
                E2E_BASELINE: process.env.E2E_BASELINE ?? "",
              },
              durableObjects: { USER_DATA: { className: "GarminUserData", useSQLite: true } },
              serviceBindings: {
                AUTH: { name: "auth-events-fixture", entrypoint: "GarminTokens" },
              },
              workers: [
                {
                  name: "auth-events-fixture",
                  modules: true,
                  compatibilityDate: "2026-10-21",
                  script: `
                  import { WorkerEntrypoint } from "cloudflare:workers";
                  const replies = new Map();
                  export class GarminTokens extends WorkerEntrypoint {
                    setReplies(subject, values) {
                      replies.set(subject, values);
                    }
                    accessToken(subject) {
                      const values = replies.get(subject);
                      if (values?.length) return values.length > 1 ? values.shift() : values[0];
                      return subject.startsWith("unlinked-") ? null : {
                        accessToken: "fixture-" + subject,
                        expiresAt: Date.now() + 60000,
                        garminUserId: subject,
                      };
                    }
                  }
                  export default { fetch() { return new Response(null, { status: 404 }); } };
                `,
                },
              ],
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          exclude: [
            "test/mcp-apps.browser.test.ts",
            "test/smoke.test.ts",
            "test/push-live.test.ts",
            "test/exchange-live.test.ts",
            "test/personal-backfill-live.test.ts",
          ],
        },
      },
      // MCP Apps views rendered by the SDK host bridge in a sandboxed Chromium iframe.
      {
        test: {
          name: "apps",
          include: ["test/mcp-apps.browser.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "push-live",
          include: ["test/push-live.test.ts"],
          environment: "node",
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: "exchange-live",
          include: ["test/exchange-live.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "personal-backfill-live",
          include: ["test/personal-backfill-live.test.ts"],
          environment: "node",
          testTimeout: 600_000,
        },
      },
      // Live deployment checks; run explicitly with `pnpm run smoke`.
      {
        test: {
          name: "smoke",
          include: ["test/smoke.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
    ],
  },
});
