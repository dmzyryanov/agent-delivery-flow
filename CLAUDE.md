<!--
Template placeholders. `/flow-init` replaces each one and then removes this
comment; a placeholder left in the file means the project is not initialised.

{{PROJECT_NAME}}            the project's name, as in `project.name` of `.claude/flow.json`
{{PROJECT_SUMMARY}}         one paragraph: what the project is, for whom, and where it runs (its site, or "no deployed site")
{{AUTHORITY_DATE}}          the date the owner ran `/flow-init` and so approved autonomous delivery, YYYY-MM-DD
{{OWNER_LANGUAGE}}          the language the owner is spoken to in, as in `project.ownerLanguage` (default Russian)
{{STACK}}                   languages and frameworks on each side, and the conventions to keep (one or two sentences)
{{REPOSITORY_STRUCTURE}}    a text tree of the repository's top two levels, the flow's own `.claude/`, `.github/` and `docs/` included
{{DEVELOPMENT_PRIORITIES}}  a numbered list, most important first; the first is what a blocking defect is measured against
{{TESTING_NOTES}}           which business logic must have unit tests, named concretely
-->

# {{PROJECT_NAME}} — Claude Code Instructions

## Project and delivery authority

{{PROJECT_SUMMARY}}

Read `docs/DELIVERY.md` for the current task-to-deployment process. The owner
approved autonomous delivery of agreed tasks on {{AUTHORITY_DATE}}, by running
`/flow-init` (D24): one PR contains requirements, implementation, tests and
relevant docs; Coordinator merges after verification, follows deployment,
checks the site, tags changed versions and performs compatible recovery, each
as far as `.claude/flow.json` turns it on (D23).
No owner visual acceptance or extra merge approval is required. A task-specific
restriction (read-only, draft only, no merge) still overrides this default.
A scheduled delivery cycle delivers issues labelled `state:ready` under that
same authority, around the clock, following `.claude/scheduled/delivery-cycle.md`:
a fire on `schedule.cycle` (every 30 minutes by default), up to three tasks
developed side by side, and merge, deployment and smoke one at a time under
the delivery lock (D16). An attended session — the owner in the chat —
registers its task in the same queue and merges under the same lock; the
cycle leaves to it the issues labelled `delivery:attended`, whose delivery
needs a person present. The owner is called only when necessary, for an
important change that cannot be delivered safely without them; when in doubt,
no person (D18). A scheduled grooming run grooms one open issue on
`schedule.grooming` (every 15 minutes by default), following
`.claude/scheduled/grooming.md`, which writes to issues and never to the
repository (D14).

Before changing behaviour, read the relevant parts of PRODUCT, ARCHITECTURE,
DECISIONS and RESOURCES under `docs/`, and any contract document ARCHITECTURE
names. Check RESOURCES before asking for URLs or access locations. Old briefs
and closed issues retain delivery history; they are not prerequisites for new
tasks.

## Working principles

- Capture the owner's agreed goal, criteria and design reference in the same PR
  that implements them. No release brief or separate requirements PR is required.
- Start a task branch from freshly fetched `origin/main`; target `main`. Preserve
  unrelated local changes. Never edit or push directly to main.
- A task may explicitly change an earlier requirement. Record the amendment in
  the same PR; do not ask again for a change the owner already approved.
- Task intake lives in GitHub Issues (D1); an open issue is a candidate, not
  authorisation to expand scope. Issues are filed with `/create-task`
  (`.claude/skills/create-task/SKILL.md`) and groomed with `/groom`
  (`.claude/skills/groom/SKILL.md`); a large goal is split by `/decompose`
  (`.claude/skills/decompose/SKILL.md`) into an epic, `type:epic`, and small
  issues (D25). `state:ready` is set only on the owner's explicit word,
  except that the scheduled grooming sets it on the narrow class of small bugs
  and chores invisible to users that `.claude/scheduled/grooming.md` defines
  (D14). Setting a `state:` or `prio:` label removes the others of its kind
  in the same call (D22).
- The owner does not read issue text. Whenever an issue comes up in chat —
  filed, groomed, or just named by the owner — open with the Context block,
  in {{OWNER_LANGUAGE}}, its title and four headings in that language —
  Context: Problem, Where it came from, If we do it, If we don't; in Russian
  **Контекст**: **Проблема**, **Откуда**, **Если сделаем**,
  **Если не сделаем** — one or two lines each, in plain words, with no file
  paths or decision numbers, taken from the issue's `## Problem`, inference
  marked.
- {{STACK}} Avoid unnecessary abstractions and infrastructure.
- Update affected behaviour documentation with the code. Record significant
  lasting decisions in DECISIONS; ordinary reversible choices belong in the PR.
  Related code and documentation may share a commit.
- An additive in-scope contract change updates every side of the contract,
  shared types, tests and docs together in one PR. A breaking change to a part
  `docs/ARCHITECTURE.md` lists under `Stable parts` is not delivered without
  the owner: in an attended session the Coordinator asks the owner; an
  unattended run ends BLOCKED with the draft PR. Evaluate clients already
  running, stored data and recovery; beyond what `Stable parts` promises
  there is no obligation to support unused external versions.
- With `delivery.versioning` on, `VERSION` is the product version; apply
  docs/DELIVERY.md's bump/tag policy. A new major version, the first 1.0.0
  included, is a separate owner decision.
- Credentials must never appear in Git or output. Existing authenticated tools,
  environment references and secret-management mechanisms may be used without
  requesting permission merely because authentication is involved.

## Agent team

The main session coordinates: it owns git, GitHub, deployment and the
conversation with the owner. "Coordinator" in docs/DELIVERY.md names that
function, not a sub-agent. Tracked sub-agents in `.claude/agents/` are
`developer`, `tester` and `reviewer`, with `tester-look`, a narrower variant
of `tester` for the grooming's look, and `tester-process`, a copy of `tester`
on another model for the class of pull request `docs/DELIVERY.md` step 4
routes to it (D21); `architect` is a read-only tool invoked on demand for a
material technical question, not a step in the delivery sequence. The
scheduled grooming asks `architect` and `tester-look` for a look at each issue
it grooms, a step of grooming, not of delivery (D14).

Each role's limit is a mechanism where one exists, not a promise:

- `developer` is the only role holding Edit/Write, and pushes only its branch;
  the Bash guard refuses a push to main and any force push in every session
  (D26), and the repository's ruleset does too where the plan allows one.
  The one exception is the Coordinator's: besides integrating main and
  setting the version under the delivery lock, it edits a task branch only
  for a wording fix to `*.md` outside the files `docs/DELIVERY.md` step 4
  excludes from the carry-forward, answering a named finding (D19).
- `tester` and `tester-process` keep Bash, so the main session fingerprints
  the worktree of each with `.claude/scripts/tree-fingerprint.sh` before and
  after the run and compares the readings itself; a changed fingerprint
  invalidates that verdict. The scheduled grooming fingerprints the main
  checkout around its planning-only look the same way (D14). Both also
  hold interactive browser tools for design comparison and deployed checks,
  which are client-provided: each confirms them with `ToolSearch` when it needs
  them and reports NOT VERIFIED when they are absent (D4,
  `docs/tooling/claude-mcp.md`).
- `reviewer` holds no Bash and no Edit/Write by design. It reads the artifact
  from `.claude/scripts/review-artifact.sh`, whose header pins the base, head
  and fingerprint, plus the tree through Read/Grep/Glob.

When `outsideReview.enabled` is true in `.claude/flow.json`, the main session
runs the outside review through `sh .claude/scripts/outside-review.sh` when
`docs/DELIVERY.md` step 4 says to (D12, D15); no sub-agent runs Codex,
enabled or not. Inside any sub-agent the Bash guard holds that for the
spellings it reads, refusing the script, its helper and `codex`; what it does
not read — `sh -c`, a name built at run time, a renamed copy, `npx codex` —
stays this rule alone (D9).

With `design.figma` true, Claude draws the design in Figma — two or three
directions for a new screen — and the owner approves it before
implementation; without it, the design reference is a saved image or a
description in the issue, which the owner approves the same way. There is no
Designer agent.
Run `sh .claude/scripts/delivery-preflight.sh` twice — from `main` before
branching and from the task branch afterwards. It verifies that the base carries
the agent definitions; the first call prints the BASE_SHA to record, the second
reports which commit the branch was actually cut from and whether `origin/main`
has moved since. If a role is unavailable, check the checkout, definition and
session loading and retry a transient invocation. Do not invent an independent
verdict or let Developer stand in for Reviewer. See docs/DELIVERY.md for the
modes, worktree lifecycle, several tasks at once, bounded correction and
blockers.

Sub-agent hygiene:

- The session scratchpad is shared by every sub-agent. Each writes under a
  file-name prefix of its own, and the decisive evidence is what it printed to
  its own stdout, not what a shared log file says later.
- Every agent that runs a suite binding ports or using a database — the
  browser suite, `commands.e2e`, among them — takes ports of its own and a
  disposable database of its own, named with its prefix, and removes what it
  started afterwards. Tasks of the delivery cycle run side by side, so this
  holds for a tester and a developer alike, and a dev server an agent starts
  listens on a port of its own.
- A task in the delivery queue runs its test suite on resources of its own:
  Developer and Tester run `commands.taskTest` with `{task}` filled in (a
  single file after `--` where the command takes one), which brings those
  resources up and runs the suite against them, and `commands.taskDown`
  removes them when the task ends, so two tasks' suites never share data
  (D16). With `commands.taskTest` empty they run `commands.test`, and the
  suite must then share no state between two tasks run at once.
- Commit messages are written with `git commit -F <file>`, the file in the
  scratchpad, not with chained heredocs: a `commit && commit` heredoc chain once
  lost both subjects.

## Decision boundaries

Implement the approved task autonomously, including reversible implementation
choices, necessary in-scope schema/API changes, branch push, PR creation,
verified merge, normal CI deployment, tagging and reviewed compatible rollback.
Consult specialists when useful, not as a mandatory permission ritual.

Escalate missing material product intent, scope expansion, new paid services,
material security/privacy changes, unavailable credentials, destructive data
operations, or a genuine technical blocker. Ordinary uncertainty, a missing
release brief, the end of the three correction rounds — after which only a
blocking defect is fixed and other findings become follow-up issues
(`docs/DELIVERY.md`, D15) — or an already-authorised merge are not approval
requests. Diagnose first and finish independent authorised work.

Resolve stale documentation according to the owner's explicit instruction and
record the correction. If neither instruction nor evidence settles a material
conflict, report its concrete consequence and recommended resolution.

## Communication style
Keep responses concise and action-oriented. Speak to the owner in
{{OWNER_LANGUAGE}}; repository text — code, documentation, issues, pull
requests, commit messages — stays in English.

- Prefer short answers over long explanations.
- Do not restate the task or documentation unless necessary.
- Do not explain obvious implementation details.
- For completed tasks, summarize only:
  - what changed;
  - important decisions or deviations;
  - tests/checks performed;
  - blockers, if any.
- Avoid long file-by-file change descriptions unless requested.
- When asking for a decision, present the options briefly and recommend one.
- Expand only when the user explicitly asks for details.

## Repository target structure
```text
{{REPOSITORY_STRUCTURE}}
```

## Development priorities
{{DEVELOPMENT_PRIORITIES}}

## Testing
Keep testing proportionate to the change. Behaviour a change claims to have
verified should be covered by a test in that same change, so the claim stays true
later. {{TESTING_NOTES}} Do not build a large E2E suite unless the approved
task requires it.
