/**
 * Browser APIs the plugin uses that jsdom lacks or that must not really run in tests
 * (clipboard, window.open, system notifications, window focus). Installed by test/setup.ts.
 */
export type ClipboardWrite = { kind: "text"; text: string } | { kind: "blob"; type: string; size: number };

export class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requested = 0;
  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requested++;
    return FakeNotification.permission;
  }
  onclick: ((ev: Event) => unknown) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    browser.notifications.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: the user clicks the system notification. */
  click(): void {
    this.onclick?.(new Event("click"));
  }
}

export class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
  get types(): string[] {
    return Object.keys(this.items);
  }
}

export const browser = {
  clipboard: [] as ClipboardWrite[],
  opened: [] as string[],
  notifications: [] as FakeNotification[],
  focused: true,
};

export function installBrowserFakes(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        browser.clipboard.push({ kind: "text", text });
      },
      write: async (items: FakeClipboardItem[]) => {
        for (const item of items) for (const [type, blob] of Object.entries(item.items)) browser.clipboard.push({ kind: "blob", type, size: blob.size });
      },
    },
  });
  Object.assign(globalThis, { ClipboardItem: FakeClipboardItem, Notification: FakeNotification });
  window.open = ((url?: string | URL) => {
    browser.opened.push(String(url));
    return null;
  }) as typeof window.open;
  document.hasFocus = () => browser.focused;
}

export function resetBrowserFakes(): void {
  browser.clipboard = [];
  browser.opened = [];
  browser.notifications = [];
  browser.focused = true;
  FakeNotification.permission = "granted";
  FakeNotification.requested = 0;
}
