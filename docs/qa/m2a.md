# M2a manual QA — platforms, previews, composer

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+, enable the plugin.
Run every check in the default dark and light themes and one community theme (e.g. Minimal).

## Composer (mockup 3)
- [ ] "Open composer for this post" on a variant opens the composer in a split next to the note; on a campaign or plain note the command is not offered.
- [ ] Typing in the editor updates the preview almost at once (well under a second); switching notes never shows the previous note's text.
- [ ] Platform tabs list the campaign's variants; clicking one opens that note in the editor pane, not in the composer pane.
- [ ] Mobile / Desktop toggle changes the preview width; "Preview as" switches the channel name and avatar colour.
- [ ] Post as: toggling a channel writes `channels:`; toggling off the published "Me" channel on Event X – LinkedIn is refused with a notice; "Add group: All LinkedIn pages" adds the pages; Undo works.
- [ ] Checks: counters update while typing; a LinkedIn text over 3 000 characters shows Blocking and disables Schedule; a link in the text shows an Advisory.
- [ ] Quick fixes: an HN variant without url in Event X offers "Use the campaign link"; a WordPress post without slug offers `Use slug "…"`, with Undo.
- [ ] Schedule: date/time, reminder chips (add/remove), Mode; Schedule writes `scheduled_at`, `reminders` and deliveries in one change (check the note); a past time asks first; Update schedule on Event X – LinkedIn leaves the published "Me" delivery untouched.
- [ ] Fork for this page… on Event X – LinkedIn creates "Event X – LinkedIn – Acme Studio" and offers "Open in composer".
- [ ] Media: drop a PNG, a JPG, a WebP and a GIF from the desktop; each lands next to the note and in `media:`; an MP4 is attached and flagged "video isn't supported yet"; a PDF is refused.
- [ ] Media: alt text persists in `media_meta`; clicking the thumbnail moves the crop box (X: 16:9, Instagram: 4:5 to 1.91:1) and the focal point persists; arrow keys nudge it; move up/down/remove work and Remove can be undone.
- [ ] Pressing Enter/Space on the focal-point button does not move the focal point; arrow keys do.

## Previews (mockups 3 and 5)
- [ ] Every platform renders: LinkedIn fold with "…see more", X/Bluesky/Mastodon threads numbered, Instagram image first, Facebook link card, Telegram channel post with bold heading, Discord message, WhatsApp bubble with *bold*, HN title + (domain), Reddit subreddit, Indie Hackers title, WordPress article with featured image and headings.
- [ ] Previews look like stylized approximations in both themes (no broken contrast, no platform logos).
- [ ] "Preview all" in the `social-variants` table and "Preview all variants of this campaign" open the grid; 12+ variants wrap without horizontal scrolling; blocking/advisory counts are right.
- [ ] "Approve all ready" schedules the ready variants that have a future time and no blocking issue, and Undo restores them.

## Platform numbers marked approximate in code
Check each against the platform's current documentation and note differences in the PR:
- [ ] LinkedIn: image count (9) and size (8 MB).
- [ ] X: image size (5 MB), timeline crop (16:9).
- [ ] Instagram: fold (125), carousel (10), size (8 MB).
- [ ] Facebook: fold (480), images (10), size (10 MB).
- [ ] Mastodon: image size (8 MB default instance), crop (16:9).
- [ ] Bluesky: image size (about 1 MB).
- [ ] Telegram: album (10), photo size (10 MB). Discord: attachments (10), size (10 MB).
- [ ] WhatsApp: message length (65 536), media. HN: text length (4 000). Indie Hackers: title (150), text, image size. Reddit: self-text (40 000), gallery (20), size (20 MB). WordPress: upload size (20 MB).

## Carried
- [ ] Very large attachments (e.g. a 50 MB image) are flagged by checks rather than silently accepted.
