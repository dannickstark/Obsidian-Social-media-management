import { normalizePath, Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type OsmmPlugin from "../main";
import { formatTemplateLines, parseTemplateLines } from "../planner/templates";
import { ClipboardService } from "../publish/clipboard";
import { WITHDRAW_WAIT_MS } from "../reminders/ntfy/booker";
import { testMessage } from "../reminders/ntfy/client";
import { DEFAULT_NTFY_SERVER, normalizeServer, randomTopic, TOPIC_RE } from "../reminders/ntfy/config";
import { SecretIds } from "../secrets/secrets";
import { confirmDialog } from "../ui/dialogs";
import { settlesWithin } from "../util/time";
import { mountSvelte, type Mounted } from "../ui/mount";
import { osmmContext } from "../ui/context";
import ChannelsSection from "./ChannelsSection.svelte";
import { cleanDeviceName } from "./device";
import { publisherDescription } from "./publisher";
import { parseMinutesList } from "./settings";

const ABOUT_PHONE =
  "Pushes your reminders to the free ntfy app on your phone, so they arrive even when this computer is asleep. The publisher device books each reminder up to 72 hours ahead. Privacy: on a public server such as ntfy.sh, anyone who knows the topic can read these pushes: the post title, the post text (inside the pre-filled link), links, and the vault name and the note's path (in the Obsidian links). Keep the long random topic, or use your own ntfy server with an access token.";
const SETUP_PHONE =
  "1. Install ntfy from the App Store or Google Play. 2. In the app, tap + and enter the topic above; for your own server, turn on “Use another server” and enter its address. 3. Tap “Send test” below: it should arrive within a few seconds.";
const TOKEN_DESC = "Only for protected topics (your own server, or a reserved ntfy.sh topic). Stored in this device's secret storage.";
const HTTP_TOKEN_WARNING = "Warning: this server uses http, so the token travels unencrypted. Use an https address.";
/** Server and Topic edits apply this long after the last keystroke, or when the field loses focus (final review 1). */
export const TARGET_EDIT_DELAY_MS = 1_500;

/** A Server or Topic value typed but not applied yet. */
interface TargetEdit {
  server?: string;
  topic?: string;
}

function plainHttp(server: string): boolean {
  try {
    return new URL(server).protocol === "http:";
  } catch {
    return false;
  }
}

export class OsmmSettingTab extends PluginSettingTab {
  private channelsUi: Mounted | null = null;
  /** Server/Topic edits waiting for the pause after the last keystroke (final review 1). */
  private pendingTarget: TargetEdit = {};
  private targetTimer: number | null = null;
  /** Applied edits run one after the other: each withdraws from the target the previous one set. */
  private targetChain: Promise<void> = Promise.resolve();
  private unloaded = false;

  constructor(
    app: App,
    private readonly osmm: OsmmPlugin,
  ) {
    super(app, osmm);
    // Re-review 3: a typed value is never lost. On unload there is no time to withdraw, so a pending edit is
    // saved at once (its old bookings forgotten; pushes already booked on the old target still arrive).
    osmm.register(() => {
      this.unloaded = true;
      this.clearTargetTimer();
      const edit = this.pendingTarget;
      this.pendingTarget = {};
      this.commitTargetEdit(edit);
    });
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.osmm.settings;

    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Root folder")
      .setDesc("New campaigns and standalone posts are created here.")
      .addText((t) =>
        t
          .setPlaceholder("Social")
          .setValue(s.rootFolder)
          .onChange(async (value) => {
            await this.osmm.updateSettings({ rootFolder: normalizePath(value.trim() || "Social") });
          }),
      );

    new Setting(containerEl)
      .setName("Week starts on")
      .addDropdown((d) =>
        d
          .addOption("1", "Monday")
          .addOption("0", "Sunday")
          .setValue(String(s.weekStartsOn))
          .onChange(async (value) => {
            await this.osmm.updateSettings({ weekStartsOn: value === "0" ? 0 : 1 });
          }),
      );

    new Setting(containerEl)
      .setName("Default reminders")
      .setDesc("Minutes before a post, comma-separated (e.g. 60, 10).")
      .addText((t) =>
        t.setValue(s.defaultReminders.join(", ")).onChange(async (value) => {
          const parsed = parseMinutesList(value);
          if (parsed) await this.osmm.updateSettings({ defaultReminders: parsed });
        }),
      );

    new Setting(containerEl)
      .setName("Default stagger")
      .setDesc("Minutes between channels when one post goes to several channels.")
      .addText((t) =>
        t.setValue(String(s.defaultStaggerMinutes)).onChange(async (value) => {
          if (/^\d+$/.test(value.trim())) await this.osmm.updateSettings({ defaultStaggerMinutes: Number(value.trim()) });
        }),
      );

    new Setting(containerEl).setName("This device").setHeading();

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Other devices show this name when this device publishes. Stored on this device only.")
      .addText((t) =>
        t.setValue(this.osmm.device.deviceName).onChange(async (value) => {
          const name = cleanDeviceName(value);
          if (!name) return;
          this.osmm.setDevice({ deviceName: name });
          try {
            await this.osmm.publisher.renamed();
          } catch (e) {
            new Notice(`Couldn't update the publisher name: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );

    const publisher = this.osmm.publisher.state();
    new Setting(containerEl)
      .setName("Publisher device")
      .setDesc(publisherDescription(publisher))
      .addButton((b) =>
        b.setButtonText(publisher.kind === "this" ? "Stop publishing here" : "Make this device the publisher").onClick(async () => {
          if (publisher.kind === "this") {
            const ok = await confirmDialog(this.app, "Stop publishing from this device? Until another device is chosen, scheduled posts are neither posted nor marked overdue.", "Stop publishing");
            if (ok) await this.osmm.publisher.release();
          } else {
            await this.osmm.publisher.takeOver((message) => confirmDialog(this.app, message, "Make this device the publisher"));
          }
          this.display();
        }),
      );

    new Setting(containerEl).setName("Publishing").setHeading();

    new Setting(containerEl)
      .setName("Post late items automatically")
      .setDesc("If Obsidian was closed at a post's time, post it anyway when it is less late than the window below. Otherwise it waits in the Overdue tray.")
      .addToggle((t) =>
        t.setValue(s.autoPostLate).onChange(async (value) => {
          await this.osmm.updateSettings({ autoPostLate: value });
        }),
      );

    new Setting(containerEl)
      .setName("Late window (minutes)")
      .setDesc("From 1 to 240 minutes.")
      .addText((t) =>
        t.setValue(String(s.autoPostLateMinutes)).onChange(async (value) => {
          const n = Number(value.trim());
          if (Number.isInteger(n) && n >= 1 && n <= 240) await this.osmm.updateSettings({ autoPostLateMinutes: n });
        }),
      );

    new Setting(containerEl)
      .setName("Desktop notifications on this device")
      .setDesc("Reminders before assisted posts, when a post is due, and when publishing fails. Stored on this device only.")
      .addToggle((t) =>
        t.setValue(this.osmm.device.notifications).onChange((value) => {
          this.osmm.setDevice({ notifications: value });
        }),
      );

    this.phoneSection(containerEl);

    new Setting(containerEl).setName("Channels").setHeading();
    const host = document.createElement("div");
    host.className = "osmm";
    containerEl.appendChild(host);
    this.channelsUi?.destroy();
    this.channelsUi = mountSvelte(host, ChannelsSection, {}, osmmContext(this.osmm.uiContext()));

    new Setting(containerEl).setName("Schedule templates").setHeading();
    for (const template of s.scheduleTemplates) {
      new Setting(containerEl)
        .setName(template.name)
        .setDesc("One step per line: T±days HH:mm platforms [label], e.g. T-7 09:00 linkedin,x Announce")
        .addTextArea((t) =>
          t.setValue(formatTemplateLines(template.steps)).onChange(async (value) => {
            const { steps, errors } = parseTemplateLines(value);
            if (errors.length) return;
            await this.osmm.updateSettings({
              scheduleTemplates: this.osmm.settings.scheduleTemplates.map((x) => (x.id === template.id ? { ...x, steps } : x)),
            });
          }),
        );
    }
  }

  private phoneSection(containerEl: HTMLElement): void {
    const osmm = this.osmm;
    const ntfy = osmm.device.ntfy;
    const setNtfy = (patch: Partial<typeof ntfy>) => osmm.setDevice({ ntfy: { ...osmm.device.ntfy, ...patch } });

    new Setting(containerEl).setName("Phone reminders (ntfy)").setHeading();
    new Setting(containerEl).setName("About phone reminders").setDesc(ABOUT_PHONE);

    const role = osmm.publisher.state();
    new Setting(containerEl)
      .setName("Phone reminders on this device")
      .setDesc(
        role.kind === "this"
          ? "This device books a push for every reminder of the next 72 hours."
          : role.kind === "other"
            ? `Only the publisher device books phone reminders. Publishing happens on ${role.name}.`
            : "Only the publisher device books phone reminders. Choose one under This device.",
      )
      .addToggle((t) =>
        t.setValue(ntfy.enabled).onChange((value) => {
          if (value && !osmm.secrets.get(SecretIds.ntfyTopic)) osmm.secrets.set(SecretIds.ntfyTopic, randomTopic());
          setNtfy({ enabled: value });
          // Off first, so no run books anything more; the cancels go on in the background (Task 9 ruling).
          if (!value) void osmm.phone.withdraw();
          this.display();
        }),
      );
    if (!ntfy.enabled) return;

    // Task 5 ruling: a token sent to an http server travels unencrypted (the server being typed counts).
    const tokenDesc = () =>
      plainHttp(this.pendingTarget.server ?? osmm.device.ntfy.server) && osmm.secrets.get(SecretIds.ntfyToken) ? `${TOKEN_DESC} ${HTTP_TOKEN_WARNING}` : TOKEN_DESC;
    let tokenSetting: Setting | null = null;
    const onTargetFieldBlur = (el: HTMLElement) => el.addEventListener("blur", () => this.applyTargetEdits(() => tokenSetting?.setDesc(tokenDesc())));

    new Setting(containerEl)
      .setName("Server")
      .setDesc("https://ntfy.sh, or the address of your own ntfy server.")
      .addText((t) => {
        onTargetFieldBlur(t.inputEl);
        t.setPlaceholder(DEFAULT_NTFY_SERVER)
          .setValue(this.pendingTarget.server ?? ntfy.server)
          .onChange((value) => {
            const server = normalizeServer(value.trim() || DEFAULT_NTFY_SERVER);
            // Only a valid address that differs from the one in use is a change (a trailing "/" is not).
            if (server && server !== normalizeServer(osmm.device.ntfy.server)) this.pendingTarget.server = server;
            else delete this.pendingTarget.server;
            this.scheduleTargetEdits(() => tokenSetting?.setDesc(tokenDesc()));
            tokenSetting?.setDesc(tokenDesc());
          });
      });

    new Setting(containerEl)
      .setName("Topic")
      .setDesc("Subscribe to this topic in the ntfy app. At least 8 letters, digits, - and _. Stored in this device's secret storage.")
      .addText((t) => {
        onTargetFieldBlur(t.inputEl);
        t.setValue(this.pendingTarget.topic ?? osmm.secrets.get(SecretIds.ntfyTopic) ?? "").onChange((value) => {
          const topic = value.trim();
          if (TOPIC_RE.test(topic) && topic !== osmm.secrets.get(SecretIds.ntfyTopic)) this.pendingTarget.topic = topic;
          else delete this.pendingTarget.topic;
          this.scheduleTargetEdits(() => tokenSetting?.setDesc(tokenDesc()));
        });
      })
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          const topic = osmm.secrets.get(SecretIds.ntfyTopic);
          if (topic && (await new ClipboardService(this.app).copyText(topic))) new Notice("Topic copied.");
        }),
      )
      .addButton((b) =>
        b.setButtonText("New topic").onClick(async () => {
          const ok = await confirmDialog(this.app, "Make a new random topic? Your phone must subscribe to it again. Reminders already booked on the old topic are cancelled where the server allows it.", "New topic");
          if (!ok) return;
          delete this.pendingTarget.topic;
          // Re-review 2: after any Server/Topic edit still being applied, so the new topic is the one kept.
          this.targetChain = this.targetChain.then(async () => {
            // The cancels go to the old topic, so they run before it is replaced, for at most 10 s (Task 9 ruling).
            await settlesWithin(osmm.phone.withdraw(), WITHDRAW_WAIT_MS);
            // Then drop what is left for the old topic (pushes it couldn't cancel, a late record of an abandoned
            // run) so the new topic gets its own bookings, after the 60 s hold (M3 P13).
            osmm.phone.forget();
            osmm.secrets.set(SecretIds.ntfyTopic, randomTopic());
          });
          await this.targetChain;
          if (!this.unloaded) this.display();
        }),
      );

    tokenSetting = new Setting(containerEl)
      .setName("Access token")
      .setDesc(tokenDesc())
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("tk_…")
          .setValue(osmm.secrets.get(SecretIds.ntfyToken) ?? "")
          .onChange((value) => {
            // The token changes neither the server nor the topic: the bookings stay valid (final review 1).
            osmm.secrets.set(SecretIds.ntfyToken, value.trim());
            tokenSetting?.setDesc(tokenDesc());
          });
      });

    new Setting(containerEl).setName("Set up your phone").setDesc(SETUP_PHONE);

    new Setting(containerEl).setName("Send a test notification").addButton((b) =>
      b.setButtonText("Send test").onClick(async () => {
        try {
          await osmm.ntfy.publish(testMessage());
          new Notice("Test sent. It should reach your phone within a few seconds.");
        } catch (e) {
          new Notice(`Couldn't send the test: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );

    new Setting(containerEl)
      .setName("Push publishing results")
      .setDesc("Also push a confirmation when a post goes out through a platform connection, and an alert when one fails (sent by the publisher device).")
      .addToggle((t) => t.setValue(ntfy.results).onChange((value) => setNtfy({ results: value })));
  }

  /** Applies the pending Server/Topic edits 1.5 s after the last keystroke. */
  private scheduleTargetEdits(done: () => void): void {
    this.clearTargetTimer();
    this.targetTimer = window.setTimeout(() => this.applyTargetEdits(done), TARGET_EDIT_DELAY_MS);
  }

  private clearTargetTimer(): void {
    if (this.targetTimer !== null) window.clearTimeout(this.targetTimer);
    this.targetTimer = null;
  }

  /**
   * Final review 1: a real Server or Topic change first withdraws the bookings from the old target (for at most
   * 10 s, as New topic does), then forgets them (60 s hold, M3 P13) and only then switches to the new target.
   */
  private applyTargetEdits(done: () => void = () => undefined): void {
    this.clearTargetTimer();
    const edit = this.pendingTarget;
    this.pendingTarget = {};
    if (this.unloaded || (edit.server === undefined && edit.topic === undefined)) return;
    this.targetChain = this.targetChain.then(async () => {
      if (!this.realTargetChange(edit)) return;
      await settlesWithin(this.osmm.phone.withdraw(), WITHDRAW_WAIT_MS);
      // Applied even if the plugin unloaded meanwhile: the typed value is kept (re-review 3).
      if (this.commitTargetEdit(edit) && !this.unloaded) done();
    });
  }

  /** The parts of `edit` that differ from the target in use. */
  private realTargetChange(edit: TargetEdit): TargetEdit | null {
    const osmm = this.osmm;
    const server = edit.server !== undefined && edit.server !== normalizeServer(osmm.device.ntfy.server) ? edit.server : undefined;
    const topic = edit.topic !== undefined && edit.topic !== osmm.secrets.get(SecretIds.ntfyTopic) ? edit.topic : undefined;
    if (server === undefined && topic === undefined) return null;
    return { ...(server !== undefined ? { server } : {}), ...(topic !== undefined ? { topic } : {}) };
  }

  /** Forgets the old target's bookings (60 s hold, M3 P13) and switches to the new target. False when nothing changed. */
  private commitTargetEdit(edit: TargetEdit): boolean {
    const change = this.realTargetChange(edit);
    if (!change) return false;
    const osmm = this.osmm;
    osmm.phone.forget();
    if (change.server !== undefined) osmm.setDevice({ ntfy: { ...osmm.device.ntfy, server: change.server } });
    if (change.topic !== undefined) osmm.secrets.set(SecretIds.ntfyTopic, change.topic);
    return true;
  }

  override hide(): void {
    this.applyTargetEdits();
    this.channelsUi?.destroy();
    this.channelsUi = null;
  }
}
