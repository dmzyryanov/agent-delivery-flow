# Unattended scheduled grooming run

## What this is

The scheduled grooming fires every 15 minutes, around the clock, on the cron
`schedule.grooming` in `.claude/flow.json` (default `7,22,37,52 * * * *`), in
the machine's local time. Two schedulers can fire it, and both run this same
file (D17, `docs/tooling/scheduled-fires.md`):

- **The desktop app's scheduled task** `<repo-name>-grooming`, the default,
  which `/flow-init` creates with the main checkout as its folder. Its prompt
  first runs `node .claude/scripts/fire-check.mjs grooming` and ends on a
  `skip:` line; otherwise it reads this file and follows it exactly.
- **The launchd job** `dev.agent-flow.<repo-name>.grooming`, the optional
  cheaper path: `.claude/scripts/scheduled-fire.sh grooming` runs the same
  check, which spends no tokens, and only when it finds work opens a fresh
  headless session (`claude -p`, `--effort medium`) in the main checkout.
  Its whole prompt is a pointer:

  ```text
  Read <main checkout>/.claude/scheduled/grooming.md and follow it exactly.
  ```

The check, `.claude/scripts/fire-check.mjs`, only reads. It finds work in the
morning fire's notification, in an earlier run's claim two hours old (stop
condition (b)), or, while fewer than ten issues wait for the owner, in a
candidate the owner has not seen (stop condition (c), Selecting the issue).
The job is the delivery cycle's twin (`.claude/scheduled/delivery-cycle.md`,
What this is): the same program, the same log and the same working folder.

Runs are strictly one at a time. Under launchd the job's lock is held until
the run's process ends, so a fire is skipped while a run of it has not ended.
Under either scheduler this run still recognises an earlier one from GitHub,
by its claim (stop condition (b)), since a run whose job was stopped, whose
lock was taken over, or which the other scheduler started can still be
working. Fires of the two procedures run side by side, so a grooming run never
holds back a fire of the delivery cycle. The cron keeps off the delivery
cycle's minutes, :00 and :30, so that the two rarely fetch in the main
checkout at the same moment; there is no other guard.

A fire grooms **one issue**, strictly one at a time, the way `/groom` does with
the owner (`.claude/skills/groom/SKILL.md`), and leaves it either ready for the
delivery cycle or waiting for the owner with the questions and the design
directions already prepared. With nothing to groom it ends at once. Nobody
answers a question during the run: what needs the owner goes into the issue.
The decision and its reasons are D14 in `docs/DECISIONS.md`.

## Authority

The owner's decision that put this procedure in force (D14). A fire may, on
issues of the GitHub repository `project.repo` only: rewrite one issue's
description, comment on it, set and remove `state:grooming` on it, set
`state:needs-owner`, set `delivery:attended` with its `Attended because:`
line (Grooming it), and set `state:ready` on an issue of the narrow class
under Outcomes and on no other. GitHub labels are not exclusive, so each of
those `state:` changes names the other `state:` labels in `--remove-label` in
the same `gh issue edit`, and no issue is left carrying two (D22). When
`design.figma` is true it may draw new pages in the project's Figma file. It
never sets or removes `prio:*`, never sets `state:deferred` or takes it off an
issue that carries it (the re-reads before every label change make sure of
that), never closes, files, transfers or labels an issue other than the one it
took, and never changes the repository: it creates no branch, worktree, commit
or pull request and leaves the main checkout's branch and files as they were.
Its only writes to disk are in the session's own scratchpad directory.

## Start

1. Work from the main checkout, the folder the scheduled task runs in
   (`docs/RESOURCES.md`).
2. Record the fire time: `date '+%Y-%m-%d %H:%M:%S %z'`, which prints, for
   instance, `2026-10-10 03:22:10 +0300`. Every comment, the final message and
   the stop conditions below use it. The offset is numeric so that
   `fire-check.mjs` reads the time of a run line in any time zone.
3. Read the configuration, one value per command:

   ```sh
   node .claude/scripts/flow-config.mjs project.repo
   node .claude/scripts/flow-config.mjs project.name
   node .claude/scripts/flow-config.mjs project.ownerLanguage
   node .claude/scripts/flow-config.mjs design.figma
   node .claude/scripts/flow-config.mjs delivery.versioning
   node .claude/scripts/flow-config.mjs schedule.morningFire
   ```

   `<R>` below is the first value, `owner/name`, written out in every `gh`
   command as `--repo <R>` or in the `repos/<R>/` path: a command carries no
   `$(…)` and no variable, so each one matches its rule under Permissions. A
   value that cannot be read, or a `project.repo` that is not `owner/name`, is
   stop condition (a).
4. Note the scratchpad: the `/private/tmp/claude-<uid>/…/scratchpad` path the
   system prompt names (`/tmp/claude-<uid>/…` on Linux), or, in a headless run
   whose system prompt names none, the one a desktop session would be given:
   `echo "$UID $CLAUDE_CODE_SESSION_ID"` prints the uid and the session id, and
   the scratchpad is
   `/private/tmp/claude-<uid>/<the main checkout's absolute path, every character other than a letter or digit replaced by ->/<session id>/scratchpad`.
   Claude Code makes the directory above `scratchpad` for the session; the
   scratchpad itself is made by the run's first file written there with the
   Write tool, `session.txt` holding the fire time, before the export below
   needs it. Every file this run writes goes there, and the sub-agents' briefs
   name it.

## Stop conditions

Checked in this order. On the first that holds, do nothing further — no
comment, no label — and end with the final message (End of run).

**(a) GitHub, the remote or the configuration is unavailable.**
`gh auth status` fails, Start step 3 fails, or a command before the take below
fails for want of GitHub or `origin`. Nothing has been changed yet, and the
next fire tries again.

The morning notification (below) comes here, on the one morning fire, before
(b) and (c): it is that fire's duty whatever the rest of the run finds.

**(b) An earlier grooming run is still working.** List the issues it could be
holding:

```sh
gh issue list --repo <R> --state open --label state:grooming --limit 200 --json number,labels --jq '.[] | "#\(.number) \([.labels[].name] | join(" "))"'
```

and read each one's run lines — every comment that opens a scheduled delivery
run's or a grooming run's result, its first line cut at its first full stop:

```sh
gh api --method GET repos/<R>/issues/<n>/comments --paginate --jq '.[] | select((.body // "") | test("^(Scheduled|Grooming) run ")) | "\(.created_at) \(.body | split("\n")[0] | split(".")[0])"'
```

It prints one line per such comment, oldest first, with the comment's
creation time; the newest is the last. Exit status 0 with no output means no
such comment. Any other exit status is a failure — `gh` prints the HTTP error
or the network failure on stderr — and is stop condition (a), not "no line".
This holds wherever this command is used before the take, its re-read
included; at the end of the run (No overwrite), a failure of it means the run
writes nothing further and leaves its claim, as a run that cannot write at all
does.

An issue whose newest `Grooming run` line is a take claim,
`Grooming run <fire time>: taken`, holds an earlier run that has not posted
its result. If that claim's fire time is less than two hours before this
fire's, the earlier run is still working: end. If it is two hours or more,
that run died, and when no claim is younger, this fire takes that issue over
(Taking the issue) instead of selecting one; of two such issues, the one whose
claim is oldest. An issue carrying `state:grooming` whose newest
`Grooming run` line is a result was left by a run that died between its
result comment and its label: no fire repairs it, it stops nothing and is not
a candidate, and `/groom` names it to the owner. One with no such line, or
with `released to a /groom chat` newest, is held by a `/groom` chat; it stops
nothing and is not a candidate.

An issue that carries two or more `state:` labels is a fault, not either state
(D22): a fresh claim on it still means an earlier run is working, but no fire
takes it over or selects it; the final message names it, and `/groom` names it
to the owner, who settles it.

**(c) The owner has enough to answer, or there is no candidate.** 10 or more
open issues carry `state:needs-owner`, counted by

```sh
gh issue list --repo <R> --state open --label state:needs-owner --limit 200 --json number --jq length
```

so a run would only add to what already waits for the owner (D17). Or no open
issue is a candidate (Selecting the issue). Stop condition (b) comes first: an
earlier run's claim two hours old is taken over whatever this one counts.

## Selecting the issue

```sh
gh issue list --repo <R> --state open --limit 200 --json number,labels,body --jq '.[] | "#\(.number) \([.labels[].name] | join(" ")) \([(.body // "") | scan("(?:Depends on|Epic:) [^\\n]*")] | join(" "))"'
```

prints one line per open issue: its number, its labels and the
`Depends on #<n>` and `Epic: #<n>` lines of its description. Candidates are
the issues that carry none of `state:ready`, `state:grooming`,
`state:deferred` and `state:needs-owner`, are not labelled `type:epic`, and
the owner has not seen yet (D17). An epic is a container `/decompose` made
(D25): it is groomed and delivered through its children, never itself, and
the scheduled grooming never takes it. A child of an epic, an issue with an
`Epic: #<n>` line, is a candidate like any other. The owner has seen an issue
that has any of:

- a comment whose run line (the command in (b)) is a grooming run's result,
  `Grooming run <time>: ready without the owner` or
  `Grooming run <time>: waits for the owner`;
- a comment whose run line is a `/groom` chat's release,
  `Grooming run <time>: released to a /groom chat`;
- a label event that ever added `state:grooming`, which only a grooming run
  or a `/groom` chat sets: a line printed by

  ```sh
  gh api --method GET repos/<R>/issues/<n>/events --paginate --jq '.[] | select(.event == "labeled" and .label.name == "state:grooming") | .created_at'
  ```

  As with the command in (b), an exit status other than 0 is stop
  condition (a).

An issue the owner has seen is theirs to settle, in a `/groom` chat; the
scheduled grooming leaves it. The unseen candidates are taken in `/groom`'s
order:

1. Returned by the delivery cycle: its newest `Scheduled run` line (the command
   in (b)) is a `not taken` skip.
2. Every other candidate by priority: `prio:1`, `prio:2`, `prio:3`, then
   none; within one priority, an issue another open issue names in a
   `Depends on` line first, then the smaller number. An issue with more than
   one `prio:` label is a fault the final message names (D22); for the order
   it counts at its highest.

## The tree it checks against

Every claim an issue makes is checked against freshly fetched `origin/main`
(the main branch is `project.mainBranch`), not against the main checkout,
which can lag behind it. The sub-agents read files and the architect has no
shell, so the run puts `origin/main` on disk where both can read it, in the
session's own scratchpad (Start step 4):

```sh
git fetch origin
sh .claude/scripts/export-origin-main.sh <scratchpad>
```

The script writes `<scratchpad>/origin-main/`, the tree of `origin/main`, and
prints the SHA it was taken at, which the claim and the delivery notes record.
It takes exactly one directory and refuses one that does not resolve under
`/private/tmp/claude-` (or `/tmp/claude-`) or already holds `origin-main`; a
refusal or failure exits non-zero with one line saying why, and on the fire's
one export the run then ends as under (a). An export rather than a worktree: a
fire creates none (Authority), and one would be a tree the delivery queue does
not know, which no fire removes (D3, D16); moving the main checkout to
`origin/main` would change the owner's tree. The fetch only moves `origin/*`;
one that fails, another fire's git lock included, is (a) as well, and the next
fire tries again. Both run once there is an issue to take — a candidate, or one
to take over at (b) — and before its claim, which names the SHA, so a fetch
that fails leaves the issue untouched (a). They run once per fire: when the
take's re-read passes over a candidate, the next one is checked against the
same export and SHA. A second export would be refused with `already exists`,
which is not stop condition (a): the run reuses the first.

The process texts this run follows — the `/groom` skill, the delivery cycle's
gates, `docs/DELIVERY.md` — are read from the main checkout, as this file is;
the code and documents an issue is checked against are read in the export.

## Taking the issue

Re-read the first candidate just before taking it: its labels,
`gh issue view <n> --repo <R> --json number,title,state,labels,body,comments`,
and its run lines (the command in (b)). If it has meanwhile gained
`state:ready`, `state:grooming`, `state:deferred`, `state:needs-owner` or
`type:epic`, or its newest `Grooming run` line is a take claim under two hours
old — a run between its claim and its label, or one whose label failed — take
the next candidate instead. An issue taken over at (b) skips the selection,
and its re-read must still show `state:grooming`, no other `state:` label, and
the same old claim as its newest `Grooming run` line; if it does not, the fire
takes nothing over and goes on to Selecting the issue. Then, comment first, as
the delivery cycle comments before it changes a label, so that the claim
stands before the label that makes stop condition (b) read it:

```sh
gh issue comment <n> --repo <R> --body-file <scratchpad>/claim-<n>.md
gh issue edit <n> --repo <R> --add-label state:grooming --remove-label state:ready,state:needs-owner,state:deferred
```

The `--remove-label` part acts on nothing here, since the re-read just showed
none of those labels; it is there so that no `state:` change ever leaves two.
If the label command fails after the claim, the run ends there without
grooming and leaves the claim; fires pass the issue over until the claim is
two hours old.

The claim, in the file:

```text
Grooming run 2026-10-10 03:22:10 +0300: taken by the scheduled grooming
(`.claude/scheduled/grooming.md`), checked against `origin/main` at `<sha>`. A
result comment follows on this issue.
```

An issue taken over from a run that died already carries `state:grooming`;
it gets only the claim, which names the run it replaces:

```text
Grooming run 2026-10-10 05:37:10 +0300: taken over from the grooming run of
2026-10-10 03:22:10 +0300, whose claim is over two hours old with no result.
Checked against `origin/main` at `<sha>`. A result comment follows.
```

Every comment and description in this file is written to a file in the
scratchpad with the Write tool and sent with `--body-file <file>`, never inside
a quoted shell argument, where backticks would run as commands. The `gh`
command that sends a file runs in a later call than the Write that made it,
never in the same parallel batch: a batch gives no order, and the command
could send an old file or none. A comment's opening, `Grooming run` with its
fire time and the outcome's words, stays on one line, as in the templates,
since the run lines are read from it. Check the exit code of every write.

Then record a checksum of the description as it is now, for the no-overwrite
rule:

```sh
gh issue view <n> --repo <R> --json body --jq '(.body // "") | explode | reduce .[] as $c (0; (. * 31 + $c) % 1000000007)'
```

## Grooming it

Read the issue in full:
`gh issue view <n> --repo <R> --json number,title,state,labels,body,comments`,
which carries every comment, oldest first, and the issues it links on its
`Depends on`, `Related:` and `Epic:` lines. For a child of an epic, read the
epic as well: its goal, its out of scope and its other children, which are
the first places to look for overlap. Then do what `/groom` steps 2 and 4 say,
against the export: every factual claim checked, `## Problem` complete with
its four lines and inference marked `(inferred)`, scope,
`## Owner steps before delivery` or none, the design reference or
`Design needed`, observable acceptance criteria, out of scope, `## Touches`
(below), the delivery cycle's gates (`.claude/scheduled/delivery-cycle.md`,
Selecting the issue), the version, when `delivery.versioning` is true, by
`docs/DELIVERY.md` and `.claude/scripts/check-version.mjs`, which decides what
counts as a runtime path, and whether the issue gets `delivery:attended`
(A person present, below). Keep every requirement, decision, link, dated
answer and `Depends on`, `Related:` or `Epic:` line the issue already carries;
what the run infers is marked as inferred, and what only the owner can settle
becomes a question.

**A person present.** The run asks what `/groom` step 2 asks: does delivery
need a person present? Only a yes keeps an issue out of the delivery cycle. The
owner has little time: a person is required only for an important change that
cannot be delivered safely without them, never "just in case", for
convenience, or because a change is large or touches the process. When in
doubt, the answer is no — and a run, which has nobody to ask, is in doubt
whenever the issue does not show the need. A person is needed only when the
owner watches or checks something during or right after deployment, such as a
new alert or a backup they must see arrive; when a step mid-delivery is one
only the owner can run, such as granting a permission the deploy job turns out
to lack; or when a decision is expected mid-way. An action the owner can take
before delivery is a box of the `## Owner steps before delivery` checklist,
not a reason for the label. Changing the delivery machinery — `.claude/`, the
scheduled procedures, CI under `.github/`, `docs/DELIVERY.md` — is not by
itself a reason. One more case gets the label: a delivery run already took the
issue — its `Scheduled run <time>: taken` claim or a `DELIVERED`, `BLOCKED` or
`RECOVERED` result stands (a `not taken` skip and a grooming run's claim are
not one) — so the double-take gate never takes it again, and its leftover
branch and pull request are finished in an attended session, with the reason
`Attended because: leftover branch from scheduled run <time>`. Either way the
description the run writes carries the reason, one line of its own:
`Attended because: <reason>`. No reason, no label.

**Stable parts.** A change that would break a part `docs/ARCHITECTURE.md`
declares stable (its section `Stable parts`) is not delivered without the
owner's word (`docs/DELIVERY.md`). The run cannot give that word: such an
issue waits for the owner, the question naming the part and what would break.

Two sub-agents look at it, `architect` and `tester-look`, started together,
each with its template below filled in and invoked without a `model`
parameter (D8). `tester-look` is the tester's planning look in a definition
of its own, on the model and effort that definition names (D21); `tester`,
or `tester-process` for the pull requests `docs/DELIVERY.md` step 4 routes to
it, verifies a delivery. If `tester-look` is not available in the session,
`tester` gives the look from the same template. `developer` takes no part: it
holds the write tools, and grooming writes nothing to the repository. No
designer or analyst agent exists; this session draws and writes.

`tester-look` holds no Bash, but `tester`, which gives the look when
`tester-look` is not available, does, so the check that makes the look's "no
Bash" more than a contract stays (D14): immediately before starting the two
looks, and again after both return, the run reads the main checkout's
fingerprint

```sh
sh .claude/scripts/tree-fingerprint.sh <main checkout>
```

and compares the two readings itself. A mismatch, or a reading that fails, is
named in the result comment and the final message, the run touches nothing in
the checkout, and the issue waits for the owner.

The architect's look:

```text
Grooming look at issue #<n> for the scheduled grooming run
(.claude/scheduled/grooming.md). Read the tree at <scratchpad>/origin-main/,
which is origin/main at <sha>, not the main checkout.

The issue, verbatim, with the comments that add to it:
<description and comments>

Its epic, if it has one, and that epic's other children:
<the epic's description, or "none">

Other open issues: <the listing of Selecting the issue>

Answer briefly: the approach in a few lines; the files, functions and tests to
change and the documents to update (docs/PRODUCT.md, docs/ARCHITECTURE.md,
docs/DECISIONS.md and the entries amended, any other under docs/), each file
by its path from the repository root; the version bump and why, or "not
versioned"; whether it breaks a part docs/ARCHITECTURE.md lists under Stable
parts; the size, and whether it fits one pull request or should be split, and
how; the risks and what the delivery will have to decide; the dependencies on
and overlap with other open or ready issues, by number.
```

The tester's look, planning only, given to `tester-look`:

```text
Grooming look at issue #<n> for the scheduled grooming run
(.claude/scheduled/grooming.md). Planning only: read the tree at
<scratchpad>/origin-main/, which is origin/main at <sha>, with Read, Grep and
Glob. No worktree, no test run, no database, no port, no browser, no Bash.

The issue, verbatim, with the comments that add to it:
<description and comments>

Answer: the observable acceptance criteria, each with how it is checked (the
test file or command, a browser check, a deployed check); the verification the
delivery needs (suites by the commands in .claude/flow.json, browser, deployed
check, outside review where docs/DELIVERY.md step 4 requires it); and, for an
issue about limits, about input the project does not control (a parser, an
external interface, a file or request from outside) or about redaction, the
attack list: each hostile shape the issue covers and each it leaves out, named.
```

A look that does not come back is named in the delivery notes, and the run
goes on with what it has; an issue the run cannot judge without it waits for
the owner.

**Design.** A visual change gets two or three distinct directions for the
owner to choose from. When `design.figma` is true, they are drawn in Figma,
for the project's primary viewport only (desktop, 1440 px wide, unless
`docs/PRODUCT.md` names another), on a new page of the project's Figma file
(`docs/RESOURCES.md`, Design) named
`<project.name> · <short name> (#<n>) — directions`, one row per direction,
labelled A, B and C, in the approved pages' styles; an existing page is never
changed. The Figma write tools are loaded with `ToolSearch`, and the Figma
skill the client provides is read before the first write. The issue cites
each direction by its frame's `node-id` link in `## Questions for the owner`,
with a recommendation; the other viewports' frames follow the owner's pick. A
Figma tool that is missing or refused ends the drawing: the question then says
what to draw — the screen, its states and the directions the run would have
tried. When `design.figma` is false, the directions are written: for each, the
layout, its states and what sets it apart, in a few lines under
`## Questions for the owner`, with a recommendation; the owner's pick, or an
image the owner saves under `docs/design/`, becomes the design reference.
Either way the issue waits for the owner.

**Touches.** Every groomed description carries `## Touches` as `/groom` step 4
writes it, which the delivery cycle's pick reads (D16): one line of area names
from the vocabulary `.claude/delivery-areas.json`, separated by commas, with
nothing else on it and a blank line after it — `api-contract, docs` — the
hard areas included. The areas follow from the files the architect names, the
documents included, mapped by the queue's own globs, run from the main
checkout:

```sh
node .claude/scripts/delivery-queue.mjs areas --files <path>…
```

which prints each file's areas and, on its last line, `areas:` and all of
them; it reads the vocabulary and changes nothing, and it is the one queue
command this run uses. An area the issue plainly touches that no named file
shows — a migration it calls for, a dependency it adds — is added by its name
in the vocabulary. In doubt, add the area: one left out lets two conflicting
tasks run at once, one too many only makes a task wait, and a section holding
any other word counts as touching every area.

**Delivery notes.** Every groomed description carries this section, before
`## Questions for the owner` when there is one:

```text
## Delivery notes

Checked against `origin/main` at `<sha>` by the grooming run of <fire time>.
A starting point for the delivery, checked again there, not a contract.

- Approach: <a few lines>
- Files, functions, tests: <...>
- Documents: <PRODUCT, ARCHITECTURE, DECISIONS and the entries amended, others>
- Version: <bump or unchanged, and why; or "not versioned">
- Attack list: <each hostile shape covered and left out, or "takes no input the project does not control">
- Overlap: <other open or ready issues, the epic's other children among them, by number, or none>
- Verification: <suites, browser check, deployed check, outside review>
- Size: <small, medium or large; a proposed split, if any>
- Remarks: <this run's own, as the main checker>
```

**Questions for the owner.** An issue that waits for the owner ends in
`## Questions for the owner`: numbered, each with its options and a
recommendation, answerable in a word, and/or the design directions to choose
from. A split (`/groom` step 2, Size) is proposed here as well, with the parts
and their `Depends on` order: the run files no issue, and `/groom` files the
parts through `/create-task` once the owner agrees.

## Outcomes

Every fire that took an issue ends in exactly one of two outcomes, recorded
with a comment that opens `Grooming run <fire time>:`, and leaves the issue
carrying `state:ready` or `state:needs-owner` and no other `state:` label —
unless someone settled it meanwhile (No overwrite).

**Ready without the owner.** Only an issue that is all of: `type:bug` or
`type:chore`; small, in one area, needing no new entry in DECISIONS; invisible
to a user of the product — tests, internal scripts, internal alerts,
documentation — so it changes no UI, no interface or contract others rely on
(nothing under `Stable parts` in `docs/ARCHITECTURE.md`), no behaviour a user
meets, no stored data, no security or privacy behaviour and no paid service;
not the delivery machinery (`.claude/`, CI under `.github/`, `CLAUDE.md`,
`docs/DELIVERY.md`, the scheduled procedures) and not `delivery:attended`; no
owner steps; no design; no comment from an earlier scheduled run (`taken`,
`DELIVERED`, `BLOCKED`, `RECOVERED`) and no earlier `ready without the owner`
comment. A bug fix that changes how the product behaves for a user is not in
this class.

An earlier scheduled run's comment there is a delivery run's line (D16): its
claim `Scheduled run <time>: taken` (a `not taken` skip is not one) or a
`DELIVERED`, `BLOCKED` or `RECOVERED` result. A grooming run's claim is not
one. **Never again:** a fire never sets `state:ready` on an issue that carries
an earlier `ready without the owner` comment — the owner undid that ready by
removing the label — and that issue goes to the owner instead. Where it is
unclear whether the issue is in the class, it is not.

**Waits for the owner.** Every other issue.

**No overwrite.** Just before writing, run the checksum command of Taking the
issue again, re-read the labels with
`gh issue view <n> --repo <R> --json number,title,state,labels,body,comments`,
and read the run lines (the command in (b)). A checksum other than the one
recorded at the take means someone changed the description while this run
worked: the run does not replace it, posts the groomed description inside its
result comment instead, and the issue waits for the owner, since what was
groomed is no longer what the issue says. Labels that no longer show
`state:grooming`, or that show `state:ready`, `state:needs-owner` or
`state:deferred`, mean the owner or a `/groom` chat settled the issue
meanwhile: post the result as a comment and change no label. A newest
`Grooming run` line that is not this run's own claim — `released to a /groom
chat` posted by a chat, or another run's claim or result — means the issue is
no longer this run's: it leaves the description, posts its result as a comment
and changes no label. When the labels or the run lines show the issue is no
longer this run's, it changes no label, whatever the checksum says.

Otherwise, in this order — description, comment, labels, so that a run dying
in between leaves the result where a later fire and the owner read it:

```sh
gh issue edit <n> --repo <R> --body-file <scratchpad>/description-<n>.md
gh issue comment <n> --repo <R> --body-file <scratchpad>/result-<n>.md
```

then the outcome's label, which replaces `state:grooming` and names every
other `state:` label it must not leave beside it — for ready without the
owner, for waits for the owner, and for waits for the owner where
**A person present** (Grooming it) calls for `delivery:attended`, its
`Attended because:` line in the description just written:

```sh
gh issue edit <n> --repo <R> --add-label state:ready --remove-label state:grooming,state:needs-owner,state:deferred
gh issue edit <n> --repo <R> --add-label state:needs-owner --remove-label state:grooming,state:ready,state:deferred
gh issue edit <n> --repo <R> --add-label state:needs-owner,delivery:attended --remove-label state:grooming,state:ready,state:deferred
```

If the label command fails, run it once more. A second failure leaves the
issue as a run that died after its result comment leaves it: `state:grooming`
stays for the owner (stop condition (b)), and the final message names it. A
run that cannot write at all leaves its claim, and a fire two hours later
takes the issue over.

```text
Grooming run 2026-10-10 03:22:10 +0300: ready without the owner. <Why it is in
the class, condition by condition, in a sentence or two.> The description now
carries `## Delivery notes`, checked against `origin/main` at `<sha>`.
`state:ready` is set, so the delivery cycle may deliver it; removing the
label undoes this, and no grooming run sets it on this issue again.
```

```text
Grooming run 2026-10-10 03:22:10 +0300: waits for the owner. <What needs the
owner: which condition of the class it fails, the questions, the directions.>
The description now ends in `## Questions for the owner` and carries
`## Delivery notes`, checked against `origin/main` at `<sha>`.
`state:needs-owner` is set; `/groom` proposes it first.
```

Anything that stops the grooming after the take — a sub-agent the run cannot
do without, a gate it cannot settle, a Figma tool refused, a fingerprint that
moved — ends in the second outcome, the comment naming what stopped it.

## Morning notification

On the morning fire — the fire whose clock reads from `schedule.morningFire`
(default `09:07`) to 14 minutes after it; with a fire every 15 minutes and
`schedule.morningFire` one of the cron's minutes, exactly one fire falls in
that range — and on no other, the run sends one `PushNotification`, in
`project.ownerLanguage`, before stop conditions (b) and (c). It counts since
the whole hour of `schedule.morningFire` the previous day — 09:00 for
`09:07` — the bound `/groom` uses. In UTC, with `<H>` that hour:

```sh
date -v-1d -v<H>H -v0M -v0S '+%s'
date -u -r <seconds> '+%Y-%m-%dT%H:%M:%SZ'
```

the first printing the bound in seconds, the second the bound to compare with.

- the issues that became ready on their own: among the issues updated since
  the bound,
  `gh issue list --repo <R> --state all --search "sort:updated-desc" --limit 200 --json number,updatedAt --jq '.[] | select(.updatedAt >= "<bound>") | .number'`,
  those with a `Grooming run <fire time>: ready without the owner` comment
  created since the bound, read through the paginated comments API, which
  prints the creation time of each such comment:
  `gh api --method GET repos/<R>/issues/<n>/comments --paginate --jq '.[] | select((.body // "") | test("^Grooming run [^.\\n]*: ready without the owner")) | .created_at'`;
- the open issues waiting for the owner:
  `gh issue list --repo <R> --state open --label state:needs-owner --limit 200 --json number --jq '.[].number'`.

Written in the owner's language; in English:

```text
Grooming, morning: ready on their own in the last day — 2 (#57, #61); waiting for you — 3 (#12, #30, #44). Review: /groom.
```

and in Russian, for example:

```text
Груминг, утро: сами стали ready за сутки — 2 (#57, #61); ждут тебя — 3 (#12, #30, #44). Разбор: /groom.
```

Zero is said as zero. If GitHub cannot be read, no notification is sent. A
morning the machine slept through sends none: a catch-up fire outside the
range is not the morning fire. Nor does a morning whose fire was skipped
because the previous grooming run had not ended: nothing makes that
notification up. `PushNotification` is a tool, loaded with `ToolSearch` when
it is deferred; an answer that it was not sent is not a failure.

Whether `PushNotification` reaches the owner from a headless run is not
measured (D17), so under launchd, when the morning run ends, the job also
shows its final chat message as a macOS notification. On this fire that
message therefore opens with the notification's line above, whatever else the
run did, before the line End of run gives.

## End of run

The final chat message, one or two lines, written in the owner's language,
`project.ownerLanguage`; in English:

```text
Grooming 03:22 — #57 became ready on its own: <what the task is, in a few words>.
```

```text
Grooming 03:22 — #57 waits for you: 2 questions and 3 design directions, review in /groom.
```

When a stop condition held, it names it: `Grooming 10:22 — GitHub is
unreachable, did nothing.`, `Grooming 10:37 — grooming of #57 still running
(since 10:22), did nothing.`, `Grooming 10:52 — 12 issues wait for you, taking
no new one.` or `Grooming 10:52 — nothing to groom.` A fault the run found —
an issue with two `state:` or two `prio:` labels, a label command that failed
twice — is named after it: `Fault: #41 has two state: labels.`

On the morning fire the message opens with the morning notification's line
(Morning notification).

Issue comments are in English, as the issues are.

## Permissions

The session runs in Auto mode: the launchd job passes `--permission-mode auto`
(D17), and the desktop app's task runs in the mode the app gives its
scheduled tasks, as the delivery cycle's Permissions section describes. Every command this
procedure runs is allowlisted in `.claude/settings.json`, apart from the
read-only built-ins (`cd`, `echo`, `grep` and the rest, as the delivery cycle
lists them); the block below is what it uses. Nothing under
`permissions.ask` is needed, and a command outside the block and the built-ins
is not run. `PushNotification`, `ToolSearch` and the sub-agents are tools, not
Bash commands. The Figma write tools are not allowlisted: Auto decides on
each, and a refusal is handled under Design. A change to this procedure that
adds a command adds its rule to `.claude/settings.json` and to this block in
the same pull request, and every command this procedure pins must pass the
Bash guard (`.claude/scripts/guard-bash.mjs`, D9, D16). The queue's rule
covers its every command; this run uses `areas --files` alone and no other.
`gh issue edit` is allowed whole, as `gh issue comment` is: what the run may
change with it is the Authority above, not the rule.

No rule grants `git archive` or `tar`, whose options run other programs or
write anywhere: the export is the one script under its own rule, and the
script's checks keep it to a directory under `/private/tmp/claude-` or
`/tmp/claude-`.

```text
Bash(date *)
Bash(git fetch origin)
Bash(sh .claude/scripts/export-origin-main.sh *)
Bash(sh .claude/scripts/tree-fingerprint.sh *)
Bash(node .claude/scripts/flow-config.mjs *)
Bash(gh auth status)
Bash(gh issue list *)
Bash(gh issue view *)
Bash(gh issue edit *)
Bash(gh issue comment *)
Bash(gh api --method GET repos/*)
Bash(node .claude/scripts/delivery-queue.mjs *)
```
