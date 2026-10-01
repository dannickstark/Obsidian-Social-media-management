# M6 Task 6: X adapter

## Status

Implemented and committed as `feat(x): add API publishing with assisted fallback`.

## Implementation

- Added an X API adapter with account-bound OAuth lookup, weighted 280-character validation, t.co URL counting, image upload with alt text, thread replies, and X post URLs.
- Reused the persisted delivery send key in per-part request identifiers. Resumed sends inspect only the authenticated account's timeline, require a unique normalized text/reply-chain match, validate media metadata where available, and refuse ambiguous or edited partial threads. Unknown create outcomes are not automatically retried.
- The channel form keeps X API mode unavailable because the plugin cannot verify OAuth write/media scopes or API-tier access without publishing. Test connection reports identity only; the API adapter requires an explicit `xApiAccessVerified` configuration value before it will publish. Once enabled, API-tier 403 refusals remain visible `NeedsUserError`s and assisted mode remains available.
- Corrected X URL counting so terminal punctuation remains part of the post text, refuses unsupported/excess media rather than dropping it, and propagates thread authorization failures instead of marking the thread published.
- Registered the adapter and added adapter contract coverage, X-specific tests, and X sections in the user and QA guides.

## Verification

- Focused X adapter, weighted-count, shared adapter contract, registry, and adapter smoke documentation tests: 178 passed, 8 skipped. The tests were observed failing first for the reviewed gaps.
- `npm run typecheck`: passed with 0 errors and 1 existing warning in another file.
- `npm run lint`: passed.
- `git diff --check`: passed.
- Full suite under Node 24: 1,818 passed, 9 skipped, 48 failed. Failures are loopback networking tests blocked by sandbox `listen EPERM` errors on `127.0.0.1`.
- The initial red run under the default Node 20 runtime failed before tests loaded because Vitest's jsdom dependency attempted to `require()` an ES module. Focused and full runs were repeated with the available Node 24 runtime.

## Concerns and limitations

- X API app approval and tier eligibility remain unverified; a user-provided OAuth 2 user access token with `tweet.write` and `media.write` is required. The live plugin therefore leaves X on assisted publishing. A future OAuth setup must externally establish the permissions and set `xApiAccessVerified` before API publishing can be enabled in the platform definition.
- X does not provide an exact send-key lookup in the adapter. Recovery uses recent account-timeline text and reply-chain matching, so missing or ambiguous evidence stops for user review. The per-part `Idempotency-Key` is sent as a request identifier, but duplicate protection is not assumed from it.
- Provider credentials and actual image upload behavior were not tested against a live X account.
