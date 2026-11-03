import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// MCP Apps hosts render one self-contained HTML resource; src/mcp-apps/resources.ts imports this output.
export default defineConfig({
  root: fileURLToPath(new URL("./src/mcp-apps/", import.meta.url)),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("./build/mcp-apps/", import.meta.url)),
    emptyOutDir: true,
    // Keep native light-dark(): the polyfill follows the OS, not the host theme the SDK applies.
    cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"],
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/mcp-apps/garmin-app.html", import.meta.url)),
    },
  },
});
