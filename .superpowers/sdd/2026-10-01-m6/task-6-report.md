# M6 Task 6: X adapter

## Status

Implemented and committed as `feat(x): add API publishing with assisted fallback`.

## Implementation

- Added an X API adapter with account-bound OAuth lookup, weighted 280-character validation, t.co URL counting, image upload with alt text, thread replies, and X post URLs.
- Reused the persisted delivery send key in per-part request identifiers. On a known later-part rejection, the adapter persists confirmed X post IDs plus authenticated account, send key, and content/media fingerprint. A retry fetches every saved ID and validates authorship, exact text/media, and the reply chain before attaching the next part. Timeline heuristics are not used; unknown create outcomes remain for manual reconciliation.
- The channel form keeps X API mode unavailable because the plugin cannot verify OAuth write/media scopes or API-tier access without publishing. Test connection reports identity only; the API adapter requires an explicit `xApiAccessVerified` configuration value before it will publish. Once enabled, API-tier 403 refusals remain visible `NeedsUserError`s and assisted mode remains available.
- Corrected X URL counting so terminal punctuation remains part of both scheme URLs and bare-domain paths, refuses unsupported/excess media rather than dropping it, and propagates thread authorization/content/unknown-outcome failures instead of marking the thread published. Known 4xx/permission failures save an exact confirmed-part checkpoint for a validated resume; ambiguous outcomes do not.
- Registered the adapter and added adapter contract coverage, X-specific tests, and X sections in the user and QA guides.

## Verification

- Focused X adapter, weighted-count, orchestrator, frontmatter/state-machine, registry, docs, and shared adapter contract tests: 310 passed, 8 skipped. The new regressions were observed failing first for the reviewed gaps.
- `npm run typecheck`: passed with 0 errors and 1 existing warning in another file.
- `npm run lint`: passed.
- `git diff --check`: passed.
- Full suite under Node 24: 1,829 passed, 9 skipped, 48 failed. Failures are loopback networking tests blocked by sandbox `listen EPERM` errors on `127.0.0.1`.
- The initial red run under the default Node 20 runtime failed before tests loaded because Vitest's jsdom dependency attempted to `require()` an ES module. Focused and full runs were repeated with the available Node 24 runtime.

## Concerns and limitations

- X API app approval and tier eligibility remain unverified; a user-provided OAuth 2 user access token with `tweet.write` and `media.write` is required. The live plugin therefore leaves X on assisted publishing. A future OAuth setup must externally establish the permissions and set `xApiAccessVerified` before API publishing can be enabled in the platform definition.
- X does not provide an exact send-key lookup in this adapter. Timeline text/media cannot prove a post came from this send, so lookup stays unknown. Partial retries require a checkpoint persisted from successful X responses and are rejected unless all saved IDs still resolve to the authenticated account, expected text/media, and exact reply chain. The per-part `Idempotency-Key` is sent as a request identifier, but duplicate protection is not assumed from it.
- Provider credentials and actual image upload behavior were not tested against a live X account.
