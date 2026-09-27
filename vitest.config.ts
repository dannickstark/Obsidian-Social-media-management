import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { fileURLToPath } from "node:url";

process.env.TZ = "Europe/Berlin";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
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
