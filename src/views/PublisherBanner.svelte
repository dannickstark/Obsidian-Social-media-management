<script lang="ts">
  import { Notice } from "obsidian";
  import { publisherState } from "../settings/publisher";
  import { useOsmm } from "../ui/context";

  const { settings, publisher, actions } = useOsmm();
  const state = $derived(publisherState($settings.publisher, publisher.deviceId));

  function claim(): void {
    publisher
      .takeOver((message) => actions.confirm(message, "Make this device the publisher"))
      .catch((e: unknown) => new Notice(`Couldn't make this device the publisher: ${e instanceof Error ? e.message : String(e)}`));
  }
</script>

{#if state.kind === "other"}
  <p class="osmm-banner" role="status">
    Publishing happens on {state.name}.
    <button type="button" class="osmm-link" onclick={claim}>Publish from this device instead</button>
  </p>
{:else if state.kind === "none"}
  <p class="osmm-banner is-warning" role="status">
    No device publishes scheduled posts yet, so nothing is posted or marked overdue.
    <button type="button" class="osmm-link" onclick={claim}>Make this device the publisher</button>
  </p>
{/if}
