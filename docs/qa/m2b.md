# M2b manual QA — assisted publishing, scheduler, reminders

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+, enable the plugin.
Run in the default dark and light themes. Also run `docs/qa/assisted-urls.md`.

## Assisted flow (mockup 6)
- [ ] Composer → Copy & open on Event X – LinkedIn walks Acme Studio, then Maker Lab (stagger order); "1 of 2", "2 of 2".
- [ ] Step 2 opens the page in the browser and the text is on the clipboard (paste it into any text field to check).
- [ ] X thread: "Copy reply 2" and "Copy reply 3" copy the next parts.
- [ ] Instagram: the image can be copied (desktop) or is revealed in the file manager; on a phone the share sheet opens.
- [ ] Step 3 refuses a link to another platform with a clear message; a correct link marks the channel published and the calendar chip turns published at once.
- [ ] Closing the modal after "Open" leaves the channel "Waiting for you".
- [ ] "Skip this channel" with a reason writes `reason` in the note.

## Scheduler and reliability (spec §5)
- [ ] Schedule a Bluesky post 2 minutes ahead: at its time a "Time to post" notice appears and the delivery is "Waiting for you"; it does not fire again on later ticks.
- [ ] Schedule a post 2 minutes ahead, quit Obsidian, wait 10 minutes, reopen: the post is in the Overdue tray (not posted), and the startup banner says so with "Review".
- [ ] Settings → Publishing → turn on "Post late items automatically" (15 min) and repeat with a 5-minute gap: the post runs at startup.
- [ ] Edit a note so a delivery reads `status: publishing`, restart Obsidian: it becomes "Check needed" in Needs attention, and is never retried; "It went out" asks for the link; "It didn't" marks it failed.
- [ ] Edit a delivery to `status: Handed-Over` (typo) on a post due in 2 minutes: nothing is posted, a notice explains which channel to fix, and the composer shows a blocking check. Dragging the post on the board to Scheduled leaves the typo untouched.
- [ ] Put the laptop to sleep across a post's time: on wake it goes to the Overdue tray.

## Reminders (spec §4.4)
- [ ] With a post 61 minutes ahead, the 60-minute reminder appears within a minute, once; after restarting Obsidian it does not repeat.
- [ ] "Snooze 10 min" brings it back 10 minutes later; "Open & post" opens the assisted flow.
- [ ] With Obsidian in the background, a system notification appears; clicking it opens the assisted flow.
- [ ] Settings → "Desktop notifications on this device" off: no reminders on this device.

## Overdue tray and Needs attention (mockup 1)
- [ ] Post now on the overdue Instagram item opens the assisted flow; Reschedule offers in 1 hour / tomorrow / pick a date; Skip removes it; the count updates at once.
- [ ] The failed Telegram post shows its error, "Post again" and "Fix" (opens the composer).

## Keyboard and phone (#113)
- [ ] Tab to a calendar chip, press Shift+F10 (or the Menu key): the menu offers Reschedule…, Move to …, Skip, Post now, Compose.
- [ ] On a phone, a long press on a chip or a board card opens the same menu and does not open the note.
- [ ] List view: "Actions for …" opens the menu; every move can be undone from its notice.
- [ ] Dropping a chip on a past time asks before moving it.

## Docs (#109)
- [ ] Capture `docs/images/planner.png` (month view with the Overdue tray open), `docs/images/composer.png` (composer on Event X – LinkedIn, preview and checks visible) and `docs/images/assisted.png` (assisted flow on step 2), dark theme, 1600×1000 window; then un-comment the three image lines in README.md.
- [ ] README renders on GitHub with the three screenshots; the getting-started guide takes a new user to a published assisted post in under 10 minutes.
