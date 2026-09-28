<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import type { Issue } from "../model/types";
  import type { Counter } from "../platforms/checks";
  import { useOsmm } from "../ui/context";
  import { icon } from "../ui/icon";

  let { variant, issues, counters }: { variant: IndexedVariant; issues: Issue[]; counters: Counter[] } = $props();
  const { composer } = useOsmm();
  const groups = $derived(
    [
      { title: "Blocking", list: issues.filter((i) => i.level === "error"), glyph: "circle-x", cls: "is-error" },
      { title: "Advisory", list: issues.filter((i) => i.level === "warning"), glyph: "alert-triangle", cls: "is-warning" },
    ].filter((g) => g.list.length > 0),
  );
  const pct = (c: Counter) => Math.min(100, Math.round((c.value / Math.max(c.limit, 1)) * 100));
</script>

<section class="osmm-panel" aria-label="Checks">
  <h4 class="osmm-section-title">Checks</h4>
  <ul class="osmm-counters">
    {#each counters as c (c.label)}
      <li>
        <span>{c.label}</span>
        <span class="osmm-lenbar" aria-hidden="true"><span style:width="{pct(c)}%"></span></span>
        <span class="osmm-progress" class:is-over={c.value > c.limit && c.label !== "Fold"}>{c.value.toLocaleString("en-US")}/{c.limit.toLocaleString("en-US")}</span>
      </li>
    {/each}
  </ul>
  {#if !issues.length}
    <p class="osmm-ok"><span use:icon={"check"} aria-hidden="true"></span>No problems found.</p>
  {/if}
  {#each groups as g (g.title)}
    <h5 class="osmm-issue-head">{g.title} · {g.list.length}</h5>
    <ul class="osmm-issue-list">
      {#each g.list as issue, i (i)}
        {@const fix = composer.quickFix(variant, issue)}
        <li class={g.cls}>
          <span use:icon={g.glyph} aria-hidden="true"></span>
          <span>{issue.message}</span>
          {#if fix}<button type="button" onclick={() => void fix.run()}>{fix.label}</button>{/if}
        </li>
      {/each}
    </ul>
  {/each}
</section>
