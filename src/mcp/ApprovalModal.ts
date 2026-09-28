import { Modal, type App } from "obsidian";
import { DENIED, type ApprovalAnswer, type ApprovalRequest, type ApprovalView } from "./approval";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

class ApprovalModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly req: ApprovalRequest,
    private readonly answer: (a: ApprovalAnswer) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { req } = this;
    this.setTitle(req.action === "publish" ? "Claude wants to publish" : "Claude wants to update a live post");
    const c = this.contentEl;
    c.addClass("osmm", "osmm-approval");
    const n = req.channels.length;
    c.append(el("p", `${req.title} · ${req.platformLabel} · ${n} channel${n === 1 ? "" : "s"} · now`, "osmm-approval-summary"));
    c.append(el("h3", "Where", "osmm-approval-heading"));
    const list = el("ul", undefined, "osmm-approval-channels");
    for (const ch of req.channels) list.append(el("li", `${ch.name}: ${ch.how} (${ch.status})`));
    c.append(list);
    if (req.details.length) {
      const rows = el("dl", undefined, "osmm-approval-details");
      for (const d of req.details) rows.append(el("dt", d.label), el("dd", d.value));
      c.append(rows);
    }
    if (req.note) c.append(el("p", `Claude's note: ${req.note}`, "osmm-approval-note"));
    c.append(el("h3", "Text that will be posted", "osmm-approval-heading"));
    const items = req.items.length ? req.items : [req.text];
    items.forEach((item, i) => {
      const label = items.length > 1 ? `Post ${i + 1} of ${items.length}` : "Text that will be posted";
      if (items.length > 1) c.append(el("p", label, "osmm-approval-part"));
      const pre = el("pre", item, "osmm-approval-text");
      pre.setAttribute("aria-label", label);
      pre.tabIndex = 0;
      c.append(pre);
    });
    const reason = el("textarea");
    reason.placeholder = "Why not? (optional, sent to Claude)";
    reason.setAttribute("aria-label", "Reason for saying no, sent to Claude");
    reason.rows = 2;
    c.append(reason);
    const row = el("div", undefined, "modal-button-container");
    const approve = el("button", "Approve", "mod-cta");
    approve.type = "button";
    approve.addEventListener("click", () => this.finish({ approved: true, how: "asked" }));
    const deny = el("button", "Deny");
    deny.type = "button";
    deny.addEventListener("click", () => {
      const why = reason.value.trim();
      this.finish({ approved: false, reason: why ? `The user said no in Obsidian: ${why}` : DENIED });
    });
    row.append(approve, deny);
    c.append(row);
  }

  private finish(a: ApprovalAnswer): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(a);
    this.close();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
    // Escape or the close button: no.
    if (!this.answered) {
      this.answered = true;
      this.answer({ approved: false, reason: DENIED });
    }
  }
}

export function openApprovalModal(app: App, req: ApprovalRequest, answer: (a: ApprovalAnswer) => void): ApprovalView {
  const modal = new ApprovalModal(app, req, answer);
  modal.open();
  return { close: () => modal.close() };
}
