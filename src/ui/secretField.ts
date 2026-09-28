import { SecretComponent, type App } from "obsidian";

/** Svelte action wrapping Obsidian's SecretComponent (the user picks or creates a secret; we store only its id). */
export function secretField(node: HTMLElement, opts: { app: App; value: string; onchange: (id: string) => void }) {
  const component = new SecretComponent(opts.app, node).setValue(opts.value).onChange((id) => opts.onchange(id));
  return {
    update(next: { app: App; value: string; onchange: (id: string) => void }) {
      component.setValue(next.value);
      opts = next;
    },
  };
}
