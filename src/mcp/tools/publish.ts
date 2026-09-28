import { z } from "zod";
import { PLATFORM_META } from "../../model/platforms";
import { ALL_WAITING, type SendPlan } from "../../publish/actions";
import { findPost, noPost, zPath } from "../common";
import type { McpToolDeps } from "../deps";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const API_HOW = "posts through the API now";
const ASSISTED_HOW = "opens the assisted flow in Obsidian; you post it";

function withoutWaiting(plan: SendPlan): SendPlan {
  const keep = (id: string) => !plan.waiting.includes(id);
  return { ...plan, queue: plan.queue.filter(keep), api: plan.api.filter(keep), assisted: plan.assisted.filter(keep) };
}

const zOnly = z.array(z.string().trim().min(1).max(80)).max(30).optional().describe("Only these channel ids; default: every channel still to post");
const zNote = z.string().trim().max(500).optional().describe("One sentence for the user, shown in the approval question");

export function registerPublishTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;

  registry.add(
    defineTool({
      name: "publish_now",
      title: "Publish now (asks the user in Obsidian)",
      description:
        "Publishes a post right now on the channels still to post. Obsidian first asks the user (what, where, when; Approve or Deny; no answer within 2 minutes is a no) unless they allowed those channels to publish without asking. API channels post from the publisher device; the others open the assisted flow in Obsidian for the user. Only call this when the user explicitly asked you to publish now; otherwise use schedule.",
      input: z.object({ path: zPath, channels: zOnly, note: zNote }).strict(),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const plan = await deps.publish.prepareSend(v.path, a.channels);
        if ("refuse" in plan) return fail(plan.refuse, plan.issues);
        const blocked = plan.api.length ? deps.publish.apiBlockedReason() : null;
        if (blocked) return fail(blocked);
        const answer = await deps.approvals.request({
          action: "publish",
          title: plan.title,
          path: v.path,
          platformLabel: PLATFORM_META[v.platform].label,
          channels: plan.queue.map((id) => ({ id, name: nameOf(id), how: plan.api.includes(id) ? API_HOW : ASSISTED_HOW, status: plan.statuses[id] ?? "" })),
          text: plan.text,
          items: plan.items,
          details: plan.details,
          ...(a.note ? { note: a.note } : {}),
        });
        if (!answer.approved) return fail(answer.reason, undefined, { approved: false });
        // Ruling m2: the channel setting never sends a channel the user is posting by hand right now.
        const approved = answer.how === "policy" ? withoutWaiting(plan) : plan;
        if (!approved.queue.length) return fail(ALL_WAITING, undefined, { approved: true });
        const sent = await deps.publish.sendApproved(approved, { skipWaiting: answer.how === "policy" });
        if ("refuse" in sent) return fail(sent.refuse, sent.issues, { approved: true });
        return ok({
          approved: true,
          approved_by: answer.how === "policy" ? "channel setting" : "user",
          started_api: sent.started,
          opened_assisted: sent.opened,
          message: sent.opened.length
            ? "The assisted flow is open in Obsidian: the user copies the text, posts it and pastes the live link. Check the result later with get_post."
            : "Publishing started. Check the result with get_post in a minute.",
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "push_update",
      title: "Push an edit to a live post (asks the user in Obsidian)",
      description:
        "Sends the current text of a post to the channels where it is already live (published or handed over to the platform), when the platform supports updates. Obsidian always asks the user first (Approve or Deny; no answer within 2 minutes is a no), even for channels allowed to publish without asking. Only call this when the user asked for it.",
      input: z.object({ path: zPath, channels: zOnly, note: zNote }).strict(),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const plan = await deps.publish.prepareUpdate(v.path, a.channels);
        if ("refuse" in plan) return fail(plan.refuse, plan.issues);
        const blocked = deps.publish.apiBlockedReason();
        if (blocked) return fail(blocked);
        const answer = await deps.approvals.request({
          action: "update",
          title: plan.title,
          path: v.path,
          platformLabel: PLATFORM_META[v.platform].label,
          channels: plan.channels.map((id) => ({ id, name: nameOf(id), how: "replaces the live text", status: plan.statuses[id] ?? "" })),
          text: plan.text,
          items: plan.items,
          details: plan.details,
          ...(a.note ? { note: a.note } : {}),
        });
        if (!answer.approved) return fail(answer.reason, undefined, { approved: false });
        const done = await deps.publish.updateApproved(plan);
        if ("refuse" in done) return fail(done.refuse, done.issues, { approved: true });
        return ok({ approved: true, updated: done.updated, failed: done.failed });
      },
    }),
  );
}
