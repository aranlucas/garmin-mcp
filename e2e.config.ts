import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
  tests: "e2e/**/*.e2e.ts",
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:4173",
        readyUrl: "http://127.0.0.1:4173/e2e/host.html",
        command: {
          executable: "pnpm",
          args: ["exec", "vite", "--config", "e2e/vite.config.ts"],
          // Startup and transform errors from the fixture server, uploaded with the e2e evidence.
          log: ".e2e/logs/vite.log",
        },
      },
    },
  ],
  workers: 1,
  retries: 0,
  reporters: ["list", "junit"],
  trace: "retain-on-failure",
} satisfies E2EConfig;
