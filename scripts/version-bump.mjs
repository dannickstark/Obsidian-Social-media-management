import { readFileSync, writeFileSync } from "node:fs";

const target = process.env.npm_package_version;
if (!target) throw new Error("Run through `npm version <version>`");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = target;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

const pluginPath = "claude-plugin/.claude-plugin/plugin.json";
const claudePlugin = JSON.parse(readFileSync(pluginPath, "utf8"));
claudePlugin.version = target;
writeFileSync(pluginPath, `${JSON.stringify(claudePlugin, null, 2)}\n`);
