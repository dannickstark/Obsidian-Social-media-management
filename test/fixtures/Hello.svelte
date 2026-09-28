<script lang="ts">
  import { getContext, onDestroy } from "svelte";

  let { name, onGone }: { name: string; onGone: () => void } = $props();
  const greeting = getContext<string | undefined>("greeting") ?? "Hello";
  onDestroy(onGone);
</script>

<p>{greeting}, {name}!</p>
