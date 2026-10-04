# Instagram setup

Social Planner supports Instagram **professional** accounts (Business or Creator) linked to a Facebook Page. In this release Instagram uses the **assisted flow**: the API adapter is built and tested, but it stays switched off until a public image host is set up (see [Limitations](#limitations)).

Status in this release: image and carousel publishing through the Instagram Graph API is implemented and tested against recorded responses. It has **not been verified** with a reviewed Meta app, and it is not selectable in the channel form yet.

## Register an app

Instagram publishing goes through a Meta app with Facebook Login, the same as [Facebook Pages](facebook.md):

1. Create a **Business** app at [Meta for Developers](https://developers.facebook.com/apps/).
2. Add **Facebook Login for Business** and **Instagram Graph API**.
3. Switch your Instagram account to a professional account and link it to a Facebook Page you manage (Instagram app → **Settings → Account type and tools**).

Never paste the app secret into Obsidian.

## Scopes and permissions

The Meta user access token needs:

- `pages_show_list` and `pages_read_engagement`: find the Page the Instagram account is linked to;
- `instagram_basic`: read the professional account;
- `instagram_content_publish`: create and publish media.

Your role on the linked Page must include the `CREATE_CONTENT` task. The plugin confirms both the `instagram_content_publish` grant and the `CREATE_CONTENT` task before it will publish; without either it refuses and points you to assisted publishing.

## Choose the account

1. Open **Settings → Social Planner → Channels → Add channel** and pick **Instagram**.
2. Set the handle to your Instagram user name so **Open & post** opens the right profile.
3. Leave **Publishing** on **Assisted (remind + open)**. The API options do not appear while no public image host is configured; the form says so.

When API publishing is enabled in a later release, account selection uses the same Meta user token: the plugin lists only professional accounts linked to Pages you manage and then posts with that Page's token, never the user token.

## Limitations

- **A public image host is required.** Instagram fetches images from a public HTTPS URL; it cannot receive an upload from your device. Social Planner has no server, and it will not publish your vault files or paths on the internet. Until a reviewed host can be configured, API publishing stays off. The host check refuses URLs with credentials, query strings, private addresses or anything that looks like a local or vault path.
- Images and carousels only (up to ten). No video, Reels or Stories.
- No native scheduling.
- An unanswered publish becomes **Check needed** and is never retried automatically.
- Meta app review and a desktop OAuth login are unverified.

## Test the connection

**Test connection** is not shown for Instagram in this release, because the API method cannot be selected. The channel list shows **credential set · public image host required** when a credential is stored, and credential health shows **Connection not tested**.

## Assisted fallback

This is the way to post to Instagram today. When the reminder comes, **Open & post** puts the caption on your clipboard, and the flow has a **Copy image 1**, **Copy image 2** … button for each image; post from the Instagram app or website and paste the live link back to mark the post published.

## Where the credential is stored

If you add a Meta user token for later use, it is stored in Obsidian's per-device secret storage only. It is never written to synced settings, notes, the publish log or Notices, and it is never sent to an image host.
