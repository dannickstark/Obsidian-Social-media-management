# Assisted URLs — manual verification

Run before each release, logged in to a test account on each platform. For each row, run
"Copy & open" from the composer on a seeded post and check what the page shows.

| Platform | Page that opens | Pre-filled | Check |
|---|---|---|---|
| LinkedIn profile | feed with the share box open | text | [ ] text appears, newlines kept |
| LinkedIn page (handle = company URL) | page admin, new post | nothing (paste) | [ ] page identity is selected |
| X | intent/post | first thread item | [ ] `#` and `&` survive; emoji intact |
| Bluesky | intent/compose | first thread item | [ ] text appears |
| Mastodon (handle `@you@instance`) | `<instance>/share` | first thread item | [ ] right instance, text appears |
| Instagram | instagram.com (desktop) / app camera (phone) | nothing | [ ] caption on the clipboard, image can be saved |
| Facebook | sharer (with url) or the page | link only | [ ] text is on the clipboard |
| Telegram | t.me/share | text (and link) | [ ] channel picker shows the channel |
| WhatsApp | wa.me | text | [ ] group picker; *bold* renders |
| Discord (handle = channel URL) | the channel | nothing | [ ] message on the clipboard |
| Hacker News | submitlink (url) or submit | title and url | [ ] both fields filled |
| Reddit (handle `r/<sub>`) | subreddit submit | title and url or text | [ ] fields filled in the new Reddit UI |
| Indie Hackers | new-post | nothing | [ ] URL still opens the editor (update `indiehackers/assisted.ts` if not) |
| WordPress (handle = domain) | wp-admin/post-new.php | nothing | [ ] pasted Markdown converts to blocks |
