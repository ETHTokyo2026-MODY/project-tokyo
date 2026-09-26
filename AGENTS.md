# Agent rules

Rules for every coding agent (human or AI) working in this repo.

## Workflow

- Change the repo only via pull requests from branches. Never push to `main`.
- Never force push or rewrite history.
- One thing per PR.
- PRs are squash merged through the merge queue once checks pass.

## PR title

Use Conventional Commits: `type: summary` or `type(scope): summary`.

- `type` must be one of: `feat` | `fix` | `docs` | `chore` | `test` | `ci` | `refactor` | `style` | `perf` | `build`
- Summary starts lowercase, has no trailing period, and is at most 72 characters

## PR body

Fill in all three template sections with real content:

- What changed
- How it was tested
- AI usage (which files/areas were AI-written and with what tool)

Document AI usage on every PR.

## Secrets and repo files

- Never commit secrets, keys, or `.env` files. Only `.env.example` is allowed.
- Do not modify CI workflows, repo rules, or this file unless the PR is explicitly about that.

## Attribution

List reused libraries and forked code in the README.

## Planned layout

- `apps/web` — Next.js app
- `contracts/` — Foundry contracts
- `docs/` — plan, specs, prompts
