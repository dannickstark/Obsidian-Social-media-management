import { z } from "zod";
import { safeImageError } from "../../composer/imageGeneration";
import { findPost, noPost, zPath } from "../common";
import type { McpToolDeps } from "../deps";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

/** Generates one vault-local PNG. A note path is accepted only for an indexed social post. */
export function registerImageTools(registry: ToolRegistry, deps: McpToolDeps): void {
  registry.add(defineTool({
    name: "generate_image",
    title: "Generate an image",
    description: "Generates a PNG with the device-local OpenAI key and saves it in the vault attachments folder. If path is an existing social post, adds the image to its media field with source and focal metadata. It never publishes or schedules a post.",
    input: z.object({
      prompt: z.string().trim().min(1).max(4_000),
      negative_prompt: z.string().trim().max(1_000).optional(),
      size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).optional(),
      path: zPath.optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a) => {
      const post = a.path ? findPost(deps, a.path) : undefined;
      if (a.path && !post) return fail(noPost(a.path));
      const session = deps.images.open(post?.file);
      try {
        await session.generate({ prompt: a.prompt, negativePrompt: a.negative_prompt, size: a.size ?? "1024x1024" });
        const saved = await session.accept();
        deps.planner.actionNotice("Claude generated an image.", "Open", () => deps.planner.openNote(post?.path ?? saved.sourcePath));
        return ok({
          ...(post ? { path: post.path } : {}),
          media: saved.target,
          source_path: saved.sourcePath,
          focus: saved.focus,
          ...(saved.cropPath ? { crop_path: saved.cropPath, crop_ratio: saved.cropRatio } : {}),
        });
      } catch (error) {
        return fail(safeImageError(error));
      } finally {
        session.cancel();
      }
    },
  }));
}
