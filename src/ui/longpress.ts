/**
 * Svelte action: after a 500 ms touch that stays within 10 px, calls `handler` with the touch point
 * (phones have no right click, #113). The click that follows the long press is swallowed.
 */
export function longpress(node: HTMLElement, handler: (point: { x: number; y: number }) => void) {
  let current = handler;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  const onStart = (e: Event) => {
    const t = (e as TouchEvent).touches?.[0];
    if (!t) return;
    fired = false;
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      fired = true;
      current(start);
    }, 500);
  };
  const onMove = (e: Event) => {
    const t = (e as TouchEvent).touches?.[0];
    if (t && start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  };
  const onClick = (e: Event) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  node.addEventListener("touchstart", onStart, { passive: true });
  node.addEventListener("touchmove", onMove, { passive: true });
  node.addEventListener("touchend", cancel);
  node.addEventListener("touchcancel", cancel);
  node.addEventListener("click", onClick, true);
  return {
    update(next: (point: { x: number; y: number }) => void) {
      current = next;
    },
    destroy() {
      cancel();
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", cancel);
      node.removeEventListener("touchcancel", cancel);
      node.removeEventListener("click", onClick, true);
    },
  };
}
