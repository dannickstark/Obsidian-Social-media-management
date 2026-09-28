<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { cropRect, feedRatio, focusFromPoint } from "../media/crop";
  import { platformDef } from "../platforms/registry";
  import type { MediaInfo } from "../platforms/types";
  import { useOsmm } from "../ui/context";
  import { icon } from "../ui/icon";

  let { variant, media }: { variant: IndexedVariant; media: MediaInfo[] } = $props();
  const { composer } = useOsmm();
  let dragging = $state(false);
  const rules = $derived(platformDef(variant.platform).capabilities.media);

  const size = (n?: number) => (n === undefined ? "" : n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 100) / 100));

  /** The crop box the current platform's feed shows, as CSS percentages of the thumbnail. */
  function cropBox(m: MediaInfo): string | null {
    if (m.kind !== "image" || !m.width || !m.height) return null;
    const ratio = feedRatio(rules, { width: m.width, height: m.height });
    if (!ratio) return null;
    const r = cropRect({ width: m.width, height: m.height }, ratio, m.focus);
    return `left:${(r.x / m.width) * 100}%;top:${(r.y / m.height) * 100}%;width:${(r.width / m.width) * 100}%;height:${(r.height / m.height) * 100}%`;
  }

  function pickFocus(event: MouseEvent, m: MediaInfo): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    void composer.setFocus(variant, m.target, focusFromPoint(event.clientX, event.clientY, box));
  }

  function nudgeFocus(event: KeyboardEvent, m: MediaInfo): void {
    const [x, y] = m.focus ?? [0.5, 0.5];
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [x - 0.05, y],
      ArrowRight: [x + 0.05, y],
      ArrowUp: [x, y - 0.05],
      ArrowDown: [x, y + 0.05],
    };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    void composer.setFocus(variant, m.target, [clamp(next[0]), clamp(next[1])]);
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) await composer.attachFiles(variant, files);
  }

  async function onChoose(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) await composer.attachFiles(variant, files);
  }
</script>

<section class="osmm-panel" aria-label="Media">
  <h4 class="osmm-section-title">Media</h4>
  <div
    class="osmm-dropzone"
    class:is-drop={dragging}
    role="group"
    aria-label="Drop images here"
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={(e) => void onDrop(e)}>
    <span>Drop images here, or</span>
    <label class="osmm-file">
      Add image…
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/*" multiple onchange={(e) => void onChoose(e)} />
    </label>
  </div>
  <ol class="osmm-media-list">
    {#each media as m, i (m.target)}
      {@const box = cropBox(m)}
      <li class="osmm-media-item">
        {#if m.kind === "image" && m.path}
          <button
            type="button"
            class="osmm-crop"
            aria-label={`Set the focal point of ${m.target}`}
            onclick={(e) => pickFocus(e, m)}
            onkeydown={(e) => nudgeFocus(e, m)}>
            <img src={composer.media.resourceUrl(m.path)} alt={m.alt ?? ""} />
            {#if box}<span class="osmm-crop-box" style={box}></span>{/if}
          </button>
        {:else}
          <span class="osmm-media-missing">{m.kind === "missing" ? "Not found" : m.kind === "video" ? "Video" : "File"}</span>
        {/if}
        <div class="osmm-media-meta">
          <span class="osmm-row-title">{m.target}</span>
          <span class="osmm-progress">{m.width && m.height ? `${m.width}×${m.height} · ` : ""}{size(m.bytes)}</span>
          {#if m.kind === "image"}
            <label>Alt text<input type="text" value={m.alt ?? ""} onchange={(e) => void composer.setAlt(variant, m.target, e.currentTarget.value)} /></label>
          {/if}
          <div class="osmm-row">
            <button type="button" class="clickable-icon" aria-label={`Move ${m.target} up`} disabled={i === 0} onclick={() => void composer.moveMedia(variant, m.target, -1)}><span use:icon={"arrow-up"}></span></button>
            <button type="button" class="clickable-icon" aria-label={`Move ${m.target} down`} disabled={i === media.length - 1} onclick={() => void composer.moveMedia(variant, m.target, 1)}><span use:icon={"arrow-down"}></span></button>
            <button type="button" class="clickable-icon" aria-label={`Remove ${m.target}`} onclick={() => void composer.removeMedia(variant, m.target)}><span use:icon={"trash-2"}></span></button>
          </div>
        </div>
      </li>
    {/each}
  </ol>
</section>
