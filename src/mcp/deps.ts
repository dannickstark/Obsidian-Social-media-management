import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import type { SocialIndex } from "../index/socialIndex";
import type { NoteFactory } from "../model/factory";
import type { SafeWriter } from "../model/writer";
import type { PublishActions } from "../publish/actions";
import type { OsmmSettings } from "../settings/settings";
import type { PlannerActions } from "../ui/actions";
import type { ApprovalGate } from "./approval";

/** What MCP tools may use: the same services the UI uses, so every write keeps the plugin's rules. */
export interface McpToolDeps {
  app: App;
  index: SocialIndex;
  channels: ChannelRegistry;
  factory: NoteFactory;
  writer: SafeWriter;
  planner: PlannerActions;
  composer: ComposerActions;
  publish: PublishActions;
  /** Only whether a credential exists; tools never read secret values. */
  secrets: { has(id: string): boolean };
  settings(): OsmmSettings;
  now(): number;
  isPublisher(): boolean;
  /** Asks the user in Obsidian before publish tools send anything. */
  approvals: ApprovalGate;
}
