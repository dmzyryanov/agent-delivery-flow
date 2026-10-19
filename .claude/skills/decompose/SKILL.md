---
name: decompose
description: Turns a big goal of the owner into a `type:epic` issue and a set of small child issues, each one pull request, in dependency order with `Depends on` lines, so that grooming and the delivery cycle can take them one by one. Writes issues only, never the repository, and never sets `state:ready` on its own. Use for /decompose, "декомпозируй", "разбей на задачи", "вот большая задача", "хочу сделать …" when the request is bigger than one change.
---

# /decompose

A goal too big for one pull request becomes an epic with children (D25). The
epic holds the goal and the list; the children are what gets groomed and
delivered. The run writes GitHub issues only — no branch, worktree, commit or
pull request — and talks to the owner in `project.ownerLanguage` from
`.claude/flow.json`. Questions go in the message text, never only in a UI box.

`R` below is `node .claude/scripts/flow-config.mjs project.repo`.

## 1. Read before asking

- `docs/PRODUCT.md`, `docs/ARCHITECTURE.md` (its `Stable parts`),
  `docs/DECISIONS.md` (the project's own entries), `docs/RESOURCES.md`,
  `.claude/delivery-areas.json`, `.claude/flow.json`.
- The tree at freshly fetched `origin/main` — what exists already. In an
  empty project the first child is the scaffold (step 3).
- Open issues: `gh issue list --repo R --state open --limit 200 --json number,title,labels,body`.
  A child that duplicates an open issue is not filed: the existing issue is
  linked into the epic instead (step 6), and the owner is told.

## 2. One round of questions

Ask only what changes the breakdown, in one message, numbered, each with the
answer you recommend: who it is for and the one thing they must be able to do
first; what is explicitly out; constraints (deadline, budget, hosting, data
about people, integrations); for a visual product, whether design goes through
Figma (`design.figma`) or a written description; what "done" looks like for
the whole goal. Skip a question the goal or the docs already answer. When the
owner says "decide yourself", decide and say what you chose.

For a goal with a material technical choice — a new service, storage, an
external API, realtime, anything costly to reverse — ask `architect` for a
look at the slicing: the order of work, what must exist first, which hard
areas each slice touches, and the risks to put in front. Invoke it without a
`model` parameter.

## 3. The breakdown

Children are vertical slices: each one leaves the product working and adds
something observable, and each fits one pull request — roughly a day of agent
work and a diff a reviewer reads in one sitting. Prefer more, smaller
children over fewer large ones; 3 to 12 per epic. A goal that needs more is
several epics, each a usable increment, and the later ones depend on the
earlier ones.

In order:

1. **Scaffold** (only when the repository has no application yet): the
   stack's skeleton, a hello-world that builds and tests, the project's
   commands written into `.claude/flow.json` (`install`, `check`, `test`,
   `build`, and `taskTest`/`taskDown` with `{task}` when suites need a
   database or ports) together with their allow rules in
   `.claude/settings.json` (`Bash(<command>)` and `Bash(<command> *)`, `{task}`
   as `*` — without them unattended runs cannot run the commands, and
   `flow-consistency.test.mjs` fails), the CI job `project` running them,
   and `docs/ARCHITECTURE.md`'s first version. `type:chore`, areas `dependencies`,
   `ci-deploy`, `delivery-process`. Every other child depends on it.
2. **Deployment** (when the goal includes a running service and
   `delivery.deploy` is false): the main workflow's `deploy` and smoke jobs,
   `delivery.deploy`, `project.site`, `delivery.rollback`. Usually
   `delivery:attended` with `Attended because: the owner provides hosting
   access and watches the first deployment`, and an `## Owner steps before
   delivery` checklist for accounts and secrets.
3. **The slices**, the thinnest end-to-end path first, then breadth, then
   polish.

Each child has:

- `## Problem` — the owner's need in plain words, the source of the Context
  block.
- `## Goal` and observable `## Acceptance criteria` — each one a check a
  tester can run against a SHA without asking anyone.
- `## Out of scope`.
- `## Touches` — area names from `.claude/delivery-areas.json`.
- `Epic: #<epic>` and one `Depends on #<n>` line per prerequisite, on lines of
  their own.
- Labels: new behaviour `type:idea` (the flow's label for product work),
  defects `type:bug`, the rest `type:chore`; one `area:` label; no `state:`
  label and no `prio:` label.
- A design reference for a child labelled `area:frontend`: the Figma frame
  when `design.figma`, else a short written layout — without one the
  delivery cycle will not take it unattended.

## 4. Show the plan

Before filing anything, show the owner:

- the Context block for the epic — **Problem**, **Where from**, **If we do
  it**, **If we don't**, in the owner's language (in Russian: **Проблема**,
  **Откуда**, **Если сделаем**, **Если не сделаем**), one or two lines each,
  plain words, inference marked;
- a numbered table of children: title, one line of what is observable after
  it, depends on, areas, attended or not;
- what you decided on the owner's behalf.

Ask one question: file it as shown, or what to change. Revise until the owner
says to file it.

## 5. File it

1. The epic: `gh issue create --repo R --title <goal> --label type:epic --body-file <file>`
   from `.github/ISSUE_TEMPLATE/epic.md`: `## Problem`, `## Goal` (the observable end state), `## Out of scope` and an
   empty `## Children`.
2. The children in dependency order, so that every `Depends on #<n>` names an
   issue that exists: each through `/create-task`'s rules and templates
   (`.claude/skills/create-task/SKILL.md`), with the `Epic: #<epic>` line.
3. The epic's `## Children`: one `- [ ] #<n> <title>` per child, in delivery
   order. Read the body, edit the file, and replace it with
   `gh issue edit <epic> --repo R --body-file <file>` in a later call — never
   in the same parallel batch as the Write of that file.

Check afterwards with `gh issue view <epic> --repo R --json body` that every
child is listed and with `gh issue list --repo R --state all --search '"Epic: #<epic>" in:body' --json number,body`
(keeping only issues whose body has the exact line)
that none is missing.

## 6. After filing

Report in the owner's language: the epic's link, the children with links and
their order, and what happens next — the scheduled grooming grooms each child
(or the owner runs `/groom`), and the delivery cycle delivers a child once it
is `state:ready` and its dependencies are closed. `state:ready` and `prio:`
are the owner's to set: offer "make the first N ready now?" and set them only
on the owner's explicit word, removing any other `state:` label in the same
`gh issue edit`.

The epic itself is never groomed or delivered; the delivery cycle ticks its
boxes as children are delivered and closes it when the last one is.
