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

## When something goes wrong

- **The post's time passed while Obsidian was closed.** It is not posted late behind your back: it waits in the **Overdue** tray with **Post now**, **Reschedule** and **Skip**. (Settings → Publishing → **Post late items automatically** lets short delays go out anyway; it is off by default.)
- **A link is refused.** The link must be the post's page on that platform, starting with `https://`.
- **Needs attention.** Failed deliveries and ones that need a check are listed in the queue sidebar with the next step to take.
- **Wrong day?** Drag the post in the planner, or right click it (long press on a phone) and pick **Reschedule…**. Every move can be undone from the notice.
