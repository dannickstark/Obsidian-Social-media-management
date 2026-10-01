# M5 smoke checklist: automatic posting and native scheduling

Run on test accounts before each release with a production build in a test vault, on one desktop (the publisher), one phone, and a second desktop with the same vault open as a non-publisher. Record each result; when an item fails, add a failing automated test in the owning module before fixing it.

## General

- [ ] Settings → Channels shows platform-specific fields, only supported publishing methods, **Test connection**, and readable errors with credentials redacted.
- [ ] Only the publisher posts or hands over; the non-publisher never sends, and `Social/_log.md` has one attempt per delivery.
- [ ] `data.json`, `localStorage`, `Social/_log.md` and Notices contain no token, webhook URL, app password or Basic-auth value.
- [ ] Removing a publisher credential produces a needs-user “Add … on this device” failure without posting.
- [ ] A dropped connection during Post now becomes **Check needed**, is not retried automatically, and logs one attempt. **(QA)** throttle the network mid-request.
- [ ] An older plugin refuses synced schema-5 settings instead of stripping new channel fields.
- [ ] A phone publisher can post Telegram and Bluesky and show link cards. **(QA)** verify multipart uploads through `requestUrl`.

## Telegram

- [ ] A bot added as a channel admin is found by **Find chat id** after it sees a post; **Use** fills `@name` or `-100…`.
- [ ] Bold, italic, code, links and `< > &` render correctly. **(QA)** verify every generated HTML tag.
- [ ] A short photo caption is one message; over 1,024 visible characters sends the photo first and text second with the delivery linked to the text. **(QA)** check emoji/entity counting.
- [ ] Three photos form one album with the caption on the first photo.
- [ ] Private-channel links open the message; removed admin rights produce a needs-user failure.

## Discord

- [ ] Webhook Test connection names the webhook.
- [ ] `@everyone` in post text does not ping anyone; post-as name/avatar override the webhook.
- [ ] Two images retain their alt descriptions. **(QA)** verify the descriptions in Discord.
- [ ] The delivery link opens the server message; a deleted webhook produces a readable needs-user failure.

## Facebook Pages

- [ ] A user token discovers only Pages, verifies Page publishing permissions, and saves only the selected Page id and local credential reference. **(QA)** verify with a Meta test app.
- [ ] Text, link-only, and up to ten image posts publish to the selected Page; profiles and groups stay on assisted publishing.
- [ ] Native scheduling, time/content updates, startup lookup, and cancellation affect only confirmed Page posts. An unanswered create stays **Check needed**. **(QA)** verify the scheduled post in Meta.

## Mastodon

- [ ] Read/write token and `@you@instance` handle connect successfully.
- [ ] Image alt text and focal-point crop are correct; **(QA)** a large upload that answers 202 settles after processing.
- [ ] Three-part threads reply in order and an interrupted lookup can find a mention containing another instance.
- [ ] Retrying the same post after a forced 5xx does not create a duplicate. **(QA)** verify with the instance.

## Bluesky

- [ ] Handle and app password connect; mentions, links, hashtags, emoji and skin-tone graphemes are exact.
- [ ] Link-only posts have link cards; image posts have alt text and no card.
- [ ] Three-part threads reply in order and link the first post.
- [ ] **(QA)** a self-hosted PDS works through `server`; an interrupted post is found by its persisted TID.
- [ ] **(QA)** Bluesky's 300-grapheme count agrees with the composer for a long URL.

## WordPress

- [ ] HTTPS site, user name and application password connect; HTTP is refused.
- [ ] Headings, callouts, lists, tables, code, body images, media images, featured images, alt text, categories and tags render correctly.
- [ ] **(QA)** record behaviour for sites without pretty permalinks and security plugins that block REST or application passwords.

## Native scheduling

- [ ] On Facebook, Mastodon, and WordPress, a post scheduled at least 12, 7, or 3 minutes ahead is handed over within one tick and is visible in the platform scheduler. **(QA)** verify the remote schedule.
- [ ] With Obsidian closed, the platform publishes on time; reopening settles it to **Published** with the live link, or to **Check needed** after a day with no confirmation.
- [ ] Editing or moving a handed-over post shows **Out of sync** in the composer, calendar chip and campaign table. Nothing changes remotely until **Push update**.
- [ ] **Revert time** restores the platform time; **Push update** moves the remote time and content; both are refused inside the platform lead.
- [ ] **Unschedule on Facebook/Mastodon/WordPress** removes the remote schedule and makes the local channel a draft.
- [ ] A Mastodon thread is not handed over; it posts from Obsidian at its time.
- [ ] Quitting during a hand-over leaves **Check needed**; startup lookup returns it to **Handed over** when the platform has it. **(QA)** throttle the network during the claim.
