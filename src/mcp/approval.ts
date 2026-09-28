export interface ApprovalRequest {
  action: "publish" | "update";
  title: string;
  path: string;
  platformLabel: string;
  channels: Array<{ id: string; name: string; how: string }>;
  /** The exact text as the platform receives it (clipped for display). */
  text: string;
  /** Claude's one-line reason, shown to the user. */
  note?: string;
}

export type ApprovalAnswer = { approved: true; how: "asked" | "policy" } | { approved: false; reason: string };

export interface ApprovalView {
  close(): void;
}

export interface ApprovalGateDeps {
  /** Shows the question; `answer` may be called at most once that counts. */
  open(req: ApprovalRequest, answer: (a: ApprovalAnswer) => void): ApprovalView;
  /** The per-channel setting "publish without asking" (default: ask). It covers publish_now only; updates to live posts always ask. */
  allowedWithoutAsking(channelId: string): boolean;
  timeoutMs?: number;
}

export const APPROVAL_TIMEOUT_MS = 120_000;
export const DENIED = "The user said no in Obsidian.";
export const TIMED_OUT = "Nobody answered in Obsidian in time, so nothing was sent. Ask the user to watch Obsidian, then try again.";
export const BUSY = "Another question is already open in Obsidian. Wait for the user's answer, then try again.";
export const CLOSED = "Obsidian closed the question, so nothing was sent.";

/** In-Obsidian approval for publish tools (spec §6.1, #77): one question at a time; silence is a no. */
export class ApprovalGate {
  private pending: ((a: ApprovalAnswer) => void) | null = null;
  /** After plugin unload every question is answered no, including channels allowed without asking. */
  private disposed = false;

  constructor(private readonly deps: ApprovalGateDeps) {}

  get waiting(): boolean {
    return this.pending !== null;
  }

  request(req: ApprovalRequest): Promise<ApprovalAnswer> {
    if (this.disposed) return Promise.resolve({ approved: false, reason: CLOSED });
    if (req.action === "publish" && req.channels.length && req.channels.every((c) => this.deps.allowedWithoutAsking(c.id))) return Promise.resolve({ approved: true, how: "policy" });
    if (this.pending) return Promise.resolve({ approved: false, reason: BUSY });
    return new Promise((resolve) => {
      let done = false;
      let view: ApprovalView | null = null;
      const settle = (a: ApprovalAnswer) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        this.pending = null;
        view?.close();
        resolve(a);
      };
      const timer = window.setTimeout(() => settle({ approved: false, reason: TIMED_OUT }), this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
      this.pending = settle;
      try {
        view = this.deps.open(req, settle);
      } catch {
        // A question that can't be shown can't be answered yes.
        settle({ approved: false, reason: CLOSED });
        return;
      }
      if (done) view.close();
    });
  }

  /** Plugin unload: an open question is answered no, and so is every later one. */
  dispose(): void {
    this.disposed = true;
    this.pending?.({ approved: false, reason: CLOSED });
  }
}
