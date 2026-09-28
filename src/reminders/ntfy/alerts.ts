import type { FailureInfo, PublishedInfo } from "../../publish/orchestrator";
import type { NtfyClient, NtfyMessage } from "./client";
import { failureMessage, publishedMessage, type ReminderContentDeps } from "./content";

export interface PhoneAlertsDeps {
  /** Phone reminders on, plus "Push publishing results" on this device. */
  enabled(): boolean;
  isPublisher(): boolean;
  client: Pick<NtfyClient, "publish">;
  content: Omit<ReminderContentDeps, "targetUrl">;
  warn(message: string): void;
}

/** Optional pushes for automatic-post results (#70). Immediate, never booked; only the publisher sends them. */
export class PhoneAlerts {
  constructor(private readonly deps: PhoneAlertsDeps) {}

  failed(info: FailureInfo): void {
    this.send(() => failureMessage(info, this.deps.content));
  }

  published(info: PublishedInfo): void {
    this.send(() => publishedMessage(info, this.deps.content));
  }

  private send(build: () => NtfyMessage): void {
    if (!this.deps.enabled() || !this.deps.isPublisher()) return;
    void Promise.resolve()
      .then(() => this.deps.client.publish(build()))
      .catch((e: unknown) => {
        // NtfyError messages are scrubbed of the topic and token by the client.
        this.deps.warn(`Phone alert not sent: ${e instanceof Error ? e.message : "unknown error"}`);
      });
  }
}
