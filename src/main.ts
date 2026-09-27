import { Plugin } from "obsidian";
import "./styles/index.css";

export default class OsmmPlugin extends Plugin {
  override async onload(): Promise<void> {
    console.debug("[osmm] loaded");
  }

  override onunload(): void {
    console.debug("[osmm] unloaded");
  }
}
