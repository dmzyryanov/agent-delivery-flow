<!--
Template placeholders. `/flow-init` replaces each `{{…}}` with what it learns
from the owner and the repository, writes "none" where the project has no such
thing, and then removes this comment. A line whose placeholder is "none" may be
deleted. Values here are names, URLs and locations, never secrets.
-->

# {{PROJECT_NAME}} — Project Resources

This file is the source of truth for non-secret project links and external
resources used during development and operations. Check it before asking the
owner for a URL or an access location.

**Do not store passwords, access tokens, API keys, private keys, or other
credentials in this file or elsewhere in Git.** Sensitive values come from
local environment variables, GitHub Actions secrets, or the deployment
platform's secret store, as Access and secrets below names them.

When a new external service is added, store its non-secret URL here and
document where its credentials are expected to come from, without recording
the credential value itself.

## Repository

- GitHub repository: https://github.com/{{REPO}} — `project.repo` in
  `.claude/flow.json`; main branch `{{MAIN_BRANCH}}`.
- Pull requests: https://github.com/{{REPO}}/pulls — one task, one PR
  (`docs/DELIVERY.md`); template `.github/pull_request_template.md`.
- Issues: https://github.com/{{REPO}}/issues — labels `type:bug`,
  `type:chore`, `type:idea`, `type:epic`; `area:*`; `prio:1`–`prio:3`;
  `state:ready`, `state:grooming`, `state:needs-owner`, `state:deferred`;
  `delivery:attended` (its reason on an `Attended because:` line in the
  description). Templates in `.github/ISSUE_TEMPLATE/`; `/flow-init` creates
  the labels.
- GitHub Actions: https://github.com/{{REPO}}/actions — `.github/workflows/ci.yml`
  on pull requests, `.github/workflows/{{MAIN_WORKFLOW}}` on pushes to main
  (`delivery.mainWorkflow`).
- Branch rules: {{BRANCH_RULES}} — the ruleset `/flow-init` created on main
  (no direct push, no force push, changes through merged PRs only), or "none:
  the plan does not allow rulesets on this repository; the Bash guard's push
  rule is the only mechanism (D26)".
- Merged head branches are deleted by the repository itself (Settings →
  General → "Automatically delete head branches"), set by `/flow-init`.
- Main checkout on the operator's machine: `{{MAIN_CHECKOUT}}`. Worktrees go
  beside it, outside the repository (`docs/DELIVERY.md`, Worktrees).
- The delivery queue the sessions share: under the main checkout's git
  directory, `{{MAIN_CHECKOUT}}/.git/delivery-queue/` — `state.json` (the
  tasks, the lock, the decision-id counter) and `settings.json`, written by
  `node .claude/scripts/delivery-queue.mjs` alone and never in Git. `status`
  prints the slot limit (3 unless `set slots <n>` changed it) and the
  liveness threshold (90 minutes unless `set stale-minutes <n>` changed it).

## Repository documentation

- Product specification: `docs/PRODUCT.md`
- Architecture, with the `Stable parts` the project promises compatibility
  for: `docs/ARCHITECTURE.md`
- Contract documents: {{CONTRACT_DOCS}} (an API description, a schema, or "none")
- Decisions log: `docs/DECISIONS.md`
- Change delivery, versioning and recovery: `docs/DELIVERY.md`
- Product version: `VERSION`; changelog: `CHANGELOG.md`
- Claude Code instructions: `CLAUDE.md`; flow configuration: `.claude/flow.json`
- Tooling notes: `docs/tooling/claude-mcp.md`, `docs/tooling/codex.md`,
  `docs/tooling/scheduled-fires.md`

## Deployment and site

- Site: {{SITE}} — `project.site` in `.claude/flow.json`, or "none".
- Deployment target: {{DEPLOY_TARGET}} — the platform and the environment the
  main workflow's `deploy` job deploys to, its region, and who owns the
  account; or "none: `delivery.deploy` is false".
- Smoke check: the job `{{SMOKE_JOB}}` of the main workflow
  (`delivery.smokeJob`), checking {{SMOKE_CHECKS}}.
- Where the last verified deployment is read before a merge: {{DEPLOY_STATUS}}
  — the command or page that shows what is deployed now (main's SHA, the run
  id, what `delivery.rollback` needs).
- Rollback: {{ROLLBACK}} — `delivery.rollback`, the one command the
  Coordinator may run once after a failed deploy or smoke, or "none: recovery
  is a revert PR" (`docs/DELIVERY.md`, Recovery).
- Disposable test data for the deployed check: {{TEST_DATA}} — how the
  Coordinator makes data of its own on the deployed service, and how it is
  removed.
- Operational access: {{OPERATIONS_ACCESS}} — the CLI, console or SSH alias
  used to read deployment metadata, by name only.

## Access and secrets

References only: a name and where the value lives, never the value. Nothing
in this section is read, printed or copied by a session; a secret the work
needs is used through the tool that holds it.

- Local development: `.env` (gitignored); variable names with empty values in
  `.env.example` (committed).
- GitHub Actions secrets and variables, by name:
  - {{ACTIONS_SECRET}} — what it is for, who creates it, how it is replaced.
- Deployment platform secrets, by name:
  - {{RUNTIME_SECRET}} — where it lives, what reads it, how it is replaced.
- The owner's personal accounts (the domain registrar, the hosting console,
  the Codex sign-in): {{OWNER_ACCOUNTS}} — named here so that a session knows
  they exist; their credentials are the owner's alone and are recorded
  nowhere in the project.

## External services

One line per service: name, URL, whose account, what it is for, what it
costs, and where its credential reference is (Access and secrets).

- {{EXTERNAL_SERVICE}}

## Tooling

- GitHub CLI: `gh`, used for pull requests, issues, labels, workflow runs and
  read-only API calls, always with `--repo {{REPO}}`. Authenticate once with
  `gh auth login`; the token is stored in the operating system keyring and
  must never be written into the repository. Signed-in account:
  {{GH_ACCOUNT}}. Merges go only through
  `node .claude/scripts/delivery-queue.mjs merge`; the Bash guard refuses
  `gh pr merge` everywhere else (D16).
- git: the remote `origin` is {{GIT_REMOTE}} (SSH or HTTPS); tags are pushed
  over it, so CI holds no token for tagging.
- Node.js: {{NODE_VERSION}} — the flow's scripts under `.claude/scripts/`
  and their tests, `node --test .claude/tests/`, use Node built-ins only and
  need no install.
- Docker: {{DOCKER}} — what the project's commands use it for (a test
  database per task through `commands.taskTest`, say), or "not used". A fire
  of the delivery cycle starts nothing while a service the commands need does
  not answer.
- Claude Code: the desktop app on the operator's machine, signed in with the
  owner's account. MCP servers, their activation and per-agent verification:
  `docs/tooling/claude-mcp.md`.
- Scheduled fires: {{SCHEDULER}} — the desktop app's scheduled tasks
  `{{CYCLE_TASK_NAME}}` and `{{GROOMING_TASK_NAME}}`, which `/flow-init`
  creates (the default), or the launchd jobs `dev.agent-flow.<repo-name>.cycle`
  and `dev.agent-flow.<repo-name>.grooming`, installed with
  `sh .claude/scripts/launchd/install.sh`, their log under
  `~/Library/Logs/agent-flow/<repo-name>/` — one or the other, never both
  (D17). Each runs the procedure its prompt points at,
  `.claude/scheduled/delivery-cycle.md` or `.claude/scheduled/grooming.md`,
  in the main checkout `{{MAIN_CHECKOUT}}`, on `schedule.cycle` and
  `schedule.grooming` of `.claude/flow.json`, with the model, effort and
  permission mode `docs/tooling/scheduled-fires.md` gives. The machine's
  preconditions — kept awake on mains power, the app installed, Docker
  running when the commands need it — are there too.
- Codex CLI (optional): {{CODEX}} — OpenAI's `codex`, signed in with the
  owner's ChatGPT account, run by the main session only through
  `.claude/scripts/outside-review.sh` when `outsideReview.enabled` is true
  (D12); or "not installed: outside review disabled". The login is cached
  outside the repository and is never read, printed or copied. Install,
  sign-in, the allowance and the record of reported skips:
  `docs/tooling/codex.md`.
- Figma (optional): {{FIGMA_FILE}} — the design file, when `design.figma` is
  true, reached through the Figma MCP server, authenticated locally in Claude
  Code and never in the repository; or "not used: design references are saved
  images or descriptions in the issue". Approved design pages are listed
  here as the owner approves them, each with its issue and the frames to
  implement.
