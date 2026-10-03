<script lang="ts">
  import { onDestroy } from "svelte";
  import type { FocalPoint, ImageGenerationSize } from "../images/types";
  import { focusFromPoint } from "../media/crop";
  import { safeImageError, type ImageGenerationSession } from "./imageGeneration";

  let { session, onClose }: { session: ImageGenerationSession; onClose: () => void } = $props();
  let prompt = $state("");
  let negativePrompt = $state("");
  let size = $state<ImageGenerationSize>("1024x1024");
  let ratio = $state("1");
  let focusX = $state(50);
  let focusY = $state(50);
  let originalUrl = $state("");
  let cropUrl = $state("");
  let generating = $state(false);
  let cropping = $state(false);
  let accepting = $state(false);
  let error = $state("");
  let cropRevision = 0;

  function release(url: string): void {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  function clearPreviews(): void {
    release(originalUrl);
    release(cropUrl);
    originalUrl = "";
    cropUrl = "";
  }

  function previewUrl(bytes: ArrayBuffer): Promise<string> {
    const blob = new Blob([bytes], { type: "image/png" });
    if (typeof URL.createObjectURL === "function") return Promise.resolve(URL.createObjectURL(blob));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not preview the generated image."));
      reader.readAsDataURL(blob);
    });
  }

  async function refreshCrop(): Promise<void> {
    if (!originalUrl) return;
    const revision = ++cropRevision;
    cropping = true;
    try {
      const bytes = await session.previewCrop(Number(ratio), [focusX / 100, focusY / 100]);
      const url = await previewUrl(bytes);
      if (revision !== cropRevision) { release(url); return; }
      release(cropUrl);
      cropUrl = url;
      error = "";
    } catch (cause) {
      if (revision === cropRevision) error = safeImageError(cause);
    } finally {
      if (revision === cropRevision) cropping = false;
    }
  }

  async function generate(): Promise<void> {
    if (generating || accepting) return;
    generating = true;
    cropRevision++;
    clearPreviews();
    error = "";
    try {
      const bytes = await session.generate({ prompt, negativePrompt, size });
      originalUrl = await previewUrl(bytes);
      await refreshCrop();
    } catch (cause) {
      error = safeImageError(cause);
    } finally {
      generating = false;
    }
  }

  async function accept(): Promise<void> {
    if (!cropUrl || generating || cropping || accepting) return;
    accepting = true;
    error = "";
    try {
      await session.accept({ ratio: Number(ratio), focus: [focusX / 100, focusY / 100] });
      onClose();
    } catch (cause) {
      error = safeImageError(cause);
    } finally {
      accepting = false;
    }
  }

  function cancel(): void {
    if (accepting) return;
    session.cancel();
    onClose();
  }

  function pickFocus(event: MouseEvent): void {
    if (event.detail === 0) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!box.width || !box.height) return;
    const point: FocalPoint = focusFromPoint(event.clientX, event.clientY, box);
    focusX = Math.round(point[0] * 100);
    focusY = Math.round(point[1] * 100);
    void refreshCrop();
  }

  onDestroy(() => {
    cropRevision++;
    session.cancel();
    clearPreviews();
  });
</script>

<div class="osmm-image-overlay">
  <div class="osmm-image-dialog" role="dialog" aria-modal="true" aria-label="Generate image" tabindex="-1" onkeydown={(event) => { if (event.key === "Escape") cancel(); }}>
    <div class="osmm-row">
      <h3>Generate image</h3>
      <span class="osmm-spacer"></span>
      <button type="button" aria-label="Cancel image generation" onclick={cancel} disabled={accepting}>Close</button>
    </div>
    <label>Image prompt<textarea aria-label="Image prompt" bind:value={prompt} maxlength="4000" rows="3" placeholder="Describe the image you want…"></textarea></label>
    <label>Avoid<input aria-label="Avoid" type="text" bind:value={negativePrompt} maxlength="1000" placeholder="Optional negative guidance" /></label>
    <div class="osmm-row osmm-image-controls">
      <label>Image size
        <select aria-label="Image size" bind:value={size}>
          <option value="1024x1024">Square · 1024 × 1024</option>
          <option value="1024x1536">Portrait · 1024 × 1536</option>
          <option value="1536x1024">Landscape · 1536 × 1024</option>
        </select>
      </label>
      <label>Crop ratio
        <select aria-label="Crop ratio" bind:value={ratio} onchange={() => void refreshCrop()}>
          <option value="1">Square · 1:1</option>
          <option value="0.6666666666666666">Portrait · 2:3</option>
          <option value="1.5">Landscape · 3:2</option>
        </select>
      </label>
    </div>
    {#if error}<p role="alert" class="osmm-progress is-over">{error}</p>{/if}
    <div class="osmm-row">
      <button type="button" onclick={() => void generate()} disabled={!prompt.trim() || generating || accepting}>{originalUrl ? "Regenerate preview" : "Generate preview"}</button>
      {#if generating}<span role="status">Generating…</span>{/if}
    </div>
    {#if originalUrl}
      <div class="osmm-image-previews">
        <figure>
          <figcaption>Original · click to choose the focal point</figcaption>
          <button type="button" class="osmm-image-pick" aria-label="Pick focal point in original" onclick={pickFocus}>
            <img src={originalUrl} alt="Generated original" />
            <span class="osmm-image-focus" style={`left:${focusX}%;top:${focusY}%`}></span>
          </button>
        </figure>
        <figure>
          <figcaption>Derived crop</figcaption>
          {#if cropUrl}<img src={cropUrl} alt="Generated crop" />{:else}<p role="status">Preparing crop…</p>{/if}
        </figure>
      </div>
      <div class="osmm-image-focus-controls">
        <label>Horizontal <input type="range" aria-label="Focal point horizontal" min="0" max="100" bind:value={focusX} oninput={() => void refreshCrop()} /></label>
        <label>Vertical <input type="range" aria-label="Focal point vertical" min="0" max="100" bind:value={focusY} oninput={() => void refreshCrop()} /></label>
      </div>
    {/if}
    <div class="osmm-row osmm-image-actions">
      <button type="button" onclick={cancel} disabled={accepting}>Cancel</button>
      <button type="button" class="mod-cta" onclick={() => void accept()} disabled={!cropUrl || generating || cropping || accepting}>Use image</button>
    </div>
  </div>
</div>
