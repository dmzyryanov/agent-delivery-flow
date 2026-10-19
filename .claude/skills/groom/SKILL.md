---
name: groom
description: Backlog grooming. Picks the most relevant open GitHub issue (or the one the owner names) — first those the scheduled grooming left waiting for the owner — checks it against main and the delivery cycle's gates, discusses the implementation with the owner and rewrites the issue until only the owner's `state:ready` is missing. Use for /groom, "следующая задача", "груминг", "разбор задач".
---

# Groom

Grooming brings one issue at a time to the point where the owner can label it
`state:ready`. It is mode `plan` (`docs/DELIVERY.md`): no branch, worktree,
commit or pull request. Talk to the owner in `project.ownerLanguage` from
`.claude/flow.json` (English by default; `/flow-init` sets it from the chat);
write issue text in English, as the existing issues are. A question for the
owner goes in the message text, never only in a UI box.

`R` below is the repository `node .claude/scripts/flow-config.mjs project.repo`
prints, `owner/name`, written out in every `gh` command. GitHub labels are not
exclusive, so every change of a `state:` label names the other `state:` labels
in `--remove-label` in the same `gh issue edit`, and no issue is left carrying
two (D1, D13, D22).

## 1. Pick the issue

If the owner named an issue, take it, whatever it carries, `state:grooming`,
`state:deferred` and `state:needs-owner` included, unless a grooming run is
working on it — its newest `Grooming run` comment a `taken` claim under two
hours old — in which case say so and wait for its result. An epic the owner
names is discussed, not made ready (Epics, step 2). Otherwise, first say in
one line which issues the scheduled grooming (`.claude/scheduled/grooming.md`,
D14) made ready since the whole hour of `schedule.morningFire` the previous
day (09:00 for the default `09:07`) — those with a
`Grooming run <time>: ready without the owner` comment since then, found as
its morning notification finds them — and list the issues labelled
`state:needs-owner`. Then fetch the open issues
(`gh issue list --repo R --state open --json number,title,labels,body,updatedAt --limit 200`)
and propose one, passing over those labelled `state:grooming` (another chat or
a grooming run is grooming it), `state:deferred` (the owner has put it off) or
`type:epic` (a container `/decompose` made, delivered through its children,
D25), and those carrying two `state:` labels (a fault, named in the reminder
line below), in this order:

1. Waiting for the owner: `state:needs-owner`, in the order of item 3. A
   grooming run has prepared it: its `## Questions for the owner`, its design
   directions and its `## Delivery notes`.
2. Returned by the delivery cycle: no `state:ready`, and its latest
   scheduled-run comment is a `not taken` skip
   (`.claude/scheduled/delivery-cycle.md`). It was approved once, and the
   comment names what is missing.
3. Every other issue without `state:ready`, in the cycle's priority order:
   `prio:1`, `prio:2`, `prio:3`, then none; an issue with more than one
   `prio:` label counts at its highest and is named as a fault. Within one
   priority, an issue that another open issue names in a `Depends on` line
   comes first; then the smaller number. A child of an epic, an issue with an
   `Epic: #<n>` line, takes its place in this order like any other.

An issue labelled `state:grooming` whose newest `Grooming run` comment is a
`taken` claim is held by a grooming run, not a chat: under two hours old, the
run is working (above); over two hours, the run died, and taking it over,
first post `Grooming run <its fire time>: released to a /groom chat.`, so that
no fire takes it over too. One whose newest `Grooming run` comment is a result
was left by a run that died before its label, and no fire repairs it: naming
it releases it, and this chat first applies the label that result names, with
the command in this step that replaces `state:grooming`, then goes on as with
any issue carrying that label.

Above the pick, one reminder line lists what waits on the owner — unticked
`Owner steps before delivery` boxes in open issues, open issues whose whole
scope is the owner's own action, and issues carrying two `state:` or two
`prio:` labels, which the owner settles — and the issues labelled
`state:grooming`, so that one an abandoned chat or a dead run left is seen,
each named by its newest `Grooming run` comment: a claim is a grooming run's;
a result is a dead grooming run's, which the owner releases by naming the
issue; none, or `released to a /groom chat`, is a chat's — the `Grooming: #…`
chat titles in the sidebar tell the owner which are live, and naming one here
takes it over. Propose the pick alone, with no list of alternatives, and
groom only it; if the owner wants a different one, they name it.

Name the chat after its issues, so the owner can tell grooming chats apart in
the sidebar. As soon as an issue is taken — the pick, or one the owner names —
rename this chat with `mcp__ccd_session_mgmt__set_session_title` and
`session_id: "self"`, loading the tool through `ToolSearch` first. The title,
written in the owner's language, is `Grooming:` and every issue groomed in
this chat so far, in order, each as `#<n>` plus a two-to-four-word name drawn
from the issue title: `Grooming: #71 Body search, #72 Header filter`; in
Russian, `Груминг: #71 Поиск по телу, #72 Фильтр заголовков`. A pick the
owner swaps for another before discussing it is replaced in the title, not
kept. Past about 80 characters, the earliest issues keep only their number,
oldest first, until it fits. If the tool is missing (a
terminal session), declines or fails, carry on without it; after a decline,
leave this chat's title alone.

At the same moment, mark the issue taken so that another grooming chat passes
it over. Re-read its labels first
(`gh issue view <n> --repo R --json number,state,labels`) and choose the
command from what the re-read shows, not from the list. If the pick now
carries `state:grooming` or `state:deferred` — another chat took it, or the
owner put it off, since the list was fetched — or `state:ready`, propose the
next issue instead. Then set the label:

```sh
gh issue edit <n> --repo R --add-label state:grooming --remove-label state:ready,state:needs-owner,state:deferred
```

The same command serves whether the re-read shows no `state:` label,
`state:needs-owner`, or `state:deferred`; this chat remembers which of the two
it replaced. Only an issue the owner named reaches it carrying
`state:deferred`: it is the one case where a deferred issue is taken
knowingly. An issue carrying `state:ready` gets no `state:grooming`, since the
command would remove `state:ready` and drop the issue from the delivery
cycle's candidates; nor does an epic, which carries no `state:` label at all.
`state:grooming` comes off when:

- the owner swaps the pick for another before discussing it:
  `gh issue edit <n> --repo R --remove-label state:grooming`; swapped because
  another chat already holds it, leave the label on, which that chat still
  relies on;
- the owner says `state:ready` (step 5):
  `gh issue edit <n> --repo R --add-label state:ready --remove-label state:grooming,state:needs-owner,state:deferred`;
- the owner sets it aside in this chat, for instance to wait for a design:
  `gh issue edit <n> --repo R --remove-label state:grooming`;
- the owner postpones it ("отложи", "на потом"), the postponing command:
  `gh issue edit <n> --repo R --add-label state:deferred --remove-label state:grooming,state:ready,state:needs-owner`.

Swapped or set aside, an issue that carried `state:deferred` when taken gets
the postponing command instead, unless the owner has put it back in the queue.
One that carried `state:needs-owner` goes back to waiting:
`gh issue edit <n> --repo R --add-label state:needs-owner --remove-label state:grooming,state:ready,state:deferred`.
Made ready or postponed, it takes the commands above, so that it never carries
`state:needs-owner` beside `state:ready` or `state:deferred`.

An issue carrying `state:ready` holds no `state:grooming`; when the owner
postpones one, the postponing command removes `state:ready` with the rest.

## 2. Check it

Read the issue with its comments
(`gh issue view <n> --repo R --json number,title,state,labels,body,comments`,
which carries every comment, oldest first) and the issues it links on its
`Depends on`, `Related:` and `Epic:` lines. For a child of an epic, read the
epic as well — its goal, its out of scope and its other children — since the
child is groomed like any issue but within that frame. Fetch `origin` and
check every factual claim against `origin/main`: files, quoted sentences,
decisions, numbers. Say which claims are inference. Cite code and docs by a
quoted sentence, not a line number.

Check the `## Problem` section that `/create-task` writes: all four lines —
What is wrong, Where it came from, If we do it, If we don't — present and in
plain words. Where it is missing or incomplete, reconstruct it from the issue,
its comments, the issues it links, its epic, its dates and the docs, and mark
each inferred part `(inferred)`.

An issue taken from `state:needs-owner` was groomed by a scheduled run: its
questions, its design directions and its `## Delivery notes` are written
already. Present them (step 3) rather than derive them again, and check what
`origin/main` changed since the SHA its delivery notes name.

Then check what delivery will need:

- **The delivery cycle's gates**: design and acceptance, as
  `.claude/scheduled/delivery-cycle.md` defines them. An issue that fails one
  is not ready.
- **Taken before.** An issue a delivery run already took — its
  `Scheduled run <time>: taken` claim or a `DELIVERED`, `BLOCKED` or
  `RECOVERED` result stands (a `not taken` skip and a grooming run's claim are
  not one) — is never taken by the cycle again (the procedure's double-take
  gate). Make it `delivery:attended`, with the line
  `Attended because: leftover branch from scheduled run <time>`, to finish
  that branch and pull request in an attended session, or file a fresh issue
  for what remains.
- **Design.** A visual change needs an owner-approved design reference for
  each viewport the project supports (`docs/PRODUCT.md`): when `design.figma`
  is true, a Figma frame with a `node-id`; otherwise an image saved under
  `docs/design/` or a written layout in the issue that the owner approved. A
  new screen starts from two or three distinct directions for the owner to
  choose from. A grooming run draws the primary viewport only, so the
  direction the owner picks still needs its other viewports.
- **Version.** When `delivery.versioning` is true, whether it bumps VERSION
  follows `docs/DELIVERY.md`'s version rules;
  `.claude/scripts/check-version.mjs` decides what counts as a runtime path.
- **The owner's part.** An action only the owner takes — a GitHub or hosting
  setting, a secret, a token, a mailbox, a DNS record, a command needing their
  access — goes into a `## Owner steps before delivery` checklist in the
  description, one unticked box per step. The cycle passes the issue over
  until every box is ticked, then delivers it. Prefer this: most issues that
  need the owner become ready for the cycle once the steps are done first.
- **A person present.** One question: does delivery need a person present?
  Only a yes keeps an issue out of the delivery cycle. The owner has little
  time: a person is required only for an important change that cannot be
  delivered safely without them, never "just in case", for convenience, or
  because a change is large or touches the process. When in doubt, the answer
  is no. A person is needed only when the owner watches or checks something
  during or right after deployment, such as a new alert or a backup they must
  see arrive; when a step mid-delivery is one only the owner can run, such as
  granting a permission the deploy job turns out to lack; or when a decision
  is expected mid-way. An action the owner can take before delivery is an
  owner step (above), not a reason for the label. Changing the delivery
  machinery — agent definitions, `.claude/`, the scheduled procedures, CI,
  `docs/DELIVERY.md` — is not by itself a reason. A yes, or an issue a
  delivery run already took (Taken before, above), gets `delivery:attended`,
  and only with a one-line reason in the description, on a line of its own:
  `Attended because: <reason>`. No reason, no label. Propose it, with its
  reason, among the questions of step 3. The cycle never takes it; the owner
  starts it in an attended session.
- **Stable parts.** A change that would break a part `docs/ARCHITECTURE.md`
  declares stable (its section `Stable parts`) is not delivered without the
  owner's word (`docs/DELIVERY.md`). Put it among the questions of step 3,
  naming the part and what would break, and record the answer under
  `Decisions`.
- **Touches.** The areas the change will touch, named from the vocabulary in
  `.claude/delivery-areas.json`, the hard ones included (the file marks them
  `hard`: migrations, the API contract and shared types, dependencies, CI and
  deployment, the delivery process). The delivery cycle runs up to three tasks
  side by side and keeps a task out while one in flight shares a hard area
  with it, so an area left out lets two conflicting tasks run at once; one too
  many only makes a task wait. `node .claude/scripts/delivery-queue.mjs areas
  --files <path>…` maps the files the change will touch onto areas. An issue
  without the section counts as touching every area and waits until nothing
  else is in flight (D16).
- **Size.** A task expected above about 1,000 lines of product code, or made of
  independent parts — frontend, backend and infrastructure, or a feature and
  the hardening of its inputs — is split into separate issues, each its own
  pull request (D20). Propose the split among the questions of step 3: the
  parts, what each leaves observable, and their order. Once the owner agrees,
  file the parts through `/create-task` (`.claude/skills/create-task/SKILL.md`),
  the one others depend on first, each later one with its `Depends on #<n>`
  lines. The original issue then keeps one part, rewritten in step 4, or, when
  the owner prefers, becomes the parts' epic: `type:epic` in place of its
  `type:` label, no `state:` label, its description listing the parts as
  `- [ ] #<n>` lines under `## Children`, each part carrying `Epic: #<n>`. A
  scheduled grooming run, which files no issue, proposes the split among its
  questions.

**Epics.** An epic (`type:epic`, D25) is never groomed for delivery and never
gets `state:ready` or any other `state:` label. When the owner names one, the
chat discusses its breakdown — children missing, too large, in the wrong order
or no longer needed — and the discussion ends in child issues filed through
`/create-task`, each with its `Epic: #<n>` line and its line in the epic's
`## Children`, or in the epic's description rewritten as step 4 does; then the
next issue is proposed.

## 3. Present it

One message, written in the owner's language, its headings too, in this
shape (in Russian: **Суть**, **Контекст**, **Как делаю**, **Вопросы**,
**До ready не хватает**):

- **Gist**: one line.
- **Context**: the owner's context block, from the `## Problem` checked or
  reconstructed in step 2, inference marked: **Problem**, **Where it came
  from**, **If we do it**, **If we don't** (in Russian: **Проблема**,
  **Откуда**, **Если сделаем**, **Если не сделаем**), one or two lines each,
  in plain words, with no file paths or decision numbers. The owner does not
  read issue text; this block is what they read.
- **Approach**: the implementation approach, a few bullets.
- **Questions**: numbered, each with a recommendation; for an issue a
  grooming run prepared, its questions and directions as written.
- **Missing before ready**: unmet gates, owner steps, missing design.

Short; expand only when asked.

## 4. Rewrite the issue

Once the owner has answered, rewrite the description so a session with no
context can deliver it. It opens with `## Problem`, added or refreshed: an
inference the owner confirmed becomes plain fact, any other stays marked
`(inferred)`. Then scope, owner steps if any, the design reference or the
`Design needed` answer, observable acceptance criteria, out of scope,
`## Touches`: one line of area names from `.claude/delivery-areas.json`,
separated by commas, with nothing else on it and a blank line after it —
`api-contract, docs` — since the cycle reads the names up to that blank line
and counts an issue whose section holds any other word as touching every
area, and the `## Delivery notes` a grooming run wrote, with the SHA they were
last checked against. Keep every `Depends on #<n>`, `Related: #<n>` and
`Epic: #<n>` line, each on a line of its own, and add those the discussion
settled. Replace `Questions for the owner` with `Decisions`, each answer
dated. An issue that is to carry `delivery:attended` gets its
`Attended because:` line (step 2); one that loses the label loses the line.

Write the text to a file in the scratchpad with the Write tool, and in a later
call — never in the same parallel batch as that Write, which gives no order —
apply it:

```sh
gh issue edit <n> --repo R --body-file <file>
```

Set `delivery:attended` with `gh issue edit <n> --repo R --add-label delivery:attended`,
remove it with `--remove-label delivery:attended`. On an issue already
carrying `state:ready`, removing `delivery:attended` queues it for the
delivery cycle's next fire and needs no further word from the owner, who
approved the issue already (D18). Tell the owner in one line what changed.

## 5. Ready

`state:ready`, `state:deferred` and `prio:*` are the owner's. Set
`state:ready` only when the owner says so explicitly in this turn. Agreeing an
approach, or "делай" about a backlog item, is not that word: ask. The one
exception is the scheduled grooming's narrow class (D14), and it is a
grooming run's, never this chat's: releasing a dead run's issue only applies
the label its result names (step 1). Re-check step 2 against freshly fetched
`origin/main` before setting it, updating the SHA of any `## Delivery notes`;
set it with the command in step 1, which also removes `state:grooming` and
any other `state:` label. The label never starts a delivery in this session:
the delivery cycle takes it, or, for `delivery:attended`, the owner starts it
in an attended session. `state:deferred` is set or removed only on the owner's
word too (step 1), and `prio:*` only on the owner's explicit word, with the
other `prio:` labels removed in the same command:
`gh issue edit <n> --repo R --add-label prio:<p> --remove-label <the other two prio: labels>`.

Once this issue is settled — labelled `state:ready`, set aside by the owner
(for instance, to wait for a design), postponed, or, for an epic, its
breakdown filed — propose the next one in the same order, passing over any the
owner set aside in this session: again a single issue. Once it is taken, add
it to the chat title and label it (step 1).
