# Agent rules

Rules for every coding agent (human or AI) working in this repo.
These rules apply to every agent and person on every teammate's computer, and
agents must also follow `docs/PLAN.md`.

## Small PRs

- One thing per PR, small and concise. Aim for under 300 changed lines; over 800
  changed lines (not counting lockfiles or generated files) must be split.
- Split big work into a sequence of small PRs, each one leaving `main` working
  (builds, tests pass). Open the next PR after the previous one merges, or base
  it on `main` with a clear order.
- Squash merge means the PR is the commit on `main`, so PR size is commit size.
- Keep generated output (deployment receipts, broadcast logs, build artifacts)
  out of feature PRs; commit only the few files that are needed, in their own PR.
- Before starting, check open PRs so work is not duplicated.
- Architecture decisions come from `docs/PLAN.md`. To change one (for example
  the token standard or network), first open a small `docs:` PR updating the
  plan, agreed by Michael and Darryl, before writing code for it.
- Commit as the human teammate you work for (their git name and email). Do not
  add AI co-author trailers; record AI usage in the PR body instead.
- No draft or placeholder PRs; open a PR when its checks pass locally.

## Workflow

- Change the repo only via pull requests from branches. Never push to `main`.
- Never force push or rewrite history.
- One thing per PR.
- PRs are squash-only merged directly, with 0 approvals required. Keep a linear
  history, and resolve all review comment threads before merging. Tests run on
  `main` after each merge; PRs only get a PR-format check. Checks never block
  merging.

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
