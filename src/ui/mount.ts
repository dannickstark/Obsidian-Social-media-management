import { flushSync, mount, unmount, type Component } from "svelte";

export interface Mounted {
  destroy(): void;
}

/** Mount a Svelte 5 component; `destroy()` is safe to call more than once (e.g. from onClose and onunload). */
export function mountSvelte<P extends Record<string, unknown>>(
  target: HTMLElement,
  component: Component<P>,
  props: P,
  context?: Map<unknown, unknown>,
): Mounted {
  const instance = mount(component, { target, props, context });
  // `onMount`/`onDestroy` run as user effects, which Svelte 5 flushes on a
  // microtask by default; flushSync forces them to run immediately so a
  // synchronous destroy() right after mount still fires onDestroy hooks.
  flushSync();
  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      flushSync(() => void unmount(instance));
    },
  };
}
