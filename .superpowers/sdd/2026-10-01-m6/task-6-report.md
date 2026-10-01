# M6 Task 6: X adapter

## Status

Implemented and committed as `feat(x): add API publishing with assisted fallback`.

## Implementation

- Added an X API adapter with OAuth user-token account lookup and connection verification, weighted 280-character validation, t.co URL counting, image upload with alt text, thread replies, and X post URLs.
- Reused the persisted delivery send key in per-part request identifiers. Resumed sends inspect the authenticated account's recent timeline, match post text and reply links, and refuse ambiguous or edited partial threads. Unknown create outcomes are not automatically retried.
- Classified API-tier 403 refusals as visible `NeedsUserError`s that explicitly preserve assisted publishing. Credential and tier setup are described in the channel form; OAuth app review remains unverified and credentials are injected through existing device secret storage.
- Registered the adapter and added adapter contract coverage, X-specific tests, and X sections in the user and QA guides.

## Verification

- Focused X adapter, shared adapter contract, registry, and adapter smoke documentation tests: 145 passed, 8 skipped.
- `npm run typecheck`: passed with 0 errors and 1 existing warning in another file.
- `npm run lint -- --no-warn-ignored`: passed.
- `git diff --check`: passed.
- Full suite under Node 24: 1,807 passed, 9 skipped, 47 failed. Failures are existing loopback networking tests blocked by sandbox `listen EPERM` errors on `127.0.0.1`.
- The initial red run under the default Node 20 runtime failed before tests loaded because Vitest's jsdom dependency attempted to `require()` an ES module. Focused and full runs were repeated with the available Node 24 runtime.

## Concerns and limitations

- X API app approval and tier eligibility remain unverified; a user-provided OAuth 2 user access token with `tweet.write` and `media.write` is required.
- X does not provide an exact send-key lookup in the adapter. Recovery uses recent account-timeline text and reply-chain matching, so missing or ambiguous evidence stops for user review. The per-part `Idempotency-Key` is sent as a request identifier, but duplicate protection is not assumed from it.
- Provider credentials and actual image upload behavior were not tested against a live X account.
