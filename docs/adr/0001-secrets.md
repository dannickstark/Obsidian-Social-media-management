# ADR 0001 — Storing secrets

- Status: accepted (2026-09-27)
- Issue: #22

## Context
Channels need tokens (API tokens, page tokens, WordPress application passwords). The ntfy token, the OpenAI key and the MCP bearer token are secrets too. The vault syncs through iCloud, Git or Obsidian Sync, so `data.json` is not a safe place for them.

## Decision
- Use Obsidian's `app.secretStorage` (API since **1.11.4**): `setSecret(id, value)`, `getSecret(id)`, `listSecrets()`. It is per device and never synced.
- Set the plugin's `minAppVersion` to **1.11.4**. No fallback storage (YAGNI).
- Settings store only **secret ids**, e.g. `Channel.secretId = "osmm-channel-li-acme-studio"`. Ids are lowercase alphanumeric with dashes, which the API requires.
- The settings UI uses Obsidian's `SecretComponent`, so users can pick or create a secret from the shared keychain.
- The API has no delete, so "clear" means `setSecret(id, "")`, and an empty string is treated as absent.

## Consequences
- Each device that publishes must be configured with its own secrets.
- Secrets never appear in `data.json`, logs or notices: errors pass through `Secrets.redact`.
