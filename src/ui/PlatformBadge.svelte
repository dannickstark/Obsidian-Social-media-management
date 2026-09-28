<script lang="ts">
  import { PLATFORM_META, type Platform } from "../model/platforms";
  import { PLATFORM_COLORS } from "./colors";

  let { platform, size = "sm" }: { platform: Platform; size?: "sm" | "md" } = $props();
  const meta = $derived(PLATFORM_META[platform]);
</script>

<span class="osmm-badge" data-size={size} role="img" aria-label={meta.label} style:--osmm-platform={PLATFORM_COLORS[platform]}>{meta.badge}</span>
