<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import type { Issue, PostMode } from "../model/types";
  import { defaultScheduleTime } from "../planner/board";
  import { blocking } from "../platforms/checks";
  import type { EffectiveMethod } from "../platforms/registry";
  import { useOsmm } from "../ui/context";
  import { icon } from "../ui/icon";
  import { bestSlot, reminderDefaults } from "./schedule";

  let { variant, issues }: { variant: IndexedVariant; issues: Issue[] } = $props();
  const { settings, now, composer, actions } = useOsmm();

  const METHOD: Record<EffectiveMethod, string> = {
    api: "Auto-post",
    native: "Scheduled on the platform",
    assisted: "Reminder + pre-filled composer",
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const channelList = $derived(composer.channelsOf(variant));
  const slot = $derived(bestSlot(channelList));
  let date = $state("");
  let time = $state("");
  let reminders = $state<number[]>([]);
  let newReminder = $state<number | null>(null);
  let loadedFor = "";

  // Reset the inputs when another note is shown or the note's schedule changes elsewhere.
  $effect(() => {
    const key = `${variant.path}|${variant.scheduledAt ?? ""}|${(variant.reminders ?? []).join(",")}`;
    if (key === loadedFor) return;
    loadedFor = key;
    const d = new Date(variant.scheduledAt ?? defaultScheduleTime($now, variant, slot?.time));
    date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    reminders = reminderDefaults(variant, channelList, $settings);
  });

  const at = $derived.by(() => {
    const [y, m, d] = date.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    if (!y || !m || !d || h === undefined || mi === undefined || Number.isNaN(h) || Number.isNaN(mi)) return null;
    return new Date(y, m - 1, d, h, mi).getTime();
  });
  const blocked = $derived(blocking(issues));
  const scheduled = $derived(["scheduled", "partial", "overdue", "attention"].includes(variant.status));

  function addReminder(): void {
    const n = Number(newReminder);
    if (newReminder !== null && Number.isInteger(n) && n >= 0 && n <= 20160 && !reminders.includes(n)) {
      reminders = [...reminders, n].sort((a, b) => b - a);
    }
    newReminder = null;
  }
</script>

<section class="osmm-panel" aria-label="Schedule">
  <h4 class="osmm-section-title">Schedule</h4>
  <div class="osmm-row">
    <label>Date<input type="date" bind:value={date} /></label>
    <label>Time<input type="time" bind:value={time} /></label>
  </div>
  <p class="osmm-progress">{zone}{#if slot} · Best slot: {slot.time} ({slot.channel}){/if}</p>
  <div class="osmm-chips" role="group" aria-label="Reminders">
    {#each reminders as r (r)}
      <span class="osmm-chip-token">
        {r} min before
        <button type="button" class="clickable-icon" aria-label={`Remove reminder ${r} min before`} onclick={() => (reminders = reminders.filter((x) => x !== r))}><span use:icon={"x"}></span></button>
      </span>
    {/each}
  </div>
  <div class="osmm-row">
    <input type="number" min="0" max="20160" placeholder="min" aria-label="Add a reminder (minutes before)" bind:value={newReminder} />
    <button type="button" onclick={addReminder}>Add reminder</button>
  </div>
  <label>
    Mode
    <select value={variant.mode} onchange={(e) => void composer.setMode(variant, e.currentTarget.value as PostMode)}>
      <option value="auto">Auto-post when possible</option>
      <option value="assisted">Always assisted</option>
    </select>
  </label>
  <ul class="osmm-methods">
    {#each channelList as c (c.id)}
      <li><span>{c.name}</span><span class="osmm-progress">{METHOD[composer.methodFor(variant, c)]}</span></li>
    {/each}
  </ul>
  <div class="osmm-row">
    <button
      type="button"
      class="mod-cta"
      disabled={blocked || at === null || variant.channels.length === 0}
      onclick={() => {
        if (at !== null) void composer.schedule(variant, { at, reminders }, issues);
      }}>{scheduled ? "Update schedule" : "Schedule"}</button>
    {#if scheduled}<button type="button" onclick={() => void actions.unschedule(variant, "ready")}>Unschedule</button>{/if}
  </div>
  {#if blocked}<p class="osmm-progress" role="note">Fix the blocking issues to schedule.</p>{/if}
</section>
