<script lang="ts">
  import type { Channel } from "../model/types";
  import { initials } from "./format";

  let { channel, size = 22 }: { channel: Channel; size?: number } = $props();
</script>

<span
  class="osmm-avatar"
  class:is-round={channel.kind === "profile"}
  role="img"
  aria-label={channel.name}
  style:--osmm-avatar={channel.avatarColor}
  style:width="{size}px"
  style:height="{size}px">{initials(channel.name)}</span>
