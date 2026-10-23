import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ experimental: { newConfig: true } })],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          exclude: ["test/smoke.test.ts", "test/training-live.test.ts"],
        },
      },
      // Opt-in real Garmin writes; a browser-authorized private session file is required.
      {
        test: {
          name: "training-live",
          include: ["test/training-live.test.ts"],
          environment: "node",
          testTimeout: 120_000,
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
