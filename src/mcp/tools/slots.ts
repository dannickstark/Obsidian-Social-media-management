import { z } from "zod";
import { addLocalDays, DAY } from "../../model/dates";
import { zTimeOfDay } from "../../model/schemas";
import { zChannelsArg, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { iso } from "../present";
import { busyTimes, findFreeSlots, MAX_RANGE_DAYS, minutesOfDay } from "../slots";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

export function registerSlotTools(registry: ToolRegistry, deps: McpToolDeps): void {
  registry.add(
    defineTool({
      name: "find_free_slots",
      title: "Find free slots",
      description:
        "Proposes posting times per channel that keep min_spacing_minutes away from everything already planned on that channel (drafts included), inside the preferred windows (default 09:00–18:00 local), closest to the channel's usual time first. Deterministic. Use it to fill a campaign timeline, then confirm the plan with the user before schedule.",
      input: z
        .object({
          channels: zChannelsArg,
          from: zWhen.optional().describe("Default: now"),
          to: zWhen.optional().describe("Default: 14 days after from; at most 62 days"),
          min_spacing_minutes: z.number().int().min(0).max(10_080).default(180),
          preferred_windows: z
            .array(
              z
                .object({
                  days: z.array(z.number().int().min(0).max(6)).max(7).optional().describe("0 = Sunday … 6 = Saturday"),
                  start: zTimeOfDay,
                  end: zTimeOfDay,
                })
                .strict(),
            )
            .max(7)
            .optional(),
          step_minutes: z.number().int().min(5).max(240).default(30),
          per_channel: z.number().int().min(1).max(20).default(5),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (a) => {
        const now = deps.now();
        const from = a.from ?? now;
        const to = a.to ?? addLocalDays(from, 14);
        if (to <= from) return fail("to must be after from.");
        if (to - from > MAX_RANGE_DAYS * DAY) return fail(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
        if (a.preferred_windows?.some((w) => minutesOfDay(w.start) > minutesOfDay(w.end))) return fail("Each window must start before it ends.");
        const ids: string[] = [];
        const unknown: string[] = [];
        for (const raw of a.channels) {
          const expanded = deps.channels.expand([raw]);
          if (!expanded.length) unknown.push(raw);
          for (const id of expanded) if (!ids.includes(id)) ids.push(id);
        }
        const rows = deps.planner.rows();
        const channels = ids.map((id) => {
          const channel = deps.channels.get(id)!;
          const slots = findFreeSlots(busyTimes(rows, id), {
            from,
            to,
            now,
            minSpacingMinutes: a.min_spacing_minutes,
            stepMinutes: a.step_minutes,
            perChannel: a.per_channel,
            windows: a.preferred_windows,
            preferredTime: channel.defaultTime,
          });
          return {
            channel_id: id,
            name: channel.name,
            platform: channel.platform,
            slots: slots.map((s) => ({ at: iso(s.at), score: s.score, nearest_post_minutes: s.nearestMinutes })),
          };
        });
        return ok({ from: iso(from), to: iso(to), channels, unknown_channels: unknown });
      },
    }),
  );
}
