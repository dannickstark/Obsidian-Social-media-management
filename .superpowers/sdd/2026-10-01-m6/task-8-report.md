# M6 Task 8 report: adapter registration and settings gates

## Status

Implemented centralized registration for the M6 provider adapters and aligned channel setup and runtime method selection with provider capabilities. OAuth access and refresh token values remain in Obsidian's device secret storage; synced channel settings contain only the secret reference.

## Changes

- `src/platforms/adapters.ts`: registers Facebook, Instagram, LinkedIn, and X with the other shipped adapters. Instagram receives an assisted-only media host when no real host is configured.
- `src/platforms/instagram/api.ts`: exposes an API availability gate that stays false for the assisted-only host. The adapter can be registered without making Instagram API publishing selectable or dispatchable.
- `src/platforms/registry.ts`: native scheduling is selected only when both the platform definition and adapter support it. Runtime `apiAvailable` checks still route ineligible channels to assisted delivery.
- `src/main.ts`: explicitly leaves X write/tier verification and LinkedIn product/scope verification disabled in normal plugin wiring. LinkedIn grant metadata remains unavailable until a provider-specific verifier is configured.
- `src/platforms/linkedin/api.ts`, `src/publish/actions.ts`, and `src/settings/ChannelForm.svelte`: LinkedIn API selection now checks the selected credential's exact-token scope and product grants in addition to the provider access gate. Account discovery and test-connection controls remain provider-specific; Facebook continues to discover Pages only from a supplied local token.
- `src/settings/ChannelsSection.svelte`: channel summaries explain the provider-specific limits without displaying credential values.
- Tests cover M6 adapter registration, Instagram assisted fallback, capability-consistent scheduling, X assisted-only setup, exact-token LinkedIn grants, provider-specific account discovery, and secret-value privacy.

## TDD and verification

- The new registration test failed first because the plugin omitted Instagram from its adapter registry without a host.
- The capability test failed first because a native-scheduling adapter could make a LinkedIn channel appear natively schedulable even though LinkedIn's platform definition does not support it.
- Focused settings, registry, and adapter-contract tests pass: 171 passed, 9 skipped.
- The full main plugin test file passes: 52 passed.
- `npm run typecheck` passes with 0 errors and 1 existing warning in `test/fixtures/Hello.svelte`.
- `npm run lint` passes.
- The full Vitest suite ran under Node 23 because the default Node 20 runtime cannot load the installed ESM dependency used by jsdom. It reported 1,920 passed, 10 skipped, and 4 failures in existing tests: one `test/publish/overdueTray.test.ts` index timeout and three `test/platforms/x/adapter.test.ts` checkpoint expectations. The same four failures reproduced when those two test files were run alone; neither file was modified by this task.

## Limits

Provider authorization remains deliberately fail-closed: Instagram stays assisted until a real provider-reachable media host is configured; X stays assisted until write/media scopes and tier access are verified; LinkedIn stays assisted unless the exact token's required product and scopes are confirmed. Facebook Page discovery remains based on a user-supplied token. No image generation, token-health UI, or documentation work was included.
