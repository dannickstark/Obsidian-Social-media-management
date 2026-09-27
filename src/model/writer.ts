import type { App, TFile } from "obsidian";
import { parseVariant, serializeDeliveries, variantFields, type VariantPatch } from "./frontmatter";
import { rollupStatus, transition } from "./stateMachine";
import type { Delivery, DeliveryStatus, Variant } from "./types";

type Frontmatter = Record<string, unknown>;

function applyFields(fm: Frontmatter, fields: Frontmatter): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete fm[key];
    else fm[key] = value;
  }
}

function requireVariant(fm: Frontmatter, path: string): Variant {
  const parsed = parseVariant(fm, path).value;
  if (!parsed) throw new Error(`${path} is not a valid social post`);
  return parsed;
}

/**
 * The single entry point for mutating frontmatter of existing notes.
 * Writes to the same TFile are applied one after another (keyed by object identity, so renames are safe).
 */
export class SafeWriter {
  private readonly queues = new WeakMap<TFile, Promise<unknown>>();

  constructor(private readonly app: App) {}

  run<T>(file: TFile, fn: (fm: Frontmatter) => T): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    let result!: T;
    const next = previous
      .catch(() => undefined)
      .then(() =>
        this.app.fileManager.processFrontMatter(file, (fm: Frontmatter) => {
          result = fn(fm);
        }),
      )
      .then(() => result);
    this.queues.set(
      file,
      next.catch(() => undefined),
    );
    return next;
  }

  setFields(file: TFile, fields: Frontmatter): Promise<void> {
    return this.run(file, (fm) => applyFields(fm, fields));
  }

  patchVariant(file: TFile, patch: VariantPatch): Promise<void> {
    return this.run(file, (fm) => {
      applyFields(fm, variantFields(patch));
      const v = requireVariant(fm, file.path);
      fm.status = rollupStatus(v);
    });
  }

  updateDeliveries(file: TFile, patch: Record<string, Delivery | null>): Promise<void> {
    return this.run(file, (fm) => {
      const v = requireVariant(fm, file.path);
      const deliveries = { ...v.deliveries };
      for (const [id, d] of Object.entries(patch)) {
        if (d === null) delete deliveries[id];
        else deliveries[id] = d;
      }
      applyFields(fm, { deliveries: serializeDeliveries(deliveries), status: rollupStatus({ ...v, deliveries }) });
    });
  }

  transitionDelivery(
    file: TFile,
    channelId: string,
    to: DeliveryStatus,
    patch: Partial<Omit<Delivery, "status">> = {},
  ): Promise<Delivery> {
    return this.run(file, (fm) => {
      const v = requireVariant(fm, file.path);
      const next = transition(v.deliveries[channelId] ?? { status: "draft" }, to, patch);
      const deliveries = { ...v.deliveries, [channelId]: next };
      applyFields(fm, { deliveries: serializeDeliveries(deliveries), status: rollupStatus({ ...v, deliveries }) });
      return next;
    });
  }
}
