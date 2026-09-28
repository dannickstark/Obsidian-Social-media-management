import { z } from "zod";
import { voicePath, VOICE_TEMPLATE } from "../../claude/voice";
import { formatDateTime } from "../../model/dates";
import { claudeNotice, clip, normalizePathArg, zKey, zPath } from "../common";
import type { McpToolDeps } from "../deps";
import { IdempotencyCache } from "../idempotency";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const NO_PROFILE = 'There is no voice profile yet. Ask the user to run "Create voice profile" in Obsidian (command palette), then fill it in together.';

/** One line, no Markdown heading marks: the heading can't start a new section of its own. */
function heading(text: string): string {
  return text.replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Every write here targets a fixed, plugin-chosen path (the voice profile) or a path already known to
 * the index (a campaign note) — never an arbitrary path argument (P10: nothing under `.obsidian/`). */
export function registerVoiceTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const today = () => formatDateTime(deps.now()).slice(0, 10);
  const idem = new IdempotencyCache(() => deps.now());
  // A kept outcome is still valid while the note it names exists (same pattern as write.ts).
  const exists = (o: { data?: Record<string, unknown> }) => typeof o.data?.path !== "string" || !!deps.app.vault.getFileByPath(o.data.path);

  registry.add(
    defineTool({
      name: "get_voice_profile",
      title: "Get the voice profile",
      description: "The user's voice profile (Social/_voice.md): tone, dos and don'ts, vocabulary, example posts, refinements. Read it before drafting and say which rules you applied.",
      input: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => {
        const path = voicePath(deps.settings().rootFolder);
        const file = deps.app.vault.getFileByPath(path);
        if (!file) return ok({ path, exists: false, template: VOICE_TEMPLATE, hint: NO_PROFILE });
        return ok({ path, exists: true, text: clip(await deps.app.vault.cachedRead(file), 30_000) });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "add_voice_refinement",
      title: "Add to the voice profile",
      description:
        "Appends a dated entry under Refinements in the voice profile (never rewrites what the user wrote). Only after the user agreed to the exact text, e.g. rules learned from their best published posts.",
      input: z
        .object({
          text: z.string().trim().min(1).max(4_000).describe("Markdown, usually a short list of concrete rules"),
          idempotency_key: zKey,
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: (a) =>
        idem.run(
          "add_voice_refinement",
          a.idempotency_key,
          a,
          async () => {
            const path = voicePath(deps.settings().rootFolder);
            const file = deps.app.vault.getFileByPath(path);
            if (!file) return fail(NO_PROFILE);
            const entry = `### ${today()}\n\n${a.text}\n`;
            await deps.writer.editBody(file, (body) => {
              const base = body.trimEnd();
              return base.includes("## Refinements") ? `${base}\n\n${entry}` : `${base}\n\n## Refinements\n\n${entry}`;
            });
            claudeNotice(deps, "Claude added a refinement to your voice profile.", path);
            return ok({ path });
          },
          exists,
        ),
    }),
  );

  registry.add(
    defineTool({
      name: "append_to_campaign",
      title: "Append to a campaign note",
      description:
        'Adds a section at the end of a campaign note, e.g. the decisions from a review page (heading "Review decisions (date)"). Never changes the existing text or the frontmatter.',
      input: z
        .object({
          path: zPath,
          heading: z.string().trim().min(1).max(120),
          text: z.string().trim().min(1).max(20_000),
          idempotency_key: zKey,
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: (a) =>
        idem.run(
          "append_to_campaign",
          a.idempotency_key,
          a,
          async () => {
            const campaign = deps.index.getCampaign(normalizePathArg(a.path));
            if (!campaign) return fail(`No campaign note at "${a.path}". Use list_campaigns to find the path.`);
            const title = heading(a.heading);
            if (!title) return fail("The heading is empty.");
            await deps.writer.editBody(campaign.file, (body) => `${body.trimEnd()}\n\n## ${title}\n\n${a.text}\n`);
            claudeNotice(deps, `Claude added "${title}" to ${campaign.title}.`, campaign.path);
            return ok({ path: campaign.path });
          },
          exists,
        ),
    }),
  );
}
