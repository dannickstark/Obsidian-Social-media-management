import { describe, expect, it } from "vitest";
import { App, Modal } from "../fakes/obsidian";
import { ApprovalGate, BUSY, CLOSED, DENIED, TIMED_OUT, type ApprovalAnswer, type ApprovalRequest } from "../../src/mcp/approval";
import { openApprovalModal } from "../../src/mcp/ApprovalModal";

const REQ: ApprovalRequest = {
  action: "publish",
  title: "Doors open",
  path: "Social/Posts/Tg.md",
  platformLabel: "Telegram",
  channels: [{ id: "tg/event-x", name: "Event X channel", how: "posts through the API now", status: "scheduled" }],
  text: "Doors open at 18:00",
  items: ["Doors open at 18:00"],
  details: [],
  note: "The user asked to post it now.",
};

describe("ApprovalGate", () => {
  it("skips the question only when every channel may publish without asking", async () => {
    let opened = 0;
    const gate = new ApprovalGate({ open: () => (opened++, { close: () => undefined }), allowedWithoutAsking: (id) => id === "tg/event-x", timeoutMs: 20 });
    expect(await gate.request(REQ)).toEqual({ approved: true, how: "policy" });
    const two = { ...REQ, channels: [...REQ.channels, { id: "li/me", name: "Me", how: "x", status: "scheduled" }] };
    expect(await gate.request(two)).toEqual({ approved: false, reason: TIMED_OUT });
    expect(opened).toBe(1);
  });

  it("always asks before updating a live post, even for channels allowed without asking", async () => {
    let opened = 0;
    const gate = new ApprovalGate({ open: () => (opened++, { close: () => undefined }), allowedWithoutAsking: () => true, timeoutMs: 20 });
    expect(await gate.request({ ...REQ, action: "update" })).toEqual({ approved: false, reason: TIMED_OUT });
    expect(opened).toBe(1);
  });

  it("never skips the question for a request without channels", async () => {
    let opened = 0;
    const gate = new ApprovalGate({ open: () => (opened++, { close: () => undefined }), allowedWithoutAsking: () => true, timeoutMs: 20 });
    expect(await gate.request({ ...REQ, channels: [] })).toEqual({ approved: false, reason: TIMED_OUT });
    expect(opened).toBe(1);
  });

  it("denies when nobody answers, when a question is already open, and on unload (review focus 3, 4)", async () => {
    const closed: number[] = [];
    const gate = new ApprovalGate({ open: () => ({ close: () => void closed.push(1) }), allowedWithoutAsking: () => false, timeoutMs: 200 });
    const first = gate.request(REQ);
    expect(gate.waiting).toBe(true);
    expect(await gate.request(REQ)).toEqual({ approved: false, reason: BUSY });
    gate.dispose();
    expect(await first).toEqual({ approved: false, reason: CLOSED });
    expect(closed).toEqual([1]);
    expect(gate.waiting).toBe(false);
  });

  it("times out as a no and closes the question", async () => {
    const closed: number[] = [];
    const gate = new ApprovalGate({ open: () => ({ close: () => void closed.push(1) }), allowedWithoutAsking: () => false, timeoutMs: 20 });
    expect(await gate.request(REQ)).toEqual({ approved: false, reason: TIMED_OUT });
    expect(closed).toEqual([1]);
    expect(gate.waiting).toBe(false);
  });

  it("answers no to every question after unload, even for channels allowed without asking", async () => {
    let opened = 0;
    const gate = new ApprovalGate({ open: () => (opened++, { close: () => undefined }), allowedWithoutAsking: () => true, timeoutMs: 20 });
    gate.dispose();
    expect(await gate.request(REQ)).toEqual({ approved: false, reason: CLOSED });
    expect(opened).toBe(0);
  });

  it("answers no and frees the gate when the question can't be shown", async () => {
    const gate = new ApprovalGate({
      open: () => {
        throw new Error("no workspace");
      },
      allowedWithoutAsking: () => false,
      timeoutMs: 20,
    });
    expect(await gate.request(REQ)).toEqual({ approved: false, reason: CLOSED });
    expect(gate.waiting).toBe(false);
  });

  it("takes the first answer only, even when the view answers at once", async () => {
    const gate = new ApprovalGate({
      open: (_req, answer) => {
        answer({ approved: true, how: "asked" });
        answer({ approved: false, reason: DENIED });
        return { close: () => undefined };
      },
      allowedWithoutAsking: () => false,
    });
    expect(await gate.request(REQ)).toEqual({ approved: true, how: "asked" });
    expect(gate.waiting).toBe(false);
  });

  it("ignores an approval that arrives after the timeout", async () => {
    let late: ((a: ApprovalAnswer) => void) | null = null;
    const gate = new ApprovalGate({ open: (_req, answer) => ((late = answer), { close: () => undefined }), allowedWithoutAsking: () => false, timeoutMs: 20 });
    expect(await gate.request(REQ)).toEqual({ approved: false, reason: TIMED_OUT });
    late!({ approved: true, how: "asked" });
    expect(gate.waiting).toBe(false);
  });
});

describe("approval modal", () => {
  const buttons = (m: Modal) => [...m.contentEl.querySelectorAll("button")];

  it("shows what, where and when, and approves", () => {
    const answers: ApprovalAnswer[] = [];
    openApprovalModal(new App() as never, REQ, (a) => void answers.push(a));
    const modal = Modal.opened.at(-1)!;
    expect(modal.titleEl.textContent).toBe("Claude wants to publish");
    const text = modal.contentEl.textContent ?? "";
    expect(text).toContain("Doors open · Telegram · 1 channel · now");
    expect(text).toContain("Event X channel: posts through the API now (scheduled)");
    expect(text).toContain("Doors open at 18:00");
    expect(text).toContain("The user asked to post it now.");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(buttons(modal).map((b) => [b.textContent, b.type])).toEqual([
      ["Approve", "button"],
      ["Deny", "button"],
    ]);
    expect(modal.contentEl.querySelector("textarea")!.getAttribute("aria-label")).toBeTruthy();
    buttons(modal).find((b) => b.textContent === "Approve")!.click();
    expect(answers).toEqual([{ approved: true, how: "asked" }]);
    expect(modal.isOpen).toBe(false);
  });

  it("shows where, every part of the text in full, and every labelled detail (fix round 1: I1, I2, m2)", () => {
    const long = "b".repeat(4500);
    openApprovalModal(
      new App() as never,
      {
        ...REQ,
        channels: [...REQ.channels, { id: "li/me", name: "Me", how: "opens the assisted flow in Obsidian; you post it", status: "waiting for you" }],
        text: `Part one\n\n${long}`,
        items: ["Part one", long],
        details: [
          { label: "Link", value: "https://eventx.berlin/" },
          { label: "Image 1", value: "cover.png, alt text: The venue at night" },
          { label: "Slug", value: "event-x-recap" },
        ],
      },
      () => undefined,
    );
    const modal = Modal.opened.at(-1)!;
    const c = modal.contentEl;
    const headings = [...c.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Where", "Text that will be posted"]));
    expect(c.textContent).toContain("Me: opens the assisted flow in Obsidian; you post it (waiting for you)");
    const parts = [...c.querySelectorAll("pre")];
    expect(parts.map((p) => p.getAttribute("aria-label"))).toEqual(["Post 1 of 2", "Post 2 of 2"]);
    expect(parts[1]!.textContent).toBe(long);
    expect(c.textContent).toContain("Post 1 of 2");
    const rows = [...c.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ["Link", "https://eventx.berlin/"],
      ["Image 1", "cover.png, alt text: The venue at night"],
      ["Slug", "event-x-recap"],
    ]);
    modal.close();
  });

  it("labels a single text block", () => {
    openApprovalModal(new App() as never, REQ, () => undefined);
    const modal = Modal.opened.at(-1)!;
    expect([...modal.contentEl.querySelectorAll("pre")].map((p) => p.getAttribute("aria-label"))).toEqual(["Text that will be posted"]);
    expect(modal.contentEl.querySelector("dl")).toBeNull();
    modal.close();
  });

  it("titles an update differently", () => {
    openApprovalModal(new App() as never, { ...REQ, action: "update" }, () => undefined);
    const modal = Modal.opened.at(-1)!;
    expect(modal.titleEl.textContent).toBe("Claude wants to update a live post");
    modal.close();
  });

  it("denies with the user's reason, and denies when closed without an answer", () => {
    const answers: ApprovalAnswer[] = [];
    openApprovalModal(new App() as never, REQ, (a) => void answers.push(a));
    const modal = Modal.opened.at(-1)!;
    modal.contentEl.querySelector("textarea")!.value = "not today";
    buttons(modal).find((b) => b.textContent === "Deny")!.click();
    openApprovalModal(new App() as never, REQ, (a) => void answers.push(a));
    Modal.opened.at(-1)!.close();
    expect(answers).toEqual([
      { approved: false, reason: "The user said no in Obsidian: not today" },
      { approved: false, reason: DENIED },
    ]);
  });
});
