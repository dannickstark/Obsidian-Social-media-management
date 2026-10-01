# M6 Task 7 implementation report

Status: DONE_WITH_CONCERNS

## Delivered

- Added a LinkedIn adapter for member posts and approved organization posts. Text posts use LinkedIn Posts API; image posts upload image assets first and support one image or an organic multi-image post with up to nine images. Image uploads stay on LinkedIn's `www.linkedin.com/dms-uploads` host, and image alt text is retained.
- Added typed member and organization account discovery. Organization choices are limited to approved publishing roles and report `w_organization_social` separately from product access. Organization publish is refused unless Community Management access, required scope, and an approved member role are all confirmed.
- Added `apiAvailable` runtime gating so unverified LinkedIn channels resolve to assisted mode. The settings form can discover/select accounts, test a connection, and explain the PKCE and product-access limitations. A changed token clears the previous LinkedIn selection.
- Added LinkedIn to the shared adapter contract suite and the release QA smoke checklist.

No OAuth authorization flow or token health work was added. LinkedIn native PKCE and product access remain unverified under ADR 0003; API publishing is disabled by default. Discovery uses a user-supplied device token, and only explicitly supplied scope/access confirmations can unlock API use.

## TDD and verification

- Wrote account discovery and adapter tests first. The initial Node-mode run failed because the LinkedIn adapter/account modules did not yet exist. The multi-image test was also run red against the initial one-image implementation, then passed after adding the Posts API multi-image path.
- Focused LinkedIn adapter, accounts, and settings tests passed under Node 24: 3 files, 34 tests.
- LinkedIn adapter contract, platform registry, and M5 QA documentation tests passed: 3 files, 150 tests passed, 11 skipped.
- `npm run lint` passed. `npm run typecheck` passed with 0 errors and 1 existing Svelte warning. `git diff --check` passed.
- The full suite under Node 24 with loopback access passed 1,909 tests and skipped 12; one existing X-path test failed in `test/publish/overdueTray.test.ts` because the index did not reach its expected state within 2 seconds. The suite's only failure was outside LinkedIn files and no linked-in-specific or adapter-contract test failed.
- The system `npm` selects Node 20.18, which cannot load the installed ESM dependency used by jsdom; Node 24 was used for Vitest runs. Without loopback access, OAuth and local-server tests also fail with `EPERM` when binding `127.0.0.1`.

## Provider references and limits

- LinkedIn documents member posting via `w_member_social` and `POST /rest/posts`: [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) and [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-03).
- Organization posts require `w_organization_social` and approved roles; multi-image posts use the Posts API after uploading each image: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-03), [MultiImage API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-04), and [Organization Access Control](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-08).
- Tests use scripted HTTP responses. No live LinkedIn app, scope grant, provider callback, or publishing request was exercised.
