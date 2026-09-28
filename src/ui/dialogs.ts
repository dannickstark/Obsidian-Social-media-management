import { Modal, type App } from "obsidian";
import type { Component } from "svelte";
import { mountSvelte, type Mounted } from "./mount";
import { osmmContext, type OsmmContext } from "./context";

function button(text: string, cta: boolean, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  if (cta) el.className = "mod-cta";
  el.addEventListener("click", onClick);
  return el;
}

export function confirmDialog(app: App, message: string, cta = "Continue"): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        const text = document.createElement("p");
        text.textContent = message;
        const row = document.createElement("div");
        row.className = "modal-button-container";
        row.append(
          button(cta, true, () => {
            answered = true;
            resolve(true);
            this.close();
          }),
          button("Cancel", false, () => this.close()),
        );
        this.contentEl.append(text, row);
      }
      override onClose(): void {
        this.contentEl.replaceChildren();
        if (!answered) resolve(false);
      }
    })(app);
    modal.open();
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

export function pickDateTime(app: App, title: string, initial: number): Promise<number | null> {
  return new Promise((resolve) => {
    let result: number | null = null;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        const d = new Date(initial);
        const date = document.createElement("input");
        date.type = "date";
        date.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        date.setAttribute("aria-label", "Date");
        const time = document.createElement("input");
        time.type = "time";
        time.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        time.setAttribute("aria-label", "Time");
        const row = document.createElement("div");
        row.className = "modal-button-container";
        row.append(
          button("Schedule", true, () => {
            const [y, m, day] = date.value.split("-").map(Number);
            const [h, min] = time.value.split(":").map(Number);
            if (y && m && day && h !== undefined && min !== undefined) result = new Date(y, m - 1, day, h, min).getTime();
            this.close();
          }),
          button("Cancel", false, () => this.close()),
        );
        this.contentEl.append(date, time, row);
      }
      override onClose(): void {
        this.contentEl.replaceChildren();
        resolve(result);
      }
    })(app);
    modal.open();
  });
}

/** A modal whose body is a Svelte component. The component gets a `close` prop. */
export class SvelteModal<P extends Record<string, unknown>> extends Modal {
  private mounted: Mounted | null = null;

  constructor(
    app: App,
    private readonly title: string,
    private readonly component: Component<P & { close: () => void }>,
    private readonly props: P,
    private readonly ctx: OsmmContext,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.addClass("osmm");
    this.mounted = mountSvelte(
      this.contentEl,
      this.component,
      { ...this.props, close: () => this.close() } as P & { close: () => void },
      osmmContext(this.ctx),
    );
  }

  override onClose(): void {
    this.mounted?.destroy();
    this.mounted = null;
  }
}
