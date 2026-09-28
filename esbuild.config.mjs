import esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";
import builtins from "builtin-modules";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";

const prod = process.argv[2] === "production";
const devVault = process.env.OSMM_DEV_VAULT ?? "dev-vault";
const pluginDir = `${devVault}/.obsidian/plugins/osmm-social-planner`;

/** esbuild names the CSS bundle after the JS outfile; Obsidian expects styles.css. */
const finalize = {
  name: "finalize",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      if (existsSync("main.css")) await rename("main.css", "styles.css");
      if (prod) return;
      await mkdir(pluginDir, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) {
        if (existsSync(f)) await copyFile(f, `${pluginDir}/${f}`);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
  plugins: [sveltePlugin({ compilerOptions: { css: "external" } }), finalize],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
