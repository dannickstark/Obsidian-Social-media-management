import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { buildSeed } from "./seedData";

const vault = process.env.OSMM_DEV_VAULT ?? "dev-vault";
const large = process.argv.includes("--large");
const { notes, settings } = buildSeed(Date.now(), { large });

await rm(join(vault, "Social"), { recursive: true, force: true });
for (const note of notes) {
  const path = join(vault, note.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\n${YAML.stringify(note.frontmatter)}---\n${note.body}`);
}

const pluginDir = join(vault, ".obsidian", "plugins", "osmm-social-planner");
await mkdir(pluginDir, { recursive: true });
await writeFile(join(pluginDir, "data.json"), JSON.stringify(settings, null, 2));
await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["osmm-social-planner"]));

console.info(`Seeded ${notes.length} notes into ${vault}${large ? " (large)" : ""}. Run \`npm run dev\` and open the vault in Obsidian.`);
