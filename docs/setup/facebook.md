# Facebook Pages setup

Social Planner can post to a Facebook **Page** you manage, either at the scheduled time from the publisher device (**API (auto-post)**) or by handing the post over to Facebook's own scheduler (**API with native scheduling**). Personal profiles and groups always use the assisted flow.

Status in this release: Page discovery, publishing and native scheduling are implemented and tested against recorded Graph API responses. A connection through a reviewed Meta app has **not been verified** yet, and there is no "Connect with Facebook" button: you paste a user access token yourself.

## Register an app

1. Go to [Meta for Developers](https://developers.facebook.com/apps/) and create an app of type **Business** (or use an existing one).
2. Add the **Facebook Login for Business** product. You do not need to configure a redirect URI for the manual-token path below.
3. While the app is in development mode, only people with a role on the app (admin, developer, tester) can grant it permissions. That is enough for your own Pages. Publishing for other people requires Meta's app review.

Never paste the app secret into Obsidian. The plugin does not need it and cannot protect it.

## Scopes and permissions

The user access token must carry:

- `pages_show_list`: list the Pages you manage;
- `pages_read_engagement`: read Page details and posts (used to confirm a post landed);
- `pages_manage_posts`: create, update, schedule and delete Page posts.

To get one, open the [Graph API Explorer](https://developers.facebook.com/tools/explorer/), pick your app, add the three permissions, click **Generate Access Token** and approve the Pages you want to use. A short-lived token works for a quick test. For daily use, exchange it for a long-lived user token as described in Meta's [access-token guide](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/).

You also need a Page role that allows posting (the `CREATE_CONTENT` task). The plugin checks this and refuses Pages where you lack it.

## Choose the account

1. On the publisher device, open **Settings → Social Planner → Channels → Add channel** and pick **Facebook**.
2. Under **Credential (stored only on this device)**, add the user access token.
3. Click **Find Facebook Pages**. The plugin asks Facebook for the Pages the token can see and shows **Use …** for each.
4. Click **Use** next to the right Page. This fills **Page id**. Only the Page id and a reference to the local credential are saved in the synced settings.
5. Set **Publishing** to **API (auto-post)** or **API with native scheduling** and save.

The Page access token Facebook returns is kept in memory for the session and never written to settings or notes.

## Limitations

- Pages only. Profiles and groups use assisted publishing.
- Text, link-only and image posts (up to ten images). No video or Reels.
- Native scheduling needs the post at least 12 minutes ahead. A Page post handed over to Facebook can be updated, moved or unscheduled from Obsidian (**Push update**, **Revert time**, **Unschedule on Facebook**).
- If Facebook does not answer a create request, the post becomes **Check needed** and is not sent again automatically. A Graph "object not found" answer is not treated as proof that a post was deleted.
- Meta app review and a desktop OAuth login are unverified. Long-lived user tokens expire after about 60 days; you will need to paste a new one.

## Test the connection

Click **Test connection** in the channel form. A success shows **Connected:** with the Page name. A missing permission, a lost Page role or an expired token shows a readable error with the token redacted.

After a test, the channel shows its credential health in the channel list and the form: **Verified · expiry unknown** (Facebook does not tell the plugin when your token expires), or **Needs attention · connection test failed**. With desktop notifications on, a channel that needs attention gives one reminder, not a repeating one.

## Assisted fallback

Leave **Publishing** on **Assisted (remind + open)** (or switch back at any time). When the reminder comes, **Open & post** puts the text on your clipboard and opens Facebook; you paste the live link back to mark the post published. The plugin also falls back to assisted delivery for a channel whose credential is missing on the publisher device.

## Where the credential is stored

The user access token is stored in Obsidian's per-device secret storage on the device where you added it. It is never written to `data.json`, synced settings, notes, `Social/_log.md` or Notices. Add it on the publisher device; other devices do not need it. To revoke it, remove the app under Facebook **Settings → Business integrations** and remove the credential in the channel form.
