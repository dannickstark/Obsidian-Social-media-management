# Getting started: your first assisted post in 10 minutes

This guide takes you from a fresh install to a post that is live on a platform and marked as published in your vault. It uses Bluesky as the example; every other platform works the same way.

## 1. Add a channel (1 minute)

A channel is one place you post to: a profile, a page, a group, a server channel or a website.

1. Open **Settings → Social Planner (OSMM)**.
2. Under **Channels**, click **Add channel**.
3. Pick **Bluesky**, name it (for example `@you.bsky.social`), leave **Publishing** on **Assisted (remind + open)**, and save.

Tip: for Mastodon, set the handle to `@you@your.instance` so the right server opens. For a Reddit channel, set the handle to the subreddit (`r/SideProject`). For WordPress, set it to the site's domain.

## 2. Write a post (2 minutes)

1. Run the command **New post** (or click the calendar icon in the ribbon and use the planner).
2. Give it a title, pick **Bluesky** and your channel, and create it. The new note opens.
3. Write the text under the frontmatter. On X, Bluesky and Mastodon, a line with only `---` starts the next post of a thread.

## 3. Check it in the composer (2 minutes)

1. Run **Open composer for this post**. The composer opens next to the note.
2. The preview follows what you type. The **Checks** panel counts characters the way Bluesky does (300) and lists anything that would block the post.
3. Drop an image on **Media** if you want one, and give it alt text.

## 4. Schedule it (1 minute)

1. In **Schedule**, pick a date and a time a few minutes from now.
2. Keep the reminder chips (60 and 10 minutes before) or change them.
3. Click **Schedule**. The post appears in the planner and in **Up next · today** in the queue sidebar (**Open social queue (sidebar)**).

## 5. Post it when the reminder comes (3 minutes)

1. When it is time, a notice appears: **Time to post** with **Open & post**. (If Obsidian is in the background, you also get a system notification.)
2. **Open & post** opens the assisted flow:
   - **Check**: the preview one last time.
   - **Open and paste**: **Open Bluesky** opens the compose page with your text already in it, and puts the text on your clipboard too. Post it there.
   - **Confirm**: copy the link of the live post, paste it into **Link to the live post**, and click **Mark published**.
3. The post turns to **Published** everywhere in the planner.

You can start the same flow at any time with **Copy & open** in the composer, or **Post now** in the Overdue tray.

## 6. Choose the publisher device (1 minute)

Until one device is chosen, scheduled posts are neither posted nor marked overdue, and a notice says so at start-up. Only one device should post, even when your vault syncs to several. First update the plugin on every device (a device on an older version keeps posting on its own). Then open **Settings → Social Planner → This device**, give the device a name (for example "Studio iMac") and click **Make this device the publisher**. Your other devices show "Publishing happens on Studio iMac" and only show the plan and their own desktop reminders.

To move the role, click **Publish from this device instead** in the banner on the other device and confirm. The first device stops as soon as the change reaches it through sync. Until the first device shows the change, don't edit the plugin settings there: it could write the old choice back through sync.

Phone reminders are set up per device and only the publisher books them. When you move the role, set up phone reminders on the new publisher (a notice reminds you if they are off there): otherwise they stop. Pushes the old publisher already booked still arrive until it is opened again and learns, through sync, that it no longer publishes; until then you may get some reminders twice.

## 7. Get reminders on your phone (2 minutes, optional)

On the publisher device, open **Settings → Social Planner → Phone reminders (ntfy)** and turn on **Phone reminders on this device**. A long random topic is created for you.

1. Install **ntfy** from the App Store or Google Play.
2. In the app, tap **+** and enter the topic shown in the settings (**Copy** puts it on the clipboard).
3. Click **Send test**. The test push should arrive within a few seconds.

From now on, each reminder arrives on the phone at its time, even when the computer is asleep. Tap the push to open the platform's compose page with the text filled in; **Copy & open** opens the post in Obsidian on the phone with the text ready to paste; **Open note** opens the note; **Snooze 10 min** brings it back later (with an access token the third button is **Done**, which opens the step where you paste the live link). Reminders are booked up to 72 hours ahead, so open Obsidian on the publisher device at least every couple of days. If you edit or move a post, its booked pushes are replaced; on a server that can't cancel pushes, tapping goes through Obsidian so you always get the current text.

The pushes carry the post's title and, in the tap link, its text; the buttons that open Obsidian also carry the vault name and the note's path. On the public ntfy.sh server anyone who knows the topic can read them. Keep the random topic private, or run your own ntfy server with an access token (use https: over plain http the token travels unencrypted, and the settings warn you).

## 8. Plan a campaign with Claude Code (5 minutes, optional)

On a desktop:

1. Open **Settings → Social Planner → Claude Code** and turn on **MCP server on this device**. It listens on this computer only and uses a secret token.
2. Click **Copy setup command**, paste it into a terminal and run it. Then click **Test connection**: "The server answers" means Claude Code can connect. The command contains the token in the clear; running it stores that token in Claude Code's own configuration, and possibly your shell history, so don't share it. The command has the form `claude mcp add --transport http --scope user osmm http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`. After **New token** or a port change, set it up again in two steps: first run `claude mcp remove --scope user osmm`, then copy and run the new setup command.
3. Install the skill in Claude Code: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management`, then `claude plugin install osmm@osmm-social-planner`.
4. Optional but worth it: run **Create voice profile** and describe how you write; add two or three posts you like.
5. In Claude Code, type `/osmm:social` and what you want, for example "plan Event X for LinkedIn, X and Bluesky, the event is on the 12th". Claude proposes a plan, drafts each post, checks it and schedules it once you agree. Each change shows a notice in Obsidian with **Open**.

Claude never publishes by itself. If you ask it to post now or edit a live post, Obsidian shows what, where and when, with **Approve** and **Deny**; no answer within two minutes means no. Under **Publishing from Claude** you can let a channel skip that question for posting now; editing a live post always asks, and a post Claude schedules goes out at its time without a second question.

If Obsidian is closed, run Claude Code inside your vault folder: the skill writes the notes directly, and the next time Obsidian opens they wait under **Written by Claude** in the sidebar until you click **Approve & schedule** (or **Keep as draft**). They are not posted or reminded about before that.

## 9. Post automatically (5 minutes per platform, optional)

On the publisher device, open **Settings → Social Planner → Channels**, edit a channel, set **Publishing** to **API (auto-post)** and add its credential:

- **Telegram:** a bot token from @BotFather. Add the bot to your channel as an admin that can post, post something in the channel, then click **Find chat id** and **Use** it.
- **Discord:** the channel's webhook URL (Server settings → Integrations → Webhooks). Optionally set a name and avatar to post as.
- **Mastodon:** an access token with read and write scopes. Your `@you@your.instance` handle tells the plugin which server to use.
- **Bluesky:** an app password and your handle.
- **X:** an OAuth 2 user access token with `tweet.write` and `media.write`; API access depends on your app's current tier and approval.
- **WordPress:** an HTTPS site address, your user name and an application password.

Click **Test connection**. Scheduled posts on these channels now go out by themselves while the publisher device runs Obsidian.

For Mastodon and WordPress, choose **API with native scheduling** instead: a scheduled post is handed over to the platform (at least 7 minutes ahead on Mastodon, 3 on WordPress) and goes out even when Obsidian is closed. If you edit or move it afterwards, it shows **Out of sync**: the platform keeps the old version until you click **Push update** in the composer or row menu. **Revert time** takes the platform's time back, and **Unschedule on …** takes it off the platform's schedule. A Mastodon thread is never handed over; it posts from Obsidian at its time.

## When something goes wrong

- **The post's time passed while Obsidian was closed.** It is not posted late behind your back: it waits in the **Overdue** tray with **Post now**, **Reschedule** and **Skip**. (Settings → Publishing → **Post late items automatically** lets short delays go out anyway; it is off by default.)
- **A link is refused.** The link must be the post's page on that platform, starting with `https://`.
- **Needs attention.** Failed deliveries and ones that need a check are listed in the queue sidebar with the next step to take.
- **Check needed after a dropped connection.** The post may or may not have gone out, so it is not sent again automatically. Where the platform can tell (Mastodon, Bluesky, WordPress, and sometimes X from the account timeline), the plugin asks it and settles the post; otherwise look on the platform and mark it as published or not.
- **Not handed over.** The platform refused the hand-over (a wrong token or a time too close). The post stays scheduled and goes out from Obsidian at its time, as long as the publisher device is on.
- **Out of sync.** You changed a post after it was handed over. Nothing is sent until you click **Push update**.
- **Wrong day?** Drag the post in the planner, or right click it (long press on a phone) and pick **Reschedule…**. Every move can be undone from the notice.
