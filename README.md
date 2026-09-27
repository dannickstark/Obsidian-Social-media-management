# OSMM — Social Planner for Obsidian

Plan, preview, schedule and publish social media posts and WordPress articles from your vault.

- Design spec: `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md`
- Implementation plans: `docs/superpowers/plans/`

## Development

Requirements: Node 22+, Obsidian 1.11.4+.

    npm install
    npm run seed          # creates dev-vault/ with sample campaigns (add -- --large for 5,000 notes)
    npm run dev           # builds and copies the plugin into dev-vault/ on every change

Open `dev-vault/` as a vault in Obsidian and enable **Social Planner (OSMM)** under Community plugins.

    npm test              # unit tests (Vitest, TZ=Europe/Berlin)
    npm run typecheck && npm run lint
