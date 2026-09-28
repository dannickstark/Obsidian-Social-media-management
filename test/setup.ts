import { beforeEach } from "vitest";
import { installBrowserFakes, resetBrowserFakes } from "./fakes/browser";
import { setPlatform } from "./fakes/obsidian";

installBrowserFakes();
beforeEach(() => {
  resetBrowserFakes();
  setPlatform("desktop");
});

// Minimal versions of the DOM helpers Obsidian adds to HTMLElement.
declare global {
  interface HTMLElement {
    empty(): void;
    addClass(...cls: string[]): void;
    removeClass(...cls: string[]): void;
    toggleClass(cls: string, value: boolean): void;
  }
}

HTMLElement.prototype.empty = function empty(this: HTMLElement) {
  this.replaceChildren();
};
HTMLElement.prototype.addClass = function addClass(this: HTMLElement, ...cls: string[]) {
  this.classList.add(...cls);
};
HTMLElement.prototype.removeClass = function removeClass(this: HTMLElement, ...cls: string[]) {
  this.classList.remove(...cls);
};
HTMLElement.prototype.toggleClass = function toggleClass(this: HTMLElement, cls: string, value: boolean) {
  this.classList.toggle(cls, value);
};

// jsdom has no ResizeObserver; Planner.svelte's bind:clientWidth (#27) needs one to mount at all.
// It never reports real sizes, so clientWidth stays 0 in tests (Planner.svelte relies on that for `compact`).
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });

export {};
