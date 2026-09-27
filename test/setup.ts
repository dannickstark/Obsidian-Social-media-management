// Minimal versions of the DOM helpers Obsidian adds to HTMLElement.
declare global {
  interface HTMLElement {
    empty(): void;
  }
}

HTMLElement.prototype.empty = function empty(this: HTMLElement) {
  this.replaceChildren();
};

export {};
