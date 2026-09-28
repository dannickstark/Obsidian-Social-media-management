# Social Planner (OSMM) for Claude Code

The `/osmm:social` skill plans, drafts, checks and schedules social media campaigns in your Obsidian vault, through the Social Planner (OSMM) plugin's local MCP server.

## Install
1. In a terminal: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management`
2. Then: `claude plugin install osmm@osmm-social-planner`
3. In Obsidian: **Settings → Social Planner → Claude Code**, turn on **MCP server on this device**, click **Copy setup command** and run it in a terminal. The command has the form `claude mcp add --transport http --scope user osmm http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`. This connects Claude Code to your vault; the command contains a secret token, so don't share it. After a new token or a port change, run `claude mcp remove --scope user osmm` first, then copy and run the new setup command.

## Use
In Claude Code, type `/osmm:social` followed by what you want, for example `/osmm:social plan the Event X launch for LinkedIn, X and Mastodon`. Claude reads the campaign and your voice profile, proposes a plan, drafts each post, checks it with the plugin and schedules it after you agree. It never publishes unless you ask. When Claude posts now (`publish_now`) or edits a live post (`push_update`), Obsidian asks you to approve first (you can let a channel skip that question for posting now); a post Claude schedules goes out at its time without a second question.

When Obsidian is closed, run Claude Code inside your vault folder: the skill then writes the notes directly, and Obsidian shows them under **Written by Claude** for you to approve the next time it opens.
