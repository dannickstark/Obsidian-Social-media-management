import { z } from "zod";
import { planComposerSchedule, reminderDefaults, scheduleNeeds } from "../../composer/schedule";
import { MINUTE } from "../../model/dates";
import { zMinutesList } from "../../model/schemas";
import { deliveryTime } from "../../model/stateMachine";
import type { Delivery, Issue, Variant } from "../../model/types";
import { UNSCHEDULE_BLOCKED, unscheduleBlocked, unscheduleDeliveries } from "../../planner/board";
import { deliveryChanges } from "../../planner/changes";
import { blocking } from "../../platforms/checks";
import { formatShortDate, formatTime } from "../../ui/format";
import { claudeNotice, findPost, noPost, untilIndexed, zPath, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { channelRows, iso } from "../present";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

/** Ruling P5: a post Claude schedules goes out without a second question, so the user gets this long to see the Notice and step in. */
export const MIN_SCHEDULE_LEAD_MS = 10 * MINUTE;

const PAST = "That time has passed. Pick a future time (find_free_slots can help).";
const TOO_SOON =
  "That is too soon for Claude to schedule. Pick a time at least 10 minutes ahead, or ask the user to publish it now (publish_now asks them in Obsidian).";
const HANDED_OVER =
  "Some channels were already handed over to the platform. Change the time in Obsidian, or ask the user; the platform keeps the old time until an update is pushed.";
const AWAITING =
  "Some channels are waiting for the user to post them by hand. Ask the user whether to move them too, then call schedule again with move_awaiting: true.";

const atIssue = (code: "past-time" | "too-soon", message: string): Issue[] => [{ level: "error", field: "at", code, message }];

/** Ruling P5: the earliest time any channel the plan sets to scheduled would go out (its own time, or the post's plus stagger). */
function earliestSend(fresh: Variant, scheduledAt: number, deliveries: Record<string, Delivery>, stagger: number): number | undefined {
  const planned = { ...fresh, scheduledAt, deliveries: { ...fresh.deliveries, ...deliveries } };
  const times = Object.entries(deliveries)
    .filter(([, d]) => d.status === "scheduled")
    .map(([id]) => deliveryTime(planned, id, stagger))
    .filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

export function registerScheduleTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;
  const stagger = () => deps.settings().defaultStaggerMinutes;

  registry.add(
    defineTool({
      name: "schedule",
      title: "Schedule a post",
      description:
        "Makes a post go out at `at` on all its channels (staggered by the post's stagger). The plugin checks it first and refuses blocking issues, times in the past or less than 10 minutes ahead, and channels already handed over to the platform. API channels then post by themselves on the publisher device without asking again; the others remind the user. Only call this after the user agreed to the plan.",
      input: z
        .object({
          path: zPath,
          at: zWhen.describe("When the first channel posts, e.g. 2026-10-08T17:30:00+02:00"),
          reminders: zMinutesList.optional().describe("Minutes before, e.g. [60, 10]; defaults to the channel's or the plugin's"),
          move_awaiting: z.boolean().optional().describe("true only after the user agreed to move channels that wait for them"),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const now = deps.now();
        if (a.at <= now) return fail(PAST, atIssue("past-time", PAST));
        if (a.at < now + MIN_SCHEDULE_LEAD_MS) return fail(TOO_SOON, atIssue("too-soon", TOO_SOON));
        if (!v.channels.length) return fail("Pick at least one channel first (update_variant with channels).");
        // An unreadable delivery entry is a blocking issue (unreadable-delivery), so a frozen note is refused here.
        const issues = deps.composer.check(v, await deps.composer.content.load(v));
        if (blocking(issues)) return fail("Blocking issues, so the post was not scheduled.", issues);
        const needs = scheduleNeeds(v, a.at, now);
        if (needs.handedOver) return fail(HANDED_OVER);
        if (needs.awaitingYou && !a.move_awaiting) return fail(AWAITING, undefined, { needs_confirmation: "move_awaiting" });
        const reminders = a.reminders ?? reminderDefaults(v, deps.composer.channelsOf(v), deps.settings());
        let tooSoon = false;
        let awaiting = false;
        const result = await deps.planner.write(v.file, (fresh) => {
          const again = scheduleNeeds(fresh, a.at, now);
          if (again.handedOver) return { refuse: HANDED_OVER };
          if (again.awaitingYou && !a.move_awaiting) {
            awaiting = true;
            return { refuse: AWAITING };
          }
          const plan = planComposerSchedule(fresh, { at: a.at, reminders }, stagger());
          if ("refuse" in plan) return plan;
          const first = earliestSend(fresh, a.at, plan.deliveries, stagger());
          if (first !== undefined && first < deps.now() + MIN_SCHEDULE_LEAD_MS) {
            tooSoon = true;
            return { refuse: TOO_SOON };
          }
          return { fields: { ...plan.fields, review: undefined }, deliveries: deliveryChanges(fresh, plan.deliveries) };
        });
        if (!result.ok) {
          if (awaiting) return fail(result.reason, undefined, { needs_confirmation: "move_awaiting" });
          return fail(result.reason, tooSoon ? atIssue("too-soon", TOO_SOON) : undefined);
        }
        const changed = result.record.fields.length + result.record.deliveries.length > 0;
        // Wait for the reindex so the next read tool sees the write; nothing to wait for when nothing changed.
        if (changed) await untilIndexed(deps.index, () => deps.index.getVariant(v.path) !== v);
        const fresh = deps.index.getVariant(v.path) ?? v;
        if (changed) claudeNotice(deps, `Claude scheduled ${v.displayTitle} for ${formatShortDate(a.at)} ${formatTime(a.at)}.`, v.path);
        return ok({ path: v.path, scheduled_at: iso(a.at), reminders, channels: channelRows(fresh, stagger(), nameOf), issues });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "unschedule",
      title: "Unschedule a post",
      description:
        "Moves a scheduled post back to draft (or ready). Refused when a channel was already handed over, published, is being published, needs a check or is waiting for the user. The proposed time is kept.",
      input: z.object({ path: zPath, to: z.enum(["draft", "ready"]).default("draft") }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const result = await deps.planner.write(v.file, (fresh) => {
          // A published post without delivery records has nothing to unschedule either.
          if (unscheduleBlocked(fresh) || fresh.status === "published" || fresh.status === "partial") return { refuse: UNSCHEDULE_BLOCKED };
          return { fields: { status: a.to }, deliveries: deliveryChanges(fresh, unscheduleDeliveries(fresh, a.to)) };
        });
        if (!result.ok) return fail(result.reason);
        const changed = result.record.fields.length + result.record.deliveries.length > 0;
        if (changed) {
          await untilIndexed(deps.index, () => deps.index.getVariant(v.path) !== v);
          claudeNotice(deps, `Claude unscheduled ${v.displayTitle}.`, v.path);
        }
        return ok({ path: v.path, status: a.to });
      },
    }),
  );
}
