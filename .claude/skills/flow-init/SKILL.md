---
name: flow-init
description: Sets a project up on the agentic delivery flow — creates the GitHub repository from the agent-delivery-flow template (or configures the one it runs in), fills `.claude/flow.json`, CLAUDE.md and the docs, creates the labels, repository settings and the main-branch ruleset where the plan allows, checks CI, lands the setup through the delivery queue and creates the two scheduled tasks. Use for /flow-init, "init", "инициализируй проект", "подключи флоу", "заведи новый проект на флоу".
---

# /flow-init

One run turns a fresh repository into a project on the delivery flow (D24). It
talks to the owner in the owner's language — ask it first when the chat does
not show it — and asks once, in one message, for everything it cannot know;
every question offers a default the owner can accept with one word. Write the
questions as message text, never only in a UI box.

## 0. Where it runs

Read `.claude/flow.json` and `git remote get-url origin`, then pick one case:

- **A. The kit itself** — `project.repo` is empty and `origin` is the
  template repository (`gh repo view --json isTemplate --jq .isTemplate` says
  `true`). The run checks the preconditions (step 1), asks the questions
  (step 2), creates the new project from the template (step 3), writes the
  answers into the new checkout as `.claude/flow-init.answers.md` (ignored by
  Git), and stops there: the rest must run in a session of the new
  checkout, whose transcript the delivery queue can see and whose settings
  load the project's Bash guard. Tell the owner to open the new folder in
  Claude Code and run `/flow-init` again; it continues as case B.
- **B. A project made from the template** — `project.repo` is empty and
  `origin` is not a template. The run configures this checkout, the one the
  session was opened in. When `.claude/flow-init.answers.md` exists, it holds
  the owner's answers from case A: read it, show them in one short list, ask
  only what it leaves open, and delete the file once step 6 has merged.
- **C. Already set up** — `project.repo` is filled. Say so, show the values,
  and ask what to change; change only that, through steps 4–9 as they apply.

An existing repository that was not made from the template is not handled
here: say that the flow files can be copied in on a branch (`.claude/`,
`docs/DELIVERY.md`, `docs/DECISIONS.md`, `docs/tooling/`, `.github/`,
`CLAUDE.md` merged by hand) and that /flow-init then runs as case B.

## 1. Preconditions

Check, and report every failure at once with its fix:

- `gh auth status` — logged in, scopes include `repo` and `workflow`.
- `git --version`; `node --version` is 20 or newer.
- `claude --version` or the desktop app (the scheduled tasks need the app
  open, or launchd plus `claude`).
- `docker info` only when the owner's answers below say the project needs
  Docker (a database or services for tests).
- `codex --version` only when the owner wants outside review.

Nothing else is installed by this skill.

## 2. Questions for the owner

Ask in one message, numbered, each with its default:

1. Project name and repository `owner/name` (default owner: the `gh` login;
   name: the project name in kebab case); private (default) or public.
2. One paragraph: what it is, for whom, where it runs.
3. The owner's language for chat, reports, issues' Context blocks and the
   scheduled tasks' titles (default: the language of this chat), written to
   `project.ownerLanguage`.
4. Stack — languages, frameworks, package manager — or "decide in the first
   epic" (default). With a stack named, the commands `install`, `check`,
   `test`, `build` and, if suites need a database or ports, `taskTest` and
   `taskDown` with `{task}`; leave what is not known empty: the first epic's
   scaffold task fills them.
5. Deployment: none yet (default), or the site URL and how it deploys; a
   rollback command if one exists.
6. Versioning with `VERSION`, CHANGELOG and tags (default yes).
7. Outside review by Codex (default no; needs the owner's ChatGPT login).
8. Figma design directions for new screens (default no; yes needs the Figma
   connector).
9. Scheduled tasks: the delivery cycle every 30 minutes and grooming every 15
   (defaults), as desktop-app tasks (default) or launchd jobs behind the
   no-token check (`docs/tooling/scheduled-fires.md`); up to 3 tasks
   developed at once (default; applied with `set slots <n>` in step 6).

The owner's go-ahead to this run is also the authority of `CLAUDE.md`
(autonomous delivery of `state:ready` issues): say so in the message, and
record today's date as `{{AUTHORITY_DATE}}`.

## 3. Repository (case A only)

```bash
gh repo create <owner>/<name> --private --template <template owner/name> --clone
```

(`--public` when asked), run in the parent directory of the kit checkout, so
the new checkout is its sibling. Then in the new checkout:
`git config commit.gpgsign false` and `git config tag.gpgsign false` when the
global config signs commits (signing needs a TTY a session does not have).
Then write `.claude/flow-init.answers.md` there — the owner's answers,
numbered as the questions, and today's date as the authority date — and end
the run as case A says.

## 4. Files

The setup is written the way every change is, in a worktree outside the
checkout: `git -C <checkout> fetch origin`, then
`git -C <checkout> worktree add <checkout>-worktrees/chore-flow-init -b chore/flow-init origin/main`,
and record `git -C <checkout> rev-parse origin/main` as the base. In that
worktree:

- `.claude/flow.json` — every answered value; `project.repo` must be
  `owner/name`; check with `node .claude/scripts/flow-config.mjs project.repo`.
  `schedule.morningFire` must fall on a minute the grooming cron fires
  (`09:07` with the default `7,22,37,52 * * * *`); a changed cron moves it to
  its first minute after 09:00.
- `CLAUDE.md` — fill every `{{…}}` placeholder the comment at its top lists,
  then delete that comment; `grep -n '{{' CLAUDE.md` finds none afterwards.
- `docs/PRODUCT.md`, `docs/ARCHITECTURE.md` — the paragraph and the stack;
  `Stable parts` says "none yet".
- `docs/RESOURCES.md` — replace every `{{…}}` placeholder, writing "none"
  where the project has no such thing, then delete the comment at its top;
  `grep -n '{{' docs/RESOURCES.md` finds none afterwards.
- `delivery.draftPullRequests` in `.claude/flow.json` — `true` when the
  repository is public, or private under an organization the owner says is
  on GitHub Team or Enterprise; otherwise `false` (GitHub has no draft pull
  requests on private repositories of Free and Pro accounts, and the
  procedures then mark a PR not yet ready with a `Draft: ` title prefix).
- `VERSION` `0.1.0` and a CHANGELOG entry `## 0.1.0` "Project set up on the
  delivery flow" when versioning is on; otherwise remove both and say so.
- `.claude/delivery-areas.json` — adjust the ordinary areas' globs to the
  stack when one is named, and mark `"critical": true` the areas where a
  defect loses or leaks data (the owner names them, or say which you chose);
  leave the hard areas.
- `.claude/settings.json` — the rules the delivery cycle's Permissions block
  says `/flow-init` writes: for each non-empty command in
  `.claude/flow.json` (`commands.*` and `delivery.rollback`), with `{task}`
  written as `*`, `Bash(<command>)` and `Bash(<command> *)` —
  `flow-consistency.test.mjs` checks both; with `project.site` set, `Bash(curl -sS <site>/*)`
  and `Bash(curl -sS * <site>/*)`; and the block's two `gh api` rules with
  `<owner>/<name>` replaced by `project.repo`. A command that sets a
  variable in front of itself gets no rule: wrap it in a script and grant
  the script.
- `.mcp.json` — only when `design.figma` is true: the Figma server under the
  alias the roles' tools name,
  `{"mcpServers": {"figma": {"type": "http", "url": "https://mcp.figma.com/mcp"}}}`;
  it holds no credential. The owner signs in to Figma once from a session in
  the checkout (`/mcp`); say so in the report.
- `.github/ISSUE_TEMPLATE/epic.md` stays as shipped.
- `README.md` — replace the kit's front page with the project's: name,
  paragraph, how to run it (or "set up by the first epic"), and a short
  "How work gets done here" pointing at `docs/DELIVERY.md`, `/decompose`,
  `/create-task`, `/groom`.

Run `node --test .claude/tests/*.test.mjs` in the worktree; it must pass before the
commit. Commit with `git commit -F <file>` (the file in the scratchpad), in
the same Bash call as `cd <worktree> &&`.

## 5. GitHub settings

Each of these is idempotent; run them with `--repo <owner/name>`:

- Labels, `gh label create <name> --repo R --color <hex> --description <text> --force`:

  | Label | Color | Description |
  |---|---|---|
  | `state:ready` | `1ABC9C` | Owner-approved; only implementation remains |
  | `state:grooming` | `F39C12` | A grooming run or chat holds it |
  | `state:needs-owner` | `8E44AD` | Groomed; waits for the owner's answer |
  | `state:deferred` | `95A5A6` | Put off by the owner |
  | `type:bug` | `D9534F` | Defect in delivered behaviour |
  | `type:chore` | `6E49CB` | Maintenance, tests, tooling, docs |
  | `type:idea` | `1F75CB` | Product idea, not approved scope |
  | `type:epic` | `0E8A16` | A goal split into child issues by /decompose; never delivered itself |
  | `prio:1` | `CC0033` | Next up |
  | `prio:2` | `ED9121` | Planned |
  | `prio:3` | `A8D695` | Someday |
  | `delivery:attended` | `2C3E50` | Delivery needs a person present; the description says why |
  | `area:frontend` | `009966` | User interface |
  | `area:backend` | `34495E` | Server side |
  | `area:docs` | `7F8C8D` | Documentation and agent instructions |
  | `area:infra` | `AD8D43` | CI, deployment, delivery tooling |

  GitHub's default labels are left alone.
- `gh repo edit R --delete-branch-on-merge --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false --enable-auto-merge=false`
  — the queue merges with a merge commit and deletes nothing itself.
- `gh repo edit R --template=false` in case A (the copy must not be a
  template itself).

## 6. Land the setup through the delivery queue

The setup is the project's first delivery and goes the way every later one
does, which also proves `gh`, CI and the queue work:

1. `cd <worktree> && git push --set-upstream origin HEAD`;
   `gh pr create --repo R --base main --head chore/flow-init --title "Set up the delivery flow" --body-file <file>`
   (not draft); the body lists what step 4 wrote and the owner's answers.
2. Wait for the PR's checks: `gh pr checks <n> --repo R --watch` in the
   background. A failing check is fixed on the branch first.
3. In the worktree — `cd <worktree> && node .claude/scripts/delivery-queue.mjs …`,
   because the queue reads `.claude/flow.json` beside itself and main's copy
   is still unconfigured; the queue's state is shared through the git
   directory either way — with `<id>` this session's id (the directory that
   holds its scratchpad): first `set slots <n>` when the owner chose other
   than 3, then
   `node .claude/scripts/delivery-queue.mjs start day-flow-init --session <id> --branch chore/flow-init --worktree <worktree> --base <base sha> --areas delivery-process --day`,
   `… update day-flow-init --session <id> --pr <n>`,
   `… lock day-flow-init --session <id>` (prints the token),
   `… merge day-flow-init --token <token> --sha <full head sha>`, and once
   main's run for the merge commit has passed,
   `… finish day-flow-init delivered --session <id> --token <token>`.
4. `git -C <checkout> worktree remove <worktree>`, then
   `git -C <checkout> pull --ff-only` (the checkout stays on main), and
   delete `.claude/flow-init.answers.md` if it is there.

The Bash guard refuses every other merge and any push to main; do not look for
a way around it.

## 7. Main-branch ruleset

After the merge, try to protect main:

```bash
gh api --method POST repos/R/rulesets --input <file>
```

with a ruleset `main` targeting `~DEFAULT_BRANCH`, enforcement `active`,
rules `deletion`, `non_fast_forward`, `pull_request` (0 approvals) and
`required_status_checks` on the pull-request check names `flow` and
`project` (the jobs of `.github/workflows/ci.yml`). GitHub
refuses rulesets on a private repository of a Free account (HTTP 403 or 422
naming the plan): that is not a failure — write in `docs/RESOURCES.md`, on a
follow-up commit through the next delivery, that main is guarded only by the
Bash guard, and tell the owner the two ways to get real protection: make the
repository public or upgrade the account to Pro.

## 8. Scheduled tasks

Desktop-app tasks (default): create two with `create_scheduled_task`, ids
`<repo-name>-delivery-cycle` and `<repo-name>-grooming`, titles
"<Project> — delivery cycle" / "<Project> — grooming" written in the owner's
language (in Russian: "<Project> — цикл поставки" / "<Project> — груминг"),
`cronExpression` from `schedule.cycle` and `schedule.grooming`,
`notifyOnCompletion: false`, and the prompt (absolute paths):

```text
Work in <checkout>. First run `node .claude/scripts/fire-check.mjs cycle` there.
If it prints a line beginning `skip:`, stop and report that line only.
Otherwise read <checkout>/.claude/scheduled/delivery-cycle.md and follow it exactly.
If that file cannot be read, do nothing else and report that in one line.
```

(`grooming` and `grooming.md` for the second). Then tell the owner the one
step the tool cannot do: in the app's Scheduled list, open each task and set
its folder to `<checkout>` with worktree isolation off — a task run anywhere
else loads neither the project's settings nor its Bash guard. The tasks run
while the app is open and the Mac awake.

launchd instead: `sh .claude/scripts/launchd/install.sh` in the checkout, and
read its output back to the owner.

Both schedulers find nothing to do until an issue is `state:ready` (the
cycle) or open without a state label (the grooming).

An unattended run must start in Auto, or its first permission prompt stalls
it for hours (the delivery cycle's Permissions section). A desktop task
starts in the `permissions.defaultMode` of the user-level
`~/.claude/settings.json`, the one file where `"auto"` is honoured; the
project sets none. Read that file's value without printing anything else
from it. When it is not `"auto"`, ask the owner whether to set it — it
changes the starting mode of every session of theirs, not only this
project's — and set it only on an explicit yes; otherwise list it in the
report as the owner's step. launchd runs get `--permission-mode auto` on
their command line and need nothing.

## 9. Report

In the owner's language: the repository URL, the checkout path, what was
configured, the merged setup PR, whether main has a ruleset, the scheduled
tasks and the owner's folder step, and anything left empty in
`.claude/flow.json` with who fills it. End with the next step: give the goal
to `/decompose` in a session opened in the checkout.
