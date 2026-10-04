# X setup

Social Planner supports X through the **assisted flow** in this release. You can add an OAuth 2 user access token and test it, which confirms which X account it belongs to. Automatic posting stays off because the plugin cannot yet confirm that the token has write and media permissions, or that your X API tier allows posting.

Status in this release: posting, media upload with alt text, and safe thread recovery are implemented and tested against recorded responses. They have **not been verified** against a live X app and stay disabled.

## Register an app

1. Sign in to the [X developer portal](https://developer.x.com/) and create a project and app.
2. Under **User authentication settings**, enable **OAuth 2.0**, type **Native App** (a public client: no client secret).
3. Add a callback URL. X requires the authorization redirect to match a registered callback exactly; whether X accepts a local `http://127.0.0.1:<port>/callback` with a changing port is unverified.
4. Note that posting through the API depends on your access tier. Check X's current tier limits before relying on it.

Never paste a client secret, API key secret or bearer token for the app into Obsidian.

## Scopes and permissions

The user access token should carry:

- `users.read` and `tweet.read`: identify the account (this is what **Test connection** uses);
- `tweet.write`: create posts and threads;
- `media.write`: upload images;
- `offline.access`: get a refresh token (X access tokens last two hours by default).

The plugin can only verify the identity part today. It shows **identity only; write tier unverified** next to the channel.

## Choose the account

1. Open **Settings → Social Planner → Channels → Add channel** and pick **X**.
2. Set **X username (without @)**.
3. Optionally add the OAuth 2 user access token under **Credential (stored only on this device)** and click **Test connection** to confirm the account.
4. **Publishing** offers **Assisted (remind + open)** only.

## Limitations

- Automatic posting is unavailable until `tweet.write`/`media.write` and API-tier access can be verified.
- No desktop OAuth login in this release: callback registration on X is unverified.
- When API posting is enabled, a thread that is interrupted resumes only from the exact, re-checked IDs of parts X confirmed. An ambiguous create stays **Check needed** for you to reconcile.

## Test the connection

**Test connection** shows **Connected:** with the account name, and says that write/media scopes and API tier are not verified. A revoked or expired token shows a readable error with the token redacted.

Credential health then shows **Verified · expiry unknown** or **Needs attention · connection test failed**. Access tokens are short-lived, so expect to test again after replacing one. Renewing tokens from Obsidian is not supported yet.

## Assisted fallback

This is how X posts go out today. **Open & post** opens X's compose page with the text filled in where X allows it, and copies it to your clipboard. For a thread, the flow lists **Copy reply 2**, **Copy reply 3** and so on, so you can post the first part and reply to it with the rest. Paste the live link back to mark the post published.

## Where the credential is stored

The access token (and a refresh token, if you add one later) is stored in Obsidian's per-device secret storage only. It never enters synced settings, notes, `Social/_log.md` or Notices.
