# Campaign review page (optional)

Use when the user wants to share a campaign for sign-off before it is scheduled.

## Build the page
Make one self-contained HTML page (inline CSS, no scripts, no external fonts or trackers):
- Header: campaign title, anchor date, goal, link, and "Draft for review, <date>".
- Schedule table: date and time, platform, channels, status, one line per post, in time order.
- One card per post: platform and channels, time, the full text exactly as it will be posted (HTML-escaped; thread parts separated), title and link where the platform uses them, image names with their alt text, and any warnings from `validate`.
- A short "What we need from you" list: approve, or comment per post.

Never include tokens, the ntfy topic, file paths outside the vault or anything from `data.json` beyond channel names.

## Share it
If this Claude Code session has a tool to publish a private page or artifact, use it and give the user the link; keep it private unless the user says otherwise. Otherwise save it next to the campaign as `<Campaign> – review.html` and tell the user where it is. Say that the page is a snapshot: later edits in Obsidian don't update it.

## Record the decisions
When the user brings back comments or decisions, summarise them per post and, after the user confirms the summary, call `append_to_campaign` with the heading `Review decisions (<YYYY-MM-DD>)` and the summary as a list. Then apply the agreed changes with `update_variant` and show the new checks. Offline, append the same section to the campaign note yourself.
