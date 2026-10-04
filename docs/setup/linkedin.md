# LinkedIn setup

Social Planner supports your LinkedIn **profile** and **Company Pages**. In this release both use the **assisted flow** by default. API publishing is built and tested, but it turns on only when the plugin can confirm the exact grants of the token you added, and normal installs have no way to confirm them yet.

Status in this release: account discovery, text posts, single-image and multi-image posts (2–9 images, with alt text) are implemented and tested against recorded responses. Native PKCE login and LinkedIn product access have **not been verified**.

## Register an app

1. Create an app at [LinkedIn Developers](https://www.linkedin.com/developers/apps) and associate it with a Company Page.
2. Request these products for the app:
   - **Sign In with LinkedIn using OpenID Connect**: needed to identify your account;
   - **Share on LinkedIn**: needed to post as yourself;
   - **Community Management API**: needed only to post as a Company Page (requires LinkedIn's approval).
3. A desktop login without a client secret uses LinkedIn's native-client PKCE flow, which LinkedIn must enable for your app on request. Without it, standard OAuth needs a client secret, which must never go into a plugin.

## Scopes and permissions

- `openid` and `profile` (Sign In with LinkedIn): find your member identity;
- `w_member_social` (Share on LinkedIn): post on your profile;
- `w_organization_social` (Community Management): post as a Company Page. You also need an approved posting role on that Page (for example administrator or content admin).

These grants belong to the specific token. If you replace the token, the plugin forgets the previous selection and checks again.

## Choose the account

1. Open **Settings → Social Planner → Channels → Add channel** and pick **LinkedIn**.
2. Add the access token under **Credential (stored only on this device)**.
3. Click **Find LinkedIn accounts**. You get **Use … (Profile)** and, for Pages where you have an approved role, **Use … (Company Page)**.
4. Pick one. The **Publishing** list offers the API option only when the token's scopes and product access are confirmed; otherwise it stays on **Assisted (remind + open)**.

## Limitations

- API publishing stays off until the token's product and scope grants can be confirmed (shown as **exact-token grants required** in the channel list).
- Company Pages need Community Management access and `w_organization_social`; without them a Page channel stays assisted.
- No native scheduling on LinkedIn.
- Rate limits wait for LinkedIn's `Retry-After`. An unanswered create becomes **Check needed** and is never retried automatically.
- LinkedIn access tokens have to be renewed by signing in again; refresh tokens are not assumed.

## Test the connection

**Test connection** shows **Connected:** with the member or Page name, or a readable error with the token redacted. Credential health then shows **Verified · expiry unknown** or **Needs attention · connection test failed**, with one desktop reminder when it needs attention.

## Assisted fallback

**Open & post** opens LinkedIn's share page and copies the text; post it and paste the live link back to mark the post published. Assisted publishing stays available for every LinkedIn channel, whatever the API status.

## Where the credential is stored

The access token is stored in Obsidian's per-device secret storage only. Synced settings keep only the selected account and a reference to the local credential. Nothing secret is written to notes, `Social/_log.md` or Notices.
