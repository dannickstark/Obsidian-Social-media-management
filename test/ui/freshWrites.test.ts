import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo, parseYaml, type TFile } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { makeCtx, TEST_NOW, type TestCtx } from "./ctx";
import { formatDateTime } from "../../src/model/dates";

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin

async function fmOf(c: TestCtx, path: string): Promise<Record<string, unknown>> {
  const file = c.app.vault.getFileByPath(path)! as unknown as TFile;
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(file as never)).frontmatter);
}

function clickUndo(): void {
  Notice.last!.noticeEl.querySelector("button")!.click();
}

const P1 = "Social/Posts/P1.md";
const p1 = (me: Record<string, unknown>, status = "scheduled") => ({
  path: P1,
  frontmatter: {
    type: "social-post",
    platform: "linkedin",
    channels: ["li/me", "li/acme"],
    status,
    scheduled_at: formatDateTime(T),
    deliveries: {
      "li/me": me,
      "li/acme": { status: "Handed-Over", url: "https://x" },
    },
  },
});

describe("UI writes against fresh frontmatter (G1)", () => {
  it("P1: a drag reschedule keeps unparsable siblings and unknown keys verbatim", async () => {
    const c = await makeCtx({ notes: [p1({ status: "scheduled", note: "keep me" })] });
    const row = c.ctx.actions.rowByKey(`${P1}#li/me`)!;
    expect(await c.ctx.actions.reschedule(row, { at: T + DAY })).toBe(true);
    const fm = await fmOf(c, P1);
    expect(fm.scheduled_at).toBe(formatDateTime(T + DAY));
    expect(fm.deliveries).toEqual({
      "li/me": { status: "scheduled", note: "keep me" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
  });

  it("P1: a patched delivery key keeps its unknown keys", async () => {
    const c = await makeCtx({
      notes: [p1({ status: "scheduled", at: formatDateTime(T + 3600_000), note: "keep me" })],
    });
    const row = c.ctx.actions.rowByKey(`${P1}#li/me`)!;
    expect(await c.ctx.actions.reschedule(row, { at: T + DAY })).toBe(true);
    const fm = await fmOf(c, P1);
    expect(fm.deliveries).toEqual({
      "li/me": { status: "scheduled", at: formatDateTime(T + DAY), note: "keep me" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
  });

  it("P3: a reschedule right after an unawaited publish keeps the published record and pins its time", async () => {
    const path = "Social/Posts/P3.md";
    const c = await makeCtx({
      notes: [
        {
          path,
          frontmatter: {
            type: "social-post",
            platform: "linkedin",
            channels: ["li/me", "li/acme"],
            status: "scheduled",
            scheduled_at: formatDateTime(T),
            stagger_minutes: 15,
            deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "scheduled" } },
          },
        },
      ],
    });
    const acme = c.ctx.actions.rowByKey(`${path}#li/acme`)!;
    const file = acme.variant.file;
    const publish = c.writer.updateDeliveries(file, {
      "li/me": { status: "published", url: "https://li/1" },
    });
    expect(await c.ctx.actions.reschedule(acme, { at: T + DAY + 15 * 60_000 })).toBe(true);
    await publish;
    const fm = await fmOf(c, path);
    expect(fm.scheduled_at).toBe(formatDateTime(T + DAY));
    expect(fm.deliveries).toEqual({
      "li/me": { status: "published", url: "https://li/1", at: formatDateTime(T) },
      "li/acme": { status: "scheduled" },
    });
  });

  it("undo keeps values changed since and says so", async () => {
    const c = await makeCtx({ notes: [p1({ status: "scheduled", note: "keep me" })] });
    const row = c.ctx.actions.rowByKey(`${P1}#li/me`)!;
    await c.ctx.actions.reschedule(row, { at: T + DAY });
    const undo = Notice.last!;
    await c.writer.patchVariant(row.variant.file, { scheduledAt: T + 2 * DAY });
    undo.noticeEl.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(Notice.messages.at(-1)).toBe("Some changes were kept because the note changed since."),
    );
    expect((await fmOf(c, P1)).scheduled_at).toBe(formatDateTime(T + 2 * DAY));
  });

  it("undo restores untouched values without a conflict notice", async () => {
    const c = await makeCtx({
      notes: [p1({ status: "scheduled", at: formatDateTime(T), note: "keep me" })],
    });
    const row = c.ctx.actions.rowByKey(`${P1}#li/me`)!;
    await c.ctx.actions.reschedule(row, { at: T + DAY });
    const count = Notice.messages.length;
    clickUndo();
    await vi.waitFor(async () =>
      expect((await fmOf(c, P1)).deliveries).toEqual({
        "li/me": { status: "scheduled", at: formatDateTime(T), note: "keep me" },
        "li/acme": { status: "Handed-Over", url: "https://x" },
      }),
    );
    expect(Notice.messages.length).toBe(count);
  });

  it("board schedule and setStatus patch only the keys they change", async () => {
    const c = await makeCtx({ notes: [p1({ status: "draft", note: "keep me" })] });
    const v = c.index.getVariant(P1)!;
    await c.ctx.actions.setStatus(v, "ready");
    expect((await fmOf(c, P1)).deliveries).toEqual({
      "li/me": { status: "ready", note: "keep me" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
    await c.ctx.actions.schedule(v, T + DAY);
    const fm = await fmOf(c, P1);
    expect(fm.scheduled_at).toBe(formatDateTime(T + DAY));
    expect(fm.deliveries).toMatchObject({ "li/me": { status: "scheduled", note: "keep me" } });
    await c.ctx.actions.unschedule(v, "draft");
    expect((await fmOf(c, P1)).deliveries).toMatchObject({
      "li/me": { status: "draft", note: "keep me" },
    });
  });

  it("bulk shift and bulk status keep unknown keys and unparsable siblings", async () => {
    // Stored status "ready": the unparsable li/acme entry inherits it, so every row is editable (G3).
    const c = await makeCtx({
      notes: [p1({ status: "ready", at: formatDateTime(T), note: "keep me" }, "ready")],
    });
    const rows = c.ctx.actions.rows().filter((r) => r.variant.path === P1);
    await c.ctx.actions.bulkShift(rows, DAY);
    expect((await fmOf(c, P1)).deliveries).toEqual({
      "li/me": { status: "ready", at: formatDateTime(T + DAY), note: "keep me" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
    await c.ctx.actions.bulkSetStatus(rows, "draft");
    expect((await fmOf(c, P1)).deliveries).toEqual({
      "li/me": { status: "draft", at: formatDateTime(T + DAY), note: "keep me" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
  });

  it("board schedule never overwrites an unreadable delivery entry (parked M1 item)", async () => {
    const c = await makeCtx({ notes: [p1({ status: "draft" }, "draft")] });
    const v = c.index.getVariant(P1)!;
    await c.ctx.actions.schedule(v, T + DAY);
    const fm = await fmOf(c, P1);
    expect(fm.deliveries).toEqual({
      "li/me": { status: "scheduled" },
      "li/acme": { status: "Handed-Over", url: "https://x" },
    });
  });

  it("applyTemplate writes against fresh frontmatter and skips posts published since", async () => {
    const c = await makeCtx({ notes: [p1({ status: "scheduled", note: "keep me" })] });
    const v = c.index.getVariant(P1)!;
    await c.writer.updateDeliveries(v.file, { "li/me": { status: "published" } });
    await c.ctx.actions.applyTemplate([
      { variant: v, from: v.scheduledAt, to: TEST_NOW + DAY, label: "T0" },
    ]);
    expect((await fmOf(c, P1)).scheduled_at).toBe(formatDateTime(T));
  });
});
