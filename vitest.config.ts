import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// All date logic is tested in a zone with DST so offset bugs surface.
process.env.TZ = "Europe/Berlin";

export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./test/fakes/obsidian.ts", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: { provider: "v8", include: ["src/**"] },
  },
});
