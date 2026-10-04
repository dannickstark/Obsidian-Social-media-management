# M6 smoke checklist: OAuth platforms, generated images and token health

Run on test accounts before each release, after the [M5 smoke checklist](m5-smoke.md), with a production build in a test vault on the publisher desktop, a phone, and a second desktop as a non-publisher. Use provider **test apps** only. Record each result; when an item fails, add a failing automated test in the owning module before fixing it. Items marked **(Provider)** depend on app registration or review that this release has not verified: record the outcome, or "deferred: not verified", and keep the API path gated if it fails.

## OAuth and credentials

- [ ] Facebook, Instagram, X and LinkedIn credentials are added under **Credential (stored only on this device)**; `data.json`, `localStorage`, notes, `Social/_log.md`, Notices and the developer console contain no token, refresh token, app secret or authorization code.
- [ ] A channel saved on the publisher shows the credential summary (for example **user token · Page discovery**) on the other devices, and those devices never send.
- [ ] Replacing a credential clears the previous account selection (Facebook Page, LinkedIn account) and its credential health.
- [ ] **(Provider)** Register a loopback redirect (`http://127.0.0.1:<port>/callback`, or `/redirect` for LinkedIn) on each test app and record whether the provider accepts it with a changing port. A wrong state, a foreign Host, a reused code or a callback after the timeout never exchanges a token (pinned by `test/auth/oauth.test.ts`).
- [ ] **(Provider)** Record each provider's token lifetime and refresh behaviour from the test app. Do not enable a refresh flow that has not been exercised.

## API and assisted modes

- [ ] Facebook: **Find Facebook Pages** lists only Pages; **Use** fills the Page id; **API (auto-post)** posts text, a link, and one and ten images to the Page. **(Provider)** run against a Meta test app.
- [ ] Facebook: a profile or group channel offers only **Assisted (remind + open)**.
- [ ] Instagram: the form explains that a public image host is required and offers only assisted publishing; **Open & post** copies the caption and each image.
- [ ] X: **Test connection** names the account and says write/media scopes and API tier are not verified; only assisted publishing is offered; a thread lists one copy button per reply.
- [ ] LinkedIn: **Find LinkedIn accounts** lists the profile and only Pages with an approved posting role; with unconfirmed grants the channel stays assisted and shows **exact-token grants required**. **(Provider)** with confirmed `w_member_social`, post text, one image and a 2–9 image post; with `w_organization_social` and Community Management access, post as a Page.
- [ ] For every platform, removing the credential on the publisher makes a due post fall back to assisted (or a needs-user failure for API-only paths) without posting.
- [ ] An unanswered create on Facebook, X or LinkedIn becomes **Check needed**, logs one attempt, and is never retried automatically. **(QA)** throttle the network mid-request.

## Meta image hosting

- [ ] With no host configured, Instagram API publishing is not selectable or dispatchable, and nothing about the vault (paths, file names under `.obsidian`, user folders) is sent to Meta or any host.
- [ ] A host URL with credentials, a query string, a fragment, a private address or a local/vault-looking path is refused (pinned by `test/platforms/instagram/media.test.ts`).
- [ ] **(Provider)** If a reviewed public host is configured for testing, a single image and an ordered carousel publish after container processing, and an expired host URL fails visibly.

## Facebook native scheduling

- [ ] A Page post scheduled at least 12 minutes ahead with **API with native scheduling** is handed over within one tick and appears in Meta Business Suite's scheduled posts. **(Provider)**
- [ ] With Obsidian closed, Facebook publishes it on time; reopening settles it to **Published** with the live link.
- [ ] Editing or moving it shows **Out of sync**; **Push update** changes the remote text and time, **Revert time** restores Facebook's time, and **Unschedule on Facebook** removes it and makes the local channel a draft. All three are refused inside the 12-minute lead.
- [ ] A Graph "object not found" answer during lookup leaves the post **Check needed**, never **Published** or removed.

## Generated images

- [ ] **Settings → Image generation → OpenAI API key** stores the key on this device only; the field never shows the saved key; **Remove key** removes it.
- [ ] In the composer, **Media → Generate image** produces a preview with the chosen size, crop ratio and focal point; **Cancel** leaves no file; **Use image** saves the original and the crop and adds a `media:` entry with `media_meta:` provenance.
- [ ] Claude's `generate_image` tool with a post path attaches the image to that post; without a path it returns an unattached vault image. It never schedules or publishes.
- [ ] Generating for a post that moves inside its 10-minute window during the request is refused and leaves no generated files.
- [ ] Changing the focal point, crop or generated file after approval changes the approval digest, so the post asks again before an approved send.
- [ ] Without a key, generation shows a clear message and no request is made.

## Token health

- [ ] After **Test connection**, the channel list and form show **Verified · expiry unknown** (no shipped adapter reports an expiry yet) or **Needs attention · connection test failed**.
- [ ] A channel without a credential on this device shows **Disconnected on this device**; one never tested shows **Connection not tested**.
- [ ] With desktop notifications on, a failed test produces one reminder at the next scan (start-up or hourly), and none after a restart; a new failure after a successful test reminds again. With notifications off, there are none.
- [ ] The `credentialHealth` entry in `localStorage` (`osmm-device`) has only `status`, `expiresAt` and `notifiedKey`; removing a channel removes its entry.

## Community-plugin submission

Complete before opening the pull request to `obsidianmd/obsidian-releases`:

- [ ] `manifest.json` has the final `id` (no "obsidian"), `name`, `version`, `minAppVersion` 1.11.4, `description` (under 250 characters, no "Obsidian"), `author`, `authorUrl` and `isDesktopOnly: false`; `versions.json` maps the version to 1.11.4.
- [ ] A `LICENSE` file is in the repository root and matches `package.json` (MIT). **Missing at the time of writing.**
- [ ] The GitHub release tag equals `manifest.json`'s version and attaches `main.js`, `manifest.json` and `styles.css`.
- [ ] README states what the plugin sends over the network and to whom (platform APIs, ntfy, OpenAI, link-card fetches), that there is no server in between, and that credentials stay in per-device secret storage.
- [ ] Obsidian's plugin guidelines pass: no `innerHTML` with user content, no default hotkeys, no `console.log` noise in production, settings headings via `setHeading`, the `Vault`/`FileManager` APIs for file changes, and network requests through `requestUrl` except the documented OAuth token exchange (ADR 0003).
- [ ] Mobile load test: the plugin enables on iOS and Android without loading desktop-only modules (MCP server, OAuth listener).
- [ ] Every **(Provider)** item above is either passed or listed as deferred in the release notes, with its API path still gated.
