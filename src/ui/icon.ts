import { setIcon } from "obsidian";

/** Svelte action: `<span use:icon={"calendar-days"}></span>` renders an Obsidian (Lucide) icon. */
export function icon(node: HTMLElement, name: string) {
  setIcon(node, name);
  return {
    update(next: string) {
      node.replaceChildren();
      setIcon(node, next);
    },
  };
}
