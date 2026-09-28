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
    const list = el("ul", undefined, "osmm-approval-channels");
    for (const ch of req.channels) list.append(el("li", `${ch.name}: ${ch.how}`));
    c.append(list);
    if (req.note) c.append(el("p", `Claude's note: ${req.note}`, "osmm-approval-note"));
    c.append(el("pre", req.text, "osmm-approval-text"));
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
