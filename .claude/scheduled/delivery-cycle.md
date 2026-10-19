# The delivery cycle

## What this is

A scheduled job on the operator's machine fires this procedure on the cron
`schedule.cycle` in `.claude/flow.json` — every 30 minutes unless changed,
`*/30 * * * *`, in the machine's local time — around the clock: there is no
night window, and a catch-up fire is an ordinary fire. Two schedulers can fire
it, both after `.claude/scripts/fire-check.mjs cycle` has answered `work:`,
and exactly one of them is enabled, since two would fire every procedure
twice (D17, `docs/tooling/scheduled-fires.md`):

- **A scheduled task of the Claude desktop app**, the default, which
  `/flow-init` creates. Its working folder is the main checkout and its
  isolated-worktree toggle is off: the toggle would start the session in a
  worktree the app manages, while the checks below expect the main checkout
  on the main branch and every task creates its own worktrees outside the
  repository (D3). Its prompt asks the check first and points here only on
  work:

  ```text
  In <checkout>, run `node .claude/scripts/fire-check.mjs cycle`. If it prints
  a line beginning `skip:`, end the run with that line. Otherwise read
  <checkout>/.claude/scheduled/delivery-cycle.md and follow it exactly.
  ```

  A fire with nothing to do still opens a session and costs its first turn.
  The app fires only while it is running.

- **A launchd job**, `dev.agent-flow.<repo-name>.cycle`, the optional cheaper
  path on a Mac. Its program is `.claude/scripts/scheduled-fire.sh`, installed
  with its plist by `.claude/scripts/launchd/install.sh`. It runs the check
  itself and, only on work, opens a fresh headless session — `claude -p` with
  the model and effort the script names and `--permission-mode auto`, in a
  clean environment, in the main checkout — whose whole prompt is a pointer:

  ```text
  Read <checkout>/.claude/scheduled/delivery-cycle.md and follow it exactly.
  ```

  A fire with nothing to do costs the check and one line in
  `~/Library/Logs/agent-flow/<repo-name>/fires.log`, and no session.

Either way the procedure itself is versioned, reviewed and changed through
pull requests like everything else in this repository. The check only reads:
it answers `work:` when Resume first below would take a task, or when `pick`
offers a ready issue that the owner-steps and double-take gates below would
not pass over at once — and, with work, only when GitHub, the remote and,
where the project needs it, Docker answer. The session does not rely on the
check: it makes every check and gate below itself.

Facts about when a session actually opens, none of which a fire's session can
check for itself (D16, D17):

- the desktop app starts a fire a fixed offset after its time, so 14:30 is
  read on the clock as 14:31 or thereabouts; launchd starts the job at its
  minute and the check takes seconds, so 14:30 reads as 14:30 or a minute
  after;
- a fire is skipped, not queued, while a run of the same task or job is
  inside its first turn — the launchd job's lock is held until the run's
  stream shows its first `result` line, and a fire that finds it held writes
  a skip line. A run that has ended its turn and waits for background work —
  its sub-agents, a background command — does not hold fires back, so several
  runs are in flight at once, and a skipped fire costs at most the time to
  the next one;
- a run that ends its turn with a sub-agent still working lives on, is woken
  with the sub-agent's notification and exits once every background task has
  finished, its transcripts written under `~/.claude/projects/`, where the
  queue reads liveness;
- the cycle and the grooming (`.claude/scheduled/grooming.md`) fire
  independently and run side by side;
- a fire whose time the machine slept through: the desktop app opens one
  catch-up run for the most recently missed time within the last seven days,
  on its next start or wake; launchd runs it once on wake, folding the missed
  times into one; a machine switched off runs none.

So a run's own long waits are made in the background wherever the tool
allows — a sub-agent started to run in the background, a Bash call with
`run_in_background: true` — and the run ends its turn while it waits, so the
next fire is not skipped.

Several tasks are in flight at once, each in the session of the fire that took
it, and they share the main checkout, Docker where the project uses it, and
the plan's limits; each task's suite runs on test resources of its own (The
queue). What they must not do at once — take the same slot, merge, deploy,
reserve the same decision id — is decided by the delivery queue
(`.claude/scripts/delivery-queue.mjs`, below), not by agreement between them.

The session that runs this has no context and nobody to ask: the owner may be
busy or asleep, a permission prompt is answered hours later at best, and a
question asked at 03:00 costs a night. Everything below is written for that.

## Authority

`state:ready` on an open issue of the project's repository is the owner's
request to implement it, set by the owner or, on the narrow class the owner
allowed, by the scheduled grooming (D14); one also labelled
`delivery:attended` is left for an attended session, the owner in the chat
(D18). The labels are GitHub's plain labels, named as `docs/DELIVERY.md`
lists them (D22). Nothing else is waited for but the owner steps the issue may
list (the owner-steps gate below). The run delivers it in mode `full` as
`docs/DELIVERY.md` defines it — implement, verify, review, merge, follow the
main workflow's run, and, as far as `.claude/flow.json` leaves them on, follow
the deployment, verify the site and tag a changed version — under the
standing autonomous-delivery authority in `CLAUDE.md` and `docs/DELIVERY.md`.

This file changes none of that. It adds only what an unattended run needs on
top: which issue is taken, when a fire must not take one, how tasks in flight
share the queue and the delivery lock, what happens to the label, and how the
result is reported. Every limit in `docs/DELIVERY.md` applies unchanged — the
correction-round cap, the single delivery at a time, the recovery rules, the
tagging rules. The decisions and their rejected alternatives are D5 and
D16 in `docs/DECISIONS.md`.

**Anything `docs/DELIVERY.md` says to ask the owner about is a BLOCKED outcome
here**, not a question: missing material product intent, a scope expansion, a
new paid service, a material security or privacy change, unavailable
credentials, a destructive data operation, a breaking change to a part
`docs/ARCHITECTURE.md` lists under `Stable parts` — which needs the owner's
approval, recorded in the pull request, and a run has nobody to give it, so
the task ends BLOCKED with the pull request, still draft, where an attended
session would ask the owner (`docs/DELIVERY.md`, Decisions and
compatibility) — or a technical blocker that cannot be resolved with existing
authority. Record it on the issue and end the task.

## The queue

`node .claude/scripts/delivery-queue.mjs <command>` keeps the state every
task's session shares, on this machine under the repository's git directory —
`$(git rev-parse --git-common-dir)/delivery-queue/`, the same from the main
checkout and from every worktree, and never in Git (D16). The script's header
is its contract; what a fire uses:

- `status` — every task in the queue: its state, pull request, whether it
  holds a slot or the lock, its session and whether that session shows a sign
  of life, the next step and the reason it stopped or is paused. The first
  line names the slots in use, the lock and whether the queue is paused.
- `pick` — the ready issues to offer to the gates below, in order, and those
  passed over with the reason.
- `show`, `start`, `update`, `reserve`, `adopt`, `areas`, `lock`, `check`,
  `unlock`, `merge`, `finish` and `pause`, each named where it is used below.

`status --json` and `pick --json` print the same answers as JSON for
`.claude/scripts/fire-check.mjs`; the session reads the text forms.

Every command that acts on a task takes `--session <id>`: this session's CLI
session id, the name of the directory that holds its scratchpad
(`/private/tmp/claude-<uid>/<project>/<id>/scratchpad`, as the system prompt
names it). A headless session — which is how the launchd job starts this
procedure — finds no scratchpad named in its system prompt: its session id is
`$CLAUDE_CODE_SESSION_ID`, and its scratchpad is the path a desktop session
would be given, which
`echo "/private/tmp/claude-$UID/<project>/$CLAUDE_CODE_SESSION_ID/scratchpad"`
prints, `<project>` being the main checkout's absolute path with every
character that is not a letter or a digit replaced by `-` — the name of the
project's directory under `~/.claude/projects/`, such as
`-Users-me-Projects-app` for `/Users/me/Projects/app`. Claude Code makes the
directory above it for the session; the run's first file written there with
the Write tool makes the scratchpad itself, and every scratch file of the run
and of its sub-agents goes there — comment and pull request bodies included —
the path given in each sub-agent's brief. A task belongs to one session at a
time. A command for a task that belongs to another session is refused with
`belongs to`: that session is the task's, and this one stops acting on it,
stops its sub-agents and the processes it started for the task (`TaskStop`,
the recorded PIDs), and names in its final message what it left in the
worktree.

**Slots.** A task holds a slot while it is `working`. A task waiting for the
delivery lock, for a dependency or for an unavailable resource holds none, and
neither does the one holding the lock: the lock is a place of its own. A fire
takes a new issue only while fewer tasks hold a slot than the slot limit, 3
unless `node .claude/scripts/delivery-queue.mjs set slots <n>` has changed it.
Attended sessions, the owner in the chat, register their tasks in the same
queue with
`node .claude/scripts/delivery-queue.mjs start <n> --session <id> --branch <branch> --worktree <path> --base <BASE_SHA> --day`,
or, for one without an issue, the same with `day-<word>` in place of `<n>`
and `--areas <a,b>` added: they count toward the limit when a fire picks,
but an attended session is never refused. A task that comes back to work —
from the lock, from a pause or from waiting for the lock — takes its slot
back even over the limit, and new starts wait until fewer tasks hold a slot
than the limit; `status` then reads `4 of 3 slots in use` and says why.

**Liveness.** The app's run status is no sign of life: a run that waits between
turns for its sub-agents reads `succeeded` while it is alive. A session is
alive while its transcript, its sub-agents' transcripts or its task's last
update in the queue is younger than the threshold, 90 minutes unless
`set stale-minutes <n>` has changed it; the script reads them itself, and
`status` shows the verdict as `alive`, `DEAD` or `detached`, and each task's
origin, `fire` or `day` — `day` for a task an attended session registered, a
day task. A session that ends on purpose with its task unfinished — waiting
for the lock past its bound, paused for a resource — detaches it
(`update … --detach`), and the next fire may take it at once. A day task is
the owner's: a fire adopts it only once its session has detached it, however
long that session has been quiet.

**The task's own test resources.** Every task's suite runs on resources of its
own — its own database, its own ports — so that tasks developed side by side
never share state their suites write. `commands.taskTest` in
`.claude/flow.json`, with `{task}` replaced by the task's key, the issue
number, runs the project's suite on them: it brings them up when they are
not, gives the same ones when run again, and passes the suite's output and
exit code through. `commands.taskDown`, with `{task}` replaced the same way,
removes them with their data when the task leaves the queue (End of run).
When `commands.taskTest` is empty the suite runs with `commands.test`, and
then tasks must not share state the suite writes: the project's suite keeps
its state inside the worktree. When `commands.taskDown` is empty there is
nothing to remove, and the step that would run it is skipped, the report
saying so. No task's suite ever runs against the application's own data.

## Start

1. Work from the main checkout: `cd <checkout>`, `<checkout>` being the part
   of this file's path in the prompt before `/.claude/scheduled/`.
2. Record the fire time: `date '+%Y-%m-%d %H:%M:%S %z'`, the offset numeric
   (`+0300`), never a zone name: `.claude/scripts/fire-check.mjs` reads the
   time of a `Scheduled run <time>:` line and parses only a numeric offset or
   UTC, and the grooming writes its times the same way. Every comment and the
   final message quote it.
3. Note this session's id and its scratchpad (The queue): from the scratchpad
   path the system prompt names, or, in a headless run whose system prompt
   names none, from what the `echo` above prints. Every queue command below
   takes the id as `--session <id>`.
4. Read the project's configuration, each section a call of its own:
   `node .claude/scripts/flow-config.mjs project`, then `commands`,
   `delivery`, `outsideReview` and `design` in place of `project`. Each
   prints the section as JSON with its defaults filled in (D23). Below,
   `<repo>` is `project.repo`, which every `gh` command names with
   `--repo <repo>`; `<main>` is `project.mainBranch`; `<site>` is
   `project.site`; `<mainWorkflow>` and `<smokeJob>` are
   `delivery.mainWorkflow` and `delivery.smokeJob`. A `project.repo` that is
   not `owner/name` means `/flow-init` has not run: the fire ends here, as a
   failed check does.
5. Read `CLAUDE.md` and `docs/DELIVERY.md` in full before touching anything.
   They define the delivery; this file only points into them.

## Checks

A fire makes these checks, in this order: the main checkout is on `<main>`;
GitHub answers; the remote answers; Docker answers, where the project needs
it. A failed check ends the fire with nothing claimed: no adoption, no issue,
no comment, no cleanup — only the final message saying which check failed and
its decisive output.

- **The main checkout is on `<main>`:** `git symbolic-ref --short HEAD` prints
  `<main>`. Fires never switch it; an attended session that did is the
  owner's to put back. Uncommitted changes there are not a failed check — no
  task commits in the main checkout — but report them.
- **GitHub answers:** `gh auth status` succeeds. The token lives in the OS
  keyring; nothing here writes or prints it.
- **The remote answers:** `git fetch origin` succeeds. Other fires fetch in the
  same checkout, so a fetch that fails on a lock another one holds —
  `cannot lock ref`, `Unable to create '…/….lock'` — is retried once, about
  ten seconds later: a Bash call with `run_in_background: true` running
  `sleep 10`, its completion notice waited for, since the tool may refuse a
  foreground `sleep`. A second failure fails the check.
- **Docker answers, where the project needs it** — when `commands.taskTest`
  or `commands.e2e` in `.claude/flow.json` is set, or the project's
  `README.md` says the project needs Docker:
  `docker info --format '{{.ServerVersion}}'` prints a version, with a Bash
  timeout of 60000 ms. That is the one `docker` command a fire runs:
  containers are started and removed by the project's own commands. A
  stopped Docker would otherwise show up only at the Tester step, after half
  an hour of a developer's work. A project that needs neither skips this
  check, and the final message says so.

Worktrees do not stop a fire: several are expected, one or more per task in
the queue. A fire never removes, prunes or cleans a worktree the queue does
not know (D3).

## Resume first

```sh
node .claude/scripts/delivery-queue.mjs status
```

Resume first: a task in the queue whose session is no longer alive is
continued by this fire from its saved step, not restarted. One whose `status`
row says `DEAD` or `detached` is taken, in this order: the task holding the
lock; a task awaiting the lock, when the lock is free and the queue is not
paused; a `working` task, the oldest update first; a paused task whose reason
the checks above no longer show — Docker answering again, GitHub answering —
or whose plan limit may have reset. A paused task whose reason still holds
stays as it is. A day task is adopted only once its session has detached it:
one whose origin is `day` and whose row says `DEAD` is the owner's and is left
alone, and `adopt` refuses it.

```sh
node .claude/scripts/delivery-queue.mjs adopt <n> --session <id>
```

`adopt` refuses a session that is alive, and a day task its session has not
detached, and hands the task over otherwise, with the step it stopped at, its
correction rounds, its pull request, the SHAs Tester and Reviewer verified
and the main they were verified against, and — when it held the lock — the
lock under a new token, which it prints; the old token is refused from then
on.

A **paused** task that this fire takes back to work is put back right after
its `adopt`, with
`node .claude/scripts/delivery-queue.mjs update <n> --session <id> --state working --clear-reason --next "<step>"`,
and so takes its slot back, over the limit if need be (The queue): `adopt`
leaves it paused, and a paused task holds no slot and is refused the lock. A
task **awaiting the lock** that this fire resumes is not put back: it calls
`lock` again, as step 9 says, and keeps its `waitingSince`, its place in line.

Then read the actual state and record it. Before acting, a resumed task reads
GitHub: it never opens a second pull request for a branch, never merges one
that is already merged, and never creates a tag that exists. Concretely:

- its pull request:
  `gh pr list --repo <repo> --head <branch> --state all --json number,state,isDraft,title,headRefOid,url`
  and
  `gh pr view <pr> --repo <repo> --json number,state,isDraft,title,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,mergeCommit,statusCheckRollup,url`,
  the pull request draft while `isDraft` is true or its title starts
  `Draft: ` (step 4);
- for a task that held the lock, the main workflow's run for the merge
  commit and its jobs —
  `gh run list --repo <repo> --workflow <mainWorkflow> --commit <merge sha> --json databaseId,workflowName,event,status,conclusion,headBranch`,
  then `gh run view <run id> --repo <repo> --json status,conclusion,jobs` for
  the `validate / flow` and `validate / project` jobs, `deploy` and
  `<smokeJob>` — and the tag,
  `git ls-remote origin 'refs/tags/v<VERSION>^{}'`;
- its worktrees, which `node .claude/scripts/delivery-queue.mjs show <n>`
  lists.

What it found goes into one comment on the pull request,
`gh pr comment <pr> --repo <repo> --body-file <file>`, or on the issue while
there is none, `gh issue comment <n> --repo <repo> --body-file <file>`, and
into the task with `update <n> --session <id> --next "<step>"`, and the task
goes on from there: a merge already done is followed, not repeated; a
deployment already verified is tagged if its version changed, not deployed
again.

A fire that resumes a task takes no new issue.

## Selecting the issue

A fire takes at most one new issue, and none when it resumed a task.

```sh
node .claude/scripts/delivery-queue.mjs pick
```

`pick` exits 3 with nothing to offer when no slot is free or no ready issue
can be taken now; the fire then ends with the status table. Otherwise it
prints the candidates to offer to the gates, in order, and those it passed
over with the reason. It reads the same list as

```sh
gh issue list --repo <repo> --state open --label state:ready --json number,title,labels,body,updatedAt --limit 200
```

which shows each issue's labels, and leaves out those labelled
`delivery:attended`. That label marks an issue left for an attended session:
one whose delivery needs a person present, or one a delivery run already took,
its description saying why on an `Attended because:` line
(`docs/DELIVERY.md`, Unattended scheduled runs; D7, D18). A fire touches
nothing on those — no comment, no label change.

What `pick` decides from the queue and the issues' text:

- **Dependencies.** An issue with a `Depends on #<n>` line whose issue is
  still open is passed over and keeps its label; it holds no slot, and the
  fire takes another. Every `#<n>` on a `Depends on` line counts:
  `Depends on #1, #2` names two. At most twenty of one issue's dependencies
  are looked up on GitHub; any beyond count as open, so an issue naming more
  is passed over too, with that reason.
- **Areas.** Each issue names the areas it touches in a `## Touches` section,
  from the vocabulary in `.claude/delivery-areas.json`; grooming writes it. A
  task in flight touches the areas it declared plus those of the files its
  branch has changed against its base. The areas that file marks
  `"hard": true` — such as database migrations, a contract other code relies
  on, dependencies, CI and deployment, and the delivery process — are hard.
- **The order.** A candidate sharing a hard area with a task in flight is not
  taken now; among the rest, `prio:1`, `prio:2`, `prio:3`, then none; within
  one priority, the fewest areas shared with the tasks in flight; then the
  smaller issue number. An issue without `## Touches` counts as touching
  every area: it is taken only when no other task is in flight.
- **The queue.** An issue whose task is still in the queue is passed over:
  such a task is resumed only through the queue's state, never by a fresh
  pick.
- **Labels of one kind.** GitHub, unlike scoped labels, does not keep labels
  of one kind exclusive. An issue carrying two `state:` labels, or two
  `prio:` labels, is a fault, read as neither (D22): `pick` passes it over
  naming the fault, the run changes nothing on it, and the final message
  names it for the owner.

`prio:*` and `delivery:attended` are only read: the owner sets `prio:*` at
triage, `delivery:attended` is set at grooming (D7, D18), and the run never
sets or changes either. The run sets no label to mark its own progress and
sets no `state:` label at all: the one label change it makes is removing
`state:ready`. Should a step ever set a `state:` label, the same
`gh issue edit` call removes the other `state:` labels
(`--add-label state:ready --remove-label state:grooming,state:needs-owner,state:deferred`),
because nothing else would. The labels in use are `area:*`, `type:*`,
`prio:*`, `delivery:attended` and `state:ready`, and three that the run
ignores: `state:grooming`, which grooming sets on the issue it holds,
`state:deferred`, which the owner sets on an issue put off for later (D13),
and `state:needs-owner`, which the scheduled grooming
(`.claude/scheduled/grooming.md`) sets on an issue that waits for the owner's
answer or design pick (D14).

For each candidate in `pick`'s order, read it in full before judging it:

```sh
gh issue view <n> --repo <repo> --json number,title,state,labels,body,comments
```

The comments are part of the issue: a design link or an acceptance criterion
added in a comment counts exactly as one in the description.

Then apply the five gates, in this order.

**Epic gate.** An issue labelled `type:epic` is an epic that `/decompose`
filed (D25): its `## Children` lists the issues it is delivered through, each
groomed and delivered as any other, and it is closed when the last of them is
delivered (`docs/DELIVERY.md` step 6). The cycle never takes an epic. `pick`
passes one over; one offered anyway is skipped (Skipping below), its comment
saying that it is an epic, delivered through its children, so `state:ready`
does not belong on it.

**Owner-steps gate.** An action only the owner can take before delivery — a
repository or cloud setting, a secret, a token, a DNS record — is listed at
grooming as a `## Owner steps before delivery` checklist (D7). If that
heading stands in the description or in a comment with any unticked box
(`- [ ]`) under it, the issue is *passed over*: no comment, `state:ready`
stays, and the run moves to the next candidate. The first fire after the last
box is ticked takes it normally. A step reported done in prose does not tick
its box; only the box counts. A pass-over is not a skip — a skip comments and
removes the label — and it neither triggers nor satisfies the double-take
gate.

**Double-take gate.** Two kinds of line from an earlier scheduled run close
this gate: a claim line, which begins `Scheduled run <time>: taken` — the
first words of the claim comment below — and a result line reporting
`DELIVERED`, `BLOCKED` or `RECOVERED`. An issue whose task is in the queue
never reaches this gate (`pick` passes it over); one that carries such a line
and is not in the queue was claimed or finished by a run whose record is
gone, and it is not taken again: it can have a branch, a pull request and
even a deployment behind it that this run knows nothing about. Skip it. A
`not taken` line is a skip, not a claim: it does not trigger this gate, so an
issue the owner re-queues after fixing what a skip named is taken normally.

```text
Scheduled run 2026-09-22 02:04:11 +0300: not taken. An earlier scheduled run has
already commented on this issue — `<the line found>` — and the delivery queue
holds no task for it, so it was claimed or finished by a run whose record is
gone. Nothing of that run's branch or pull request was touched here.
`state:ready` has been removed. The delivery cycle will not take this issue
again while that earlier comment stands: check that run's branch and pull
request and finish it in an attended session, or file a fresh issue for what
remains.
```

**Design gate.** An issue labelled `area:frontend` needs a design reference.
One of these is a reference:

- with `design.figma` true, a Figma link carrying a `node-id`, in the
  description or in a comment;
- with `design.figma` false, a saved image of the design in the description
  or in a comment, or a description of the screens that the issue names as
  its agreed design reference (`docs/DELIVERY.md` step 3);
- an explicit reference to a saved design under `docs/design/`;
- the `Design needed` section of the Idea template
  (`.github/ISSUE_TEMPLATE/idea.md`) answered `no`, which waives the gate
  because the issue states there is no visual change. The answer is the text
  the filer wrote in that section, outside the HTML comment: the placeholder
  comment itself contains the words `yes` and `no` and answers nothing.

Anything else — a Figma link without a `node-id`, a prose wish of how it
should look that the issue does not name as the agreed reference, an
unanswered template section — is not a reference. Frontend work without one
is skipped.

**Acceptance gate.** If no observable acceptance criteria can be derived from
the issue and its comments — if you cannot write down what will be checkably
true afterwards that is not true now — it is skipped, whatever area it is in.
Inventing the criteria is inventing the request.

**Skipping** means, in this order: comment, then remove `state:ready`, then
move to the next candidate. The comment goes first everywhere in this
procedure, because it is what the double-take gate reads: a run that dies
between the two leaves an issue that a later fire can still recognise. The
comment is written to a file in the scratchpad first, then:

```sh
gh issue comment <n> --repo <repo> --body-file <file>
gh issue edit <n> --repo <repo> --remove-label state:ready
```

each in a call of its own, its exit code checked. A skip is not a delivery,
so the fire continues down the list; it ends after it has taken **one**
issue, and takes no second one even if it finishes early.

Skip comment, design gate (fill the fire time and the actual gap):

```text
Scheduled run 2026-09-22 02:04:11 +0300: not taken. This issue is labelled
`area:frontend` and carries no design reference — <what was looked for and
not found: a Figma link with a `node-id`, a saved image or agreed description
of the screens, a saved design under `docs/design/`>. `state:ready` has been
removed so the next run does not retry it. Add the design reference, or
answer `Design needed` with `no` if there is no visual change, then set
`state:ready` again.
```

Skip comment, acceptance gate:

```text
Scheduled run 2026-09-22 02:04:11 +0300: not taken. No observable acceptance
criteria could be derived from this issue: <what is missing, concretely>.
`state:ready` has been removed so the next run does not retry it. Add what
should be checkably true once this is done, then set `state:ready` again.
```

Skip comment, epic gate:

```text
Scheduled run 2026-09-22 02:04:11 +0300: not taken. This issue is an epic
(`type:epic`): it is delivered through the issues its `## Children` lists,
and closed when the last of them is delivered. `state:ready` has been
removed; set it on the children instead.
```

If every candidate is skipped or passed over, the fire ends with no delivery.
Report which issues were skipped and why, and which were passed over and why.

## Claiming the issue

The queue is the claim. Run the preflight on main (step 1 below) for the
`BASE_SHA` and the worktree path, then register the task:

```sh
node .claude/scripts/delivery-queue.mjs start <n> --session <id> --branch <branch> --worktree <path> --base <BASE_SHA>
```

`start` reads the issue again and refuses — exit 3, nothing claimed — when no
slot is free any more, when another fire has meanwhile started a task this one
would share a hard area with, or when the issue has lost its label or gained
an open dependency; the fire then offers the next candidate, or ends when no
slot is free. A decision id is reserved only when the task needs one: once
`start` succeeds when the brief already knows a lasting decision is coming, or
later when the Developer reports one the brief did not foresee —

```sh
node .claude/scripts/delivery-queue.mjs reserve <n> --session <id>
```

which prints it: decision ids are reserved from the queue's counter when a
task needs one, not at every start, so parallel branches never take the same
one, and an id left by a stopped task stays unused. A task that needs a
second one reserves it then. Once `start` succeeds, comment on the issue so a
person reading it, or a fire whose queue state is gone, sees who has it:

```text
Scheduled run 2026-09-22 02:04:11 +0300: taken, mode `full` (docs/DELIVERY.md).
Branch `feat/<slug>`. A result comment follows on this issue.
```

`state:ready` comes off when the task leaves the queue — DELIVERED, BLOCKED,
RECOVERED or STOPPED — not at the end of each fire. The label stays on while
the task waits for the lock or is paused; see Outcomes.

## The delivery

Exactly `docs/DELIVERY.md`, `full`. Nothing in this section replaces a step
there; it names the order and the few things specific to running unattended
beside other tasks. After each step the task's next step goes into the queue —
`update <n> --session <id> --next "step 6: tester"` — so a fire that resumes
it knows where to go on.

`<taskTest>` below is `commands.taskTest` with `{task}` replaced by the issue
number, or `commands.test` when it is empty; `<taskDown>` is
`commands.taskDown` with `{task}` replaced the same way (The queue).

1. **Preflight on main.** `sh .claude/scripts/delivery-preflight.sh` from the
   main checkout. Record the `BASE_SHA` it prints; that value is what the task
   is pinned to and what a review of the whole change is taken against until
   main is integrated, after which that review artifact's base is the main
   SHA merged in (`docs/DELIVERY.md` step 2). The worktrees it names as not
   created by this run are the other tasks' when `status` lists them; any
   other is left exactly as found (D3).
2. **Branch and worktree.** The branch is `<type>/<slug>`: `fix/` for a
   `type:bug` issue, `feat/` for `type:idea`, `chore/` for `type:chore`; the
   slug is a few words from the issue's outcome. The worktree goes outside
   the repository, at the path the preflight prints —
   `<checkout>-worktrees/<branch>`. A `git worktree add` that fails on a lock
   another fire holds is retried once, about ten seconds later, as Checks
   retries a fetch.
3. **Preflight again**, from the branch's worktree, and use the `BASE_SHA` it
   derives. Then `commands.install` in that worktree, when the project has
   one; installed dependencies such as `node_modules` are never symlinked
   between trees. There is no separate step that brings the task's test
   resources up: `<taskTest>` does it when it first runs, and a failure to
   bring them up, as opposed to a failing test, is a pause for the resource
   (Pauses), with its message. The Developer's and the Tester's briefs carry
   `<taskTest>`, the command they run the task's suite with.
4. **Draft pull request**, before the implementation — after
   `gh pr list --repo <repo> --head <branch> --state all --json number,state,url`
   shows none for the branch. GitHub opens no pull request for a branch
   without a commit of its own, so the main session first makes one empty
   commit in the worktree, its message in a scratchpad file —
   `cd <worktree> && git commit --allow-empty -F <file>`, the subject
   `Start #<n>: <issue title>` — and pushes the branch,
   `git push --set-upstream origin HEAD`. The commit changes no file, so no
   fingerprint and no review artifact sees it. Then the pull request is
   opened as a draft, in the form `delivery.draftPullRequests` picks
   (`docs/DELIVERY.md`, Configuration; D22) — true:
   `gh pr create --repo <repo> --draft --base <main> --head <branch> --title '<title>' --body-file <file>`;
   false, where GitHub has no draft pull requests:
   `gh pr create --repo <repo> --base <main> --head <branch> --title 'Draft: <title>' --body-file <file>`,
   the `Draft: ` prefix marking it draft. Every title in this procedure goes
   in single quotes with none inside it. A pull request is draft while
   `isDraft` is true or its title starts `Draft: `, and a draft is never
   merged (step 9). The body follows
   `.github/pull_request_template.md` and carries the goal, the observable
   acceptance criteria, the design reference (or `No visual change`),
   whether the version changes when `delivery.versioning` is true (the
   number itself is set under the lock, step 9) and the recovery record. With
   `delivery.deploy` true, that record is the last verified deployment as
   `docs/DELIVERY.md`, Recovery, defines it — main's SHA, the main
   workflow's run id, and what `delivery.rollback` needs to restore it — the
   run read with
   `gh run list --repo <repo> --workflow <mainWorkflow> --branch <main> --status success --limit 1 --json databaseId,headSha,conclusion,createdAt,url`,
   and read again under the lock, since another task may have deployed
   since. With `delivery.deploy` false it says there is no deployment and
   recovery is a revert pull request. The body names the issue as
   `Issue: #<n>`, never with a closing keyword (`Closes`, `Fixes`,
   `Resolves`): GitHub would close the issue at the merge, and the run closes
   it after the verification, as `docs/DELIVERY.md` step 6 says. Record the
   pull request:
   `update <n> --session <id> --pr <pr>`.
5. **Developer**, with the task, the criteria, the `BASE_SHA`, the branch, the
   worktree path, the decision id reserved for it when the task needs one and
   `<taskTest>` (step 3). A Developer that finds the task needs a lasting
   decision the brief gave no id for reports it; the main session reserves
   one then and gives it to the Developer. With `delivery.versioning` true, a
   change that bumps the version sets the next one after `BASE_SHA`'s, so
   the pull request's version check
   (`node .claude/scripts/check-version.mjs <base>`) passes; it is
   renumbered under the lock. A report opening with `Handover` gets a fresh
   Developer as `docs/DELIVERY.md` step 4 says; it is not a round, so no
   `--round` (D20).
6. **Tester**, in its own worktree, with the criteria, the `BASE_SHA` and the
   SHA to verify, and `<taskTest>`; the worktree is recorded with
   `update <n> --session <id> --worktree <path>` so that it is removed with
   the task. A branch whose changed files against its base all match `*.md`
   or lie under `.claude/` is verified by `tester-process`; every other
   branch by `tester` (D21). The class is not text alone: the scripts,
   tests and settings under `.claude/` are in it. A branch whose diff
   warrants the tester's hostile-input pass, one that touches a parser, a
   formatter, a regular expression, redaction, or URL, header or
   request-line handling, such as the Bash guard, stays with `tester`, even
   inside the class. If `tester-process` is not available in the session,
   `tester` verifies. The main session — not the tester — runs
   `sh .claude/scripts/tree-fingerprint.sh <worktree>` immediately before and
   after the run and compares the two readings itself; a mismatch discards
   that verdict. Other tasks' testers run beside it, so an agent that runs a
   suite binding ports or using a database takes ports and resources of its
   own, as `CLAUDE.md`, Sub-agent hygiene, requires: for the task's suite
   that is what `<taskTest>` gives it. A few things are worth knowing in an
   unattended run:
   - The `mcp__Claude_Browser__*` tools are client-provided and a tester has
     been seen both with and without them (D4). It confirms them with
     `ToolSearch` at the point of need. Where they are absent, the tester
     reports the criterion NOT VERIFIED and **the main session makes the
     visual comparison itself**, naming the design reference and the
     screens. If neither can see the rendered page, the criterion stays NOT
     VERIFIED, the pull request is not merged, and the task ends BLOCKED.
   - The task's suite runs on the task's own resources, never on the
     application's own data: Developer and Tester run it with `<taskTest>`,
     from the worktree's root, which brings the resources up if they are not
     and passes the suite's output and exit code through (D16). Two tasks'
     suites at once on one set of resources would see each other's data. A
     container the project's commands use is started and removed by those
     commands, never by `docker` directly. A failure to bring the resources
     up is a pause for the resource (Pauses), with its message. Nothing that
     needs a person — a registry sign-in, a credential helper's prompt — is
     run unattended.
   - Do not free a port by pattern. A bare `lsof -ti:<port> | xargs kill` can
     kill another program's helper instead of a test server. If a port a
     suite needs is occupied, something this run did not start is using it —
     another task's server, as like as not: take other ports, and if those
     are occupied too, the task is BLOCKED, not cleaned up after: `lsof` is
     neither run unattended nor granted, and `kill` reaches only the PIDs
     the next bullet describes. For a person clearing it by hand: filter to
     listeners first — `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` — and kill
     only those PIDs.
   - Stop, by PID, every process this run starts. A command that does not
     end on its own by design — a dev server, a watcher, a preview — is never
     started in the foreground, by the main session or a sub-agent: it is
     started in the background with `&` in the call and its `$!` recorded,
     so that this rule can stop it (D6). A dev server started for a curl or
     a browser check, a backgrounded test runner, anything else with a PID
     recorded at start — `$!` of a backgrounded command, or the PID the tool
     reports — is stopped before the step that started it reports:
     `kill <pid>`, then `kill -9 <pid>` as a second attempt about ten seconds
     later. Neither form is allowlisted, deliberately; see Permissions. A
     task's test resources are not a process the run kills, but resources it
     removes with `<taskDown>` when the task leaves the queue (End of run).
     Never by port, never by pattern, never a process this run did not
     start — another task's least of all; a test runner's own web server is
     the runner's to stop (D5).
   - Killing the recorded `$!` of a dev server's wrapper — an `npm run …`, say
     — usually ends the chain under it. Confirm it rather than assume it,
     with the same readiness check on both sides of the kill —
     `curl -sS -o /dev/null -w '%{http_code}' http://localhost:<port>/`,
     which must answer while the server is up and must fail to connect once
     it is stopped. Ask `localhost`, not `127.0.0.1`: a dev server may bind
     `[::1]` only, which a check against `127.0.0.1` reads as a free port
     while the server is running.
   - A port still answering after the kill means the wrapper did not pass the
     signal on, and then its children are this run's processes too. Find them
     in your own process tree with `ps -o pid,ppid,command -ax`, matching
     each to the wrapper PID you recorded — never `lsof`, never a sweep by
     port or by pattern — `kill -9` them by PID, confirm the port once more,
     and report what it took. A PID that will not die, a port that still
     answers, or a kill the permission system refuses is reported with the
     command it ran, for the owner.
   - Each suite runs as `.claude/flow.json` names it, from the worktree's
     root, in a Bash call of its own, its exit code checked and its count
     reported: `commands.check`, the task's suite through `<taskTest>`, and
     `commands.e2e` where a criterion needs it. Never two in one call: joined
     with `;` a call reports only the last one's exit code, and two long
     suites in one call are the shape that reaches the tool's time limit.
     The commands carry their suites' flags, so none is typed on top; a
     single file or a name pattern is given the way the project's
     `CLAUDE.md`, Testing, says its suite takes one.
   - A foreground call that runs past its timeout is moved to the background
     by the tool, which reports a task id and no PID —
     `moved to the background (ID: <id>)` — so the rule above has nothing to
     stop it by, and it can run for hours. A call made with
     `run_in_background` also returns a task id, not a PID. Whoever made the
     call, the main session or a sub-agent, stops that task by its task id
     with `TaskStop` before the step reports, unless the tool has reported
     that it ended; a `TaskStop` answering that the task is no longer running
     counts as stopped, and the report says which: stopped, or already ended.
     Not by a PID looked up afterwards: finding one means searching the
     process list by pattern. A sub-agent that cannot stop it names the task
     id in its report, and the main session stops it with `TaskStop`, which
     it always holds (D6), when it reads that report — a dev server left
     running would otherwise hold its port through the next step — and in
     any case before the run ends.
7. **Reviewer**, reading the artifact from
   `sh .claude/scripts/review-artifact.sh <base> <head> <path>`, generated in
   the worktree that holds the head. The reviewer has no shell by design; do
   not stand in for it and do not let the developer's word be its verdict.
   Its brief is the template in `docs/DELIVERY.md` step 4 and nothing else:
   the issue description verbatim, the artifact path, the base and the head,
   and, for the reviewer of a correction round, which is always started
   fresh (step 10), the previous reviewer findings verbatim. The base is
   `BASE_SHA`, or the main SHA merged in, for a review of the whole change,
   and the reviewed SHA, or the SHA its verdict was carried to, for a
   reviewer checking a fix alone, which then reads only the fix diff
   (`docs/DELIVERY.md` step 4). A design link or an acceptance criterion
   added in a comment counts as part of the description, as it did when the
   issue was selected, and follows it, verbatim too; nothing else from the
   comments does. Never what the developer or the tester concluded, and no
   summary of the change or of the fix (D2). The SHAs Tester and Reviewer
   passed go into the queue:
   `update <n> --session <id> --tester <sha> --reviewer <sha> --verified-main <the main they were verified against>`.
8. **Outside review**, by the rule of `docs/DELIVERY.md` step 4 (D12) as
   D15 narrowed it: run by the main session, never by a sub-agent, and with
   no label. It runs only when `outsideReview.enabled` is true and
   `node .claude/scripts/delivery-queue.mjs areas <branch>` names an area
   listed in `outsideReview.areas` — never for documentation or process text
   alone. Otherwise it does not run, and the pull request records why in one
   line — `outside review not run: not enabled in .claude/flow.json`, or
   `outside review not run: the branch touches none of outsideReview.areas`
   — and the run goes on. Once the tester has passed and the reviewer has
   approved a SHA, or a verdict stands in their place as `docs/DELIVERY.md`
   step 5 allows after the third round, it runs on that SHA, at most once per
   task, and never again on the fixes it caused:
   `sh .claude/scripts/outside-review.sh <artifact> <issue-file> <output-file>`,
   in the worktree that holds the head, with the issue description in a file
   and the output outside the worktree, called with Bash
   `run_in_background: true`, and its completion notice waited for. Its notes
   go on the pull request verbatim in one comment naming the SHA and the
   model, `gh pr comment <pr> --repo <repo> --body-file <file>`; every
   numbered finding is answered there, and fixes go back to the reviewer and
   the tester without carrying a verdict forward. Its blocking findings
   inside the task's scope are fixed within the round cap of step 10, and its
   other findings become follow-up issues filed as step 10 says. After the
   third round a fire fixes none of them: a blocking defect still open ends
   the run BLOCKED with the pull request, still draft, and every other
   finding becomes a follow-up issue. A wrong finding is declined with the
   reason. A blocking finding about a material risk that the run would
   decline ends the run BLOCKED, with the pull request, still draft, and the
   finding named. A
   skip, `outside review skipped: <reason>`, is recorded in the pull request
   and the run goes on. A skip that needs the owner is reported once until
   it is fixed, and the script says which skip is still to be reported: only
   where that line carries `Owner action needed: <step>` does the run's
   result comment carry the same line (see Outcomes) and the run send the
   owner one notification with `PushNotification` saying it; a notification
   not sent is not a failure. A line saying `Owner action already reported`
   is recorded in the pull request as a skip and not reported again. The skip
   counts as reported only once the run acknowledges the key its line names,
   after the comment is posted and the notification sent (see Outcomes):
   until then it says `Owner action needed:` again, whatever other key is
   acknowledged.
9. **Merge, follow the run, verify, tag — under the delivery lock.** Under
   the lock, one pull request at a time: integrate current main into the
   branch with a merge commit, resolve conflicts, set the version, have the
   integration checked as step 4 of `docs/DELIVERY.md` says, merge, follow
   the main workflow's run for the merge commit and, with `delivery.deploy`
   true, its deployment and `<smokeJob>`, check the site, tag. The lock is
   released after the main workflow's run has passed — with
   `delivery.deploy` true, after the smoke and the site check too — and the
   tag is pushed, or after a verified recovery. Tester and Reviewer run on
   each branch before it queues, beside the other tasks, and in a critical
   area the full pair once more under the lock (Re-verify).

   - **Taking it.** Once Tester has passed and Reviewer has approved the head,
     each verdict given for it or carried forward to it as `docs/DELIVERY.md`
     step 4 says, and the outside review is answered, skipped or not run,
     the task waits for the lock without spending tokens: one call with Bash
     `run_in_background: true`,
     `node .claude/scripts/delivery-queue.mjs lock <n> --session <id> --wait 25`,
     whose completion notice is waited for. The wait stays within the 30
     minutes a background call runs unless given longer, and the script
     refuses a longer one. It prints `token <token>` once it holds the lock;
     the token goes into nothing but the commands below. A task waiting holds
     no slot, and the queue serves the one that has waited longest. A call
     that ends without printing a token is taken as past the bound in four
     cases only: exit 3 with the refusal `… stays awaiting the lock`, its
     bound reached; exit 3 with a refusal beginning `the queue is paused: `,
     the reason after it being free text; a call stopped by the tool before
     it ends; and an exit 1 or 2 of `lock`, a fault — its state file in use
     or unreadable — or a usage error. In each the task stays as the call
     left it: record it and end, the label kept —
     `update <n> --session <id> --next "step 9: take the lock" --detach` —
     and a later fire resumes it and calls `lock` again. On a paused queue
     the call ends at once, the task left awaiting the lock, and it is
     resumed once the owner's word unpauses the queue. Any other exit 3 is
     answered as its refusal says: `belongs to` — stop acting on the task and
     read its actual state (The queue); `holds the lock already` — use the
     token this session was given, or `adopt` the task to be given a new
     one; `#<n> is paused: put it back to work first` — run the
     `update <n> --session <id> --state working --clear-reason` it names,
     then `lock` again; `is not in the queue` — read the actual state.
   - **The token.** Before merging, before tagging and after every wait, the
     holder checks that its token is still current:
     `node .claude/scripts/delivery-queue.mjs check <n> <token>`. A session
     whose token is stale stops acting, re-reads the actual state and queues
     again: another session has adopted the task and is acting on it.
   - **Integrate and number.** In the worktree, `git fetch origin` and
     `git merge origin/<main>`, a merge commit, never a rebase; conflicts
     resolved in the branch, the resolution committed with
     `git commit -F <file>`. Then, with `delivery.versioning` true, the
     version, relative to main at that moment: `VERSION` and the
     `CHANGELOG.md` heading set to the next minor or patch after main's as
     `.claude/scripts/check-version.mjs` requires —
     `node .claude/scripts/check-version.mjs origin/<main>` passes — and the
     CHANGELOG entry's date set to today. A decision id, when the task has
     one, is the one reserved for it. Push, `git push origin HEAD`, and wait
     for the pull request's checks for that exact SHA (Following a run,
     below).
   - **Re-verify.** The integration is checked as `docs/DELIVERY.md` step 4
     says (D19). The main session checks by its diff one whose conflicts are
     none or only in the bookkeeping files `.claude/delivery-areas.json`
     names, the version included, and the pull request's checks run: the
     verdicts carry forward, and no reviewer is started but for a critical
     area. Any other conflict resolution goes to a fresh reviewer, with the
     artifact taken against the main SHA merged in, and the tester reruns the
     checks it affects. Then, when
     `node .claude/scripts/delivery-queue.mjs areas <branch>` names an area
     that `.claude/delivery-areas.json` marks `"critical": true`, the full
     pair runs once more on this SHA — the tester on every criterion, and a
     fresh reviewer on the whole change, against the main SHA merged in —
     unless their full verdicts are already for it or carried to it under
     step 4's four conditions or by a wording fix, not by this integration
     or by a re-check step 4 limits. A pull request that needs a fix after
     integration releases the lock and goes back to its task —
     `node .claude/scripts/delivery-queue.mjs unlock <n> <token> --next "<the step it goes back to, and why>"`
     — so the next ready pull request may take it; it queues again once the
     fix is verified. Back at work it takes its slot back, over the limit if
     need be.
   - **Merge** as `docs/DELIVERY.md` step 5 says. The main session first
     checks the pull request:
     `gh pr view <pr> --repo <repo> --json number,state,isDraft,title,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url`
     shows `headRefOid` equal to the checked SHA, `baseRefName` equal to
     `<main>` and `mergeable` `MERGEABLE`, and `gh pr checks <pr> --repo <repo>`
     shows every check passed for it, a skipped, cancelled or neutral one not
     counting as a passed required one. A draft is never merged, so it then
     marks the pull request ready — with `delivery.draftPullRequests` true
     `gh pr ready <pr> --repo <repo>`, with it false
     `gh pr edit <pr> --repo <repo> --title '<the title without the Draft: prefix>'`
     — reads `isDraft` and `title` again to see that it is no longer draft,
     checks the token, and merges through the queue, which checks the token
     holding its mutex and then runs `gh pr merge` itself with `--repo <repo>`,
     `--merge` and `--match-head-commit <the checked SHA>`, reporting gh's
     exit and output (D16):
     `node .claude/scripts/delivery-queue.mjs merge <n> --token <token> --sha <checked SHA>`,
     the SHA written in full. The repository deletes the merged head branch
     itself. The Bash guard refuses every other way of merging, with a token
     or without. A stale token is refused before GitHub is asked; a failed
     merge exits 1 with gh's output, and the task's next step says to read
     the pull request before acting again. A pull request that will not
     merge and whose task ends BLOCKED is put back to draft: with
     `delivery.draftPullRequests` true `gh pr ready <pr> --repo <repo> --undo`,
     with it false `gh pr edit <pr> --repo <repo> --title 'Draft: <title>'`.
   - **Follow the run, verify, tag**, as `docs/DELIVERY.md` step 6: the merge
     commit from `gh pr view <pr> --repo <repo> --json state,mergeCommit`
     (`state` `MERGED`), the main workflow's run for it passed (Following a
     run, below), its jobs read with
     `gh run view <run id> --repo <repo> --json status,conclusion,jobs` —
     with `delivery.deploy` true the `validate / flow` and
     `validate / project` jobs, `deploy` and `<smokeJob>` each passed, with
     it false the run's conclusion alone. With `delivery.deploy`
     true and `<site>` set, the changed behaviour is then verified on
     `<site>` with disposable test data of the check's own, touching nothing
     else there. Then, with `delivery.versioning` true and `VERSION` changed,
     after one more `check`, the annotated tag at the merge commit, from the
     worktree after `git fetch origin`:
     `git ls-remote origin 'refs/tags/v<VERSION>^{}'` prints nothing — a tag
     already there at the merge commit is done, not redone, and one at
     another SHA is a conflict, never overwritten, which ends the task
     BLOCKED, its comment saying that the change is merged and the tag is
     the owner's to settle — then
     `git tag -a v<VERSION> <merge sha> -m "v<VERSION>"`,
     `git push origin refs/tags/v<VERSION>`, and
     `git ls-remote origin 'refs/tags/v<VERSION>^{}'` again, which must print
     the merge commit. Then the epic, when the issue has one, is ticked
     while the lock is still held; the task leaves the queue, which releases
     the lock; and the issue is closed (Outcomes; `docs/DELIVERY.md` step 6).
   - **A failed run after the merge.** A main workflow run that fails is
     recovered as `docs/DELIVERY.md`, Recovery, says, with the lock held: no
     other task merges until the run passes or the recovery is verified.
     Before acting, the main session confirms the failed run is still the
     newest for `<main>` and no newer one is running:
     `gh run list --repo <repo> --workflow <mainWorkflow> --branch <main> --limit 3 --json databaseId,headSha,status,conclusion`.
     A run that failed before deploying left the deployment alone, and with
     `delivery.deploy` false that is the only case: main is red, so the
     queue is paused,
     `node .claude/scripts/delivery-queue.mjs pause --reason "<the failed job and its decisive output>"`,
     and the task ends BLOCKED, naming the failed job; the fix is a follow-up
     or revert pull request, delivered once the owner's word unpauses the
     queue. A deploy or smoke that failed, with `delivery.rollback` a
     command, is recovered by running that command once, with the target the
     recovery record names; then the restored service is checked as the
     smoke job checks it, and the failed feature's baseline behaviour on
     `<site>`. With `delivery.rollback` empty, recovery is a revert pull
     request through the same lock: a branch `revert/<slug>` cut from
     `origin/<main>` in a worktree of its own
     (`git worktree add -b revert/<slug> <path> origin/<main>`), the merge
     commit reverted there with `git revert --no-edit -m 1 <merge sha>`, and,
     with `delivery.versioning` true, `VERSION` set to the next patch after
     the failed delivery's with a `CHANGELOG.md` entry saying what it
     reverts, committed with `git commit -F <file>` — a consumed version is
     never reused, and the version check requires it. The main session
     checks by its diff that the revert restores the tree before the merge:
     `git diff --stat <merge sha>^1 <revert head>` lists nothing but
     `VERSION` and `CHANGELOG.md`. It needs no Tester or Reviewer. The branch
     is pushed with `git push --set-upstream origin HEAD`, opened with
     `gh pr create` as step 4 does, recorded on the task with
     `update <n> --session <id> --pr <pr> --worktree <path>`, its checks
     waited for, marked ready and merged with this task's `merge` and token
     as the merge above, and its run followed as any merge's. A recovery
     that fails keeps the queue paused and is reported to the owner:
     `node .claude/scripts/delivery-queue.mjs pause --reason "<what failed>"`
     before the task ends BLOCKED. No task takes the lock while the queue is
     paused; it runs again only on the owner's word
     (`node .claude/scripts/delivery-queue.mjs unpause`). Recovery never
     destroys data: no database reset, no volume deletion, no secret
     rotation.

   **Following a run.** A run is found and waited for, never assumed. The
   runs of a SHA are listed with
   `gh run list --repo <repo> --commit <sha> --json databaseId,workflowName,event,status,conclusion,headBranch`
   — for the main workflow with `--workflow <mainWorkflow>` added. A run not
   listed yet is asked for again after a Bash call with
   `run_in_background: true` running `sleep 30`, its notice waited for, up to
   ten times; one still missing then is a fault of the run, BLOCKED. Each run
   is then waited for with one call with Bash `run_in_background: true`,
   `gh run watch <run id> --repo <repo> --exit-status --interval 60`, whose
   completion notice is waited for, and a `check` of the token after it. The
   call is given the ceiling as its timeout: 30 minutes for the pull
   request's checks, 45 for the main workflow's run including deploy and
   `<smokeJob>`. A call stopped at its ceiling is BLOCKED, reported as **not
   finished within the ceiling** — not as failed: the run may still be going,
   so nothing is merged, retried or rolled back on the strength of a timeout.
   A run that cannot start because the account's GitHub Actions minutes are
   spent is, before the merge, a pause for the resource (Pauses) — a task
   holding the lock first releases it,
   `node .claude/scripts/delivery-queue.mjs unlock <n> <token> --next "<the step to go on from>"`,
   since a task holding the lock is not paused — and, after the merge, a
   failed run (above).
10. **Corrections** follow `docs/DELIVERY.md`: fix in-scope defects, reassess
    with the relevant specialist after two attempts that make no progress,
    and where it says to report the blocker — report it here as the BLOCKED
    outcome below. Each round is counted in the queue,
    `update <n> --session <id> --round`, so a resumed task goes on with the
    rounds it has used. The correction-round cap in `docs/DELIVERY.md`
    applies to each task separately: a fire's task whose blocking defect is
    still open after its third round ends BLOCKED, as the cap says of an
    unattended run, whatever the hour, and the other tasks go on. The same
    rules as in an attended session, in short:
    - At most three correction rounds, as `docs/DELIVERY.md`, Decisions and
      compatibility, defines a round, a blocking defect and the follow-ups
      (D15). A defect is blocking when, in a realistic case, data is lost or
      corrupted, one client can take the service down, data leaks, or a
      documented contract breaks, with the project's own priorities in
      `CLAUDE.md`. After the third round a fire fixes nothing more: a
      blocking defect still open ends the run BLOCKED, with the pull
      request, still draft, and the defect named, and every other finding
      becomes a follow-up issue, filed as the next item says and listed in
      the pull request, which merges on the tester's PASS and the reviewer's
      APPROVED or APPROVED WITH MINORS. The main session classifies every
      finding still open after the third round as blocking or not by that
      document's definition, and a verdict whose every open finding it filed
      so, the pull request giving per finding the issue and one sentence on
      why it is not blocking, no longer stops the merge (`docs/DELIVERY.md`
      step 5).
    - A follow-up is filed by `/create-task`'s rules, unattended: no question
      goes to the owner, a duplicate found among the open issues gets a
      comment naming the finding instead of a new issue, the issue is written
      in English from its template under `.github/ISSUE_TEMPLATE/` without
      `state:ready`, and the list of the issues filed or commented on in the
      run's result comment takes the place of the retelling in the owner's
      language. Its body is written first to a file in the session's
      scratchpad, outside the worktree, in the template's shape, and the
      issue is filed with one command that carries no command substitution:
      `gh issue create --repo <repo> --title '<title>' --body-file <file> --label <labels>`,
      `<labels>` being one `type:*` and one `area:*`, comma-separated, as
      `/create-task` labels. The title goes in single quotes, with none
      inside it: in double quotes a backtick in the title would be a command
      substitution, which no rule in Permissions covers, and a command no
      rule covers is not run unattended. Follow-ups that link to each other
      are filed in the order `/create-task` gives, and the links an issue
      filed earlier still lacks are added by writing its whole body, links
      included, to a file again and replacing it with
      `gh issue edit <n> --repo <repo> --body-file <file>`.
    - The reviewer's APPROVED WITH MINORS with the tester's PASS may merge the
      reviewed SHA; minors left unfixed are recorded in the pull request or
      in a follow-up issue.
    - Fixed minors carry both verdicts forward to the fix commit only under
      the conditions of `docs/DELIVERY.md` step 4: only `*.md` files, none of
      the files it excludes, every hunk at a place one of the reviewer's
      numbered minors named, and no integration of main since the reviewed
      SHA. The pull request records the reviewed SHA, the fix SHA, the files
      and the finding number each hunk answers. Anything else is re-checked
      as the next item says.
    - Every other fix is re-checked only by the role whose finding it
      answers, and only the fix, as `docs/DELIVERY.md` step 4 says (D19); a
      verdict the re-check leaves standing carries forward, and the pull
      request records it. The main session itself fixes a documentation or
      wording finding of the tester or the reviewer, of any severity, whose
      fix touches only `*.md` files outside the files step 4 excludes,
      checking every hunk against the finding it answers and recording the
      fix in the pull request: no agent is started, and the fix is not a
      round. It makes the fix while no developer is at work in that worktree,
      before one is started or after its report. A documentation or wording
      fix that touches one of the excluded files is checked as before: a
      fresh reviewer on the branch's whole change, its base `BASE_SHA` or,
      after an integration, the main SHA merged in, and the tester reruns the
      checks it affects; it is a round. For a tester's finding the tester
      reruns that scenario and the criteria the fix touches, and the
      reviewer's verdict carries forward. For a reviewer's finding a fresh
      reviewer reads only the fix diff, its base as step 7 says, and the
      tester runs only if the fix changes something a criterion checks. A
      fix answering both roles is re-checked by both. A fix that answers no
      Tester or Reviewer finding — a CI fix, a flaky-test fix, a follow-up of
      the session's own, a hunk no finding named — is re-checked as a fix
      answering both roles is: a fresh Reviewer on the fix diff, and Tester
      reruns the checks it affects. After APPROVED WITH MINORS no reviewer
      runs again for them: a minor is fixed only when its fix carries forward
      or is such a wording fix, and any other goes into the pull request or a
      follow-up issue. A branch in a critical area gets the full pair once
      more under the lock (step 9).
    - The developer and the tester are resumed only if their last report
      arrived under 5 minutes ago; otherwise a fresh one is started with the
      branch, the base and head SHAs, the numbered findings and its previous
      report. The reviewer is never resumed in a correction round: it always
      starts fresh, with the brief of step 7 (D10).
    - Fixes that answer an outside review's findings (step 8) never carry a
      verdict forward, whatever files they touch, and are never the main
      session's wording fix.

## Pauses

An unavailable resource pauses the task, with its state, and the other tasks
go on: a plan limit (an HTTP 429, or a sub-agent stopped by a session limit),
Docker or the task's test resources, GitHub or the remote, GitHub Actions
minutes. Record it and end, the label kept:

```sh
node .claude/scripts/delivery-queue.mjs update <n> --session <id> --state paused --reason "<the resource and its decisive output>" --next "<the step to go on from>" --detach
```

A paused task holds no slot. A later fire whose checks pass resumes it (Resume
first). A task that holds the lock is not paused: it keeps the lock through a
short outage, and a fire that finds its session dead adopts it under a new
token. A pause is not an outcome: no result comment, and the label stays.

## Outcomes

Every task ends in exactly one of these, and every one of them removes
`state:ready` when the task leaves the queue. **Never leave the label on an
issue a task gave up on**: the label is what `pick` reads, and a failure left
in it is offered again to every later fire.

Every DELIVERED issue is closed and, when its description carries an
`Epic: #<epic>` line, its box in that epic ticked and the epic closed once it
was the last, as `docs/DELIVERY.md` step 6 says of every delivery, attended
or not; this section adds only the timing and the epic's comment. The epic
comes first, while the task still holds the lock and before `finish`, so that
two deliveries never write one epic's description at once (D25). The comment
that closes a finished epic reads:

```text
Scheduled run 2026-09-22 02:04:11 +0300: epic done — every child is delivered: #<n>, #<n>. Closing.
```

An epic already closed, or one with no `- [ ] #<n>` or `- [x] #<n>` line for
this issue under `## Children`, is left as it is, and the final message names
it. A failed step here is named in the result comment and the final message,
and does not change the task's outcome.

The task leaves the queue with
`node .claude/scripts/delivery-queue.mjs finish <n> <outcome> --session <id>`,
the outcome `delivered`, `blocked`, `recovered` or `stopped`, with
`--token <token>` when it holds the lock, which this releases; its output
lists the task's worktrees, which End of run removes. Then the same three
commands as ever, the comment written to a scratchpad file first, each in a
call of its own — the DELIVERED comment being the one step 6 asks for,
naming the merge commit's SHA:

```sh
gh issue comment <n> --repo <repo> --body-file <file>
gh issue edit <n> --repo <repo> --remove-label state:ready
gh issue close <n> --repo <repo>                    # DELIVERED only
```

If `gh issue edit` or `gh issue comment` fails, the API does the same thing:
`gh api --method DELETE repos/<repo>/issues/<n>/labels/state:ready`, and
`gh api --method POST repos/<repo>/issues/<n>/comments -F body=@<file>` for a
comment. Check the exit code of whichever form is used: a label that silently
stayed on is offered again by `pick`.

The follow-up issues the run filed, and the open issues it commented on in
place of filing one (steps 8 and 10), are named in the result comment on one
line, `Follow-up issues: #<n>, #<n>`, just before the `Owner action needed`
line, which stays the last line; without any, the line is left out. The
DELIVERED and BLOCKED templates below show where it goes.

Each template below may end with one more line, `Owner action needed: <step>`,
when the outside review of step 8 was skipped for a reason only the owner can
clear and the script's skip line carries `Owner action needed:`: the step is
copied from the end of that line, verbatim; the acknowledgement command
before it is the run's, not the owner's, and stays out of the comment.
Without such a skip, or when the line says `Owner action already reported`,
the line is left out. Once the comment carrying that line is posted, its exit
code checked, and the `PushNotification` of step 8 is sent, the run
acknowledges with `sh .claude/scripts/outside-review.sh --reported <key>`,
with the key that line names, from the worktree it ran the review in or the
main checkout. Until it does, the same skip says `Owner action needed:` again
at the next run, whatever other key is acknowledged, so a run that ends before
posting leaves the skip to the next one rather than losing it. An
acknowledgement that answers exit 3 recorded nothing and errs the same way;
the run names it in its report and goes on.

**DELIVERED.** Comment on the issue with the pull request, the merge commit
SHA, the main workflow's run, the version and tag (or `version unchanged`, or
no line about it with `delivery.versioning` false), the deployed check that
was made (none with `delivery.deploy` false), the epic ticked or closed, and
the follow-up issues, if any. Then remove the label and close the issue.

```text
Scheduled run 2026-09-22 02:04:11 +0300: DELIVERED. PR #47, merged as `a1b2c3d`.
Main workflow run 1234567 passed including deploy and smoke. Verified on
<site>: <what was checked and what it showed>. Version 0.7.0, tag v0.7.0 at
the merge commit. Epic #40: box ticked. Closing.
Follow-up issues: <the follow-up issues filed or commented on, if any>
Owner action needed: <the step from the outside review's skip line, if any>
```

**BLOCKED.** Comment with the concrete blocker, the pull request, still
draft, what the owner has to do, and the follow-up issues, if any, then
remove the label. The pull request stays draft and unmerged (step 4), the
branch is kept, the worktrees are removed.

```text
Scheduled run 2026-09-22 02:04:11 +0300: BLOCKED, not delivered. <The blocker,
concretely: what was attempted, the decisive output, why it cannot be resolved
under existing authority.> PR #47, still draft, holds the work so far.
`state:ready` has been removed. What it needs: <what the owner has to decide,
provide or fix>. The delivery cycle will not take this issue again while this
comment stands: finish that PR in an attended session, or file a fresh issue for
what remains — grooming (`/groom`) sets up either.
Follow-up issues: <the follow-up issues filed or commented on, if any>
Owner action needed: <the step from the outside review's skip line, if any>
```

**RECOVERED.** The delivery failed after deploying and the previously verified
service was restored under `docs/DELIVERY.md`'s recovery rules — at most one
automated attempt, by the `delivery.rollback` command or a revert pull
request (step 9), and nothing that destroys data. Same comment as BLOCKED
plus the recovery evidence: what was restored, how — the command and its
output, or the revert pull request and its merge commit — and that the smoke
passed afterwards. An `Owner action needed` line, where there is one, stays
the last line, after the recovery evidence. A `Follow-up issues` line, where
there is one, comes after the recovery evidence too, just before that line.
The cycle will not take the issue again, so what remains is finished in an
attended session or filed as a fresh issue, never re-queued with the label. A
rollback is never reported as a delivery and never tagged.

**STOPPED.** The owner stopped the task in an attended session. Its own
session ends it with `finish <n> stopped`; the comment says what was left,
and the branch and the pull request are kept. The owner detaches a task they
abandon —
`update <n> --session <their id> --next "stop: finish it as stopped" --detach`
— and the next fire adopts it and ends it so; a day task its session has not
detached is never adopted.

## End of run

- Every process this run started is already stopped, by the PID recorded when
  it started, at the step that started it: no dev server and no test runner
  is left listening, and each stop was confirmed where a port could be asked.
  A PID that would not die, a port that still answered, or a kill the
  classifier did not allow is named in the report, with the command it ran.
  Nothing is stopped here by port or by pattern, and no process this run did
  not start is touched.
- Before the run ends, the main session stops with `TaskStop` every task id a
  sub-agent reported as still running and it has not yet stopped — a task the
  sub-agent held only a task id for and could not stop — and the final
  message names each task id and which it was: stopped, or already ended, a
  `TaskStop` answering that the task is no longer running counting as
  stopped. A task id `TaskStop` could not stop is reported for the owner, like
  a PID that would not die.
- A task that left the queue has its worktrees removed, the ones `finish`
  listed, with `git worktree remove <path>`, and its test resources with
  `<taskDown>`, run from the main checkout — or, with `commands.taskDown`
  empty, nothing to remove, which the report says. A task still in the queue
  keeps both. If a removal fails, say so in the report and leave it; do not
  force it and do not prune another tree (D3).
- Leave the main checkout as it was found: on `<main>`, with no commits and
  no cleaning.
- Every fire ends with the status table,
  `node .claude/scripts/delivery-queue.mjs status`, a fire that did nothing
  included; the issue comments, the claim and the result, stay as they are.
- By day, 09:00–22:59 local time, a DELIVERED, BLOCKED or RECOVERED result,
  and a paused queue, also reach the owner as one notification sent with
  `PushNotification`, in the owner's language; a fire that does nothing sends
  none. At night, 23:00–08:59, results are reported in the result comment and
  the final message alone; an `Owner action needed` notification is sent at
  any hour (step 8). Where the session lists `PushNotification` as a deferred
  tool, it is loaded with `ToolSearch` first.
- Post the final chat message in the owner's language, `project.ownerLanguage`
  — the owner reads it on a phone. Short, with links, no narrative, and the
  status table after it. The shapes, given here in English, the parts a
  project without deployment or versioning lacks left out:

```text
Run 14:30 — delivered #12: <what works now>.
PR #47, merged as a1b2c3d, main workflow run 1234567 green, deploy and smoke
passed, checked on <site>. Version 0.7.0, tag v0.7.0. Issue closed.
```

```text
Run 14:30 — not delivered #12: <the reason in one line>.
PR #47 stays draft, state:ready removed, details in the issue comment.
```

```text
Run 14:30 — took #12 (2 of 3 slots in use), PR #47, waiting for review.
```

```text
Run 14:30 — resumed #12 from step 9: <what it found and what it did>.
```

```text
Run 14:30 — taking no new task: <all slots in use | no ready issues>.
In progress: #12, #15.
```

When every candidate was skipped or passed over, each named, with a skip's
reason:

```text
Run 14:30 — took no issue. Waiting for owner steps: #14.
Skipped: #15 — no design reference. Waiting for a dependency: #16 (#11).
```

Issues labelled `delivery:attended` are named in neither: the run does not
list them.

Issue and pull request comments are in English, because the issues are; the
chat message and the notifications are in the owner's language.

## Permissions

A permission prompt in an unattended run stalls the session until the owner
answers it, hours later at best: the task stops where it stood, holding its
slot or the lock until its session is presumed dead. So the run must start
in Auto, and every command it runs must be granted or need no grant.

A headless run that the launchd job starts is given its mode on the command
line, `--permission-mode auto` (D17). A desktop-app scheduled task is not:
the app's per-task permission-mode picker has not been seen to persist, and
a scheduled session starts in the `defaultMode` the settings files name, and
in a prompting mode when none of them does. Auto comes from the user-level
`~/.claude/settings.json`, `permissions.defaultMode` set to `"auto"` — the one
file where that value is honoured — which `/flow-init` asks the owner to set.
`.claude/settings.json` sets none, because a project value can only be a
prompting mode and would outrank the user file. That user file is outside
this repository and outside what the run can read, so the mode a run starts
in is confirmed by hand, as `docs/RESOURCES.md` says.
`.claude/settings.local.json` must not set `permissions.defaultMode` either —
it is gitignored and outranks the project file, so it could reintroduce a
prompting mode that no check can see; it is read by hand whenever the
cycle's mode is confirmed. On top of that, every command this procedure and
its sub-agents run is allowlisted in `.claude/settings.json`, with the single
exception described below. The rules in the settings files apply to a
scheduled session as they do to any other, alongside whatever per-task
approvals a desktop task's own `Always allowed` panel has collected from a
`Run now` answered by hand. Those per-task approvals live in the app and are
invisible from here, so nothing below relies on them.

The rules are written for the plain command forms — `git commit …`, not
`git -C <path> commit …` — so run a command in a worktree by changing into it
first, in the same call. A `curl` is written with its options first and the
URL last — `curl -sS -X POST -H '…' -d '…' <site>/…` — because the rules
match on the prefix and anything between `curl -sS` and the URL otherwise
breaks it. The merge is the queue's,
`node .claude/scripts/delivery-queue.mjs merge …`, which runs `gh pr merge`
itself, so `gh pr merge` needs no rule and has none. The read-only built-ins
need no rule and never prompt in any mode: `git status`, `ls`, `cat`, `pwd`,
`date`, `head`, `tail`, `grep`, `find`, `which`, `diff`, `stat`, `du`, `cd`,
`echo`, `wc`. They are deliberately absent from the block below, which lists
only what needs granting — `date` excepted, which is granted anyway because
it is the first command of every run and a stall there happens before any of
the outcome machinery below exists.

**An allow rule does not override an ask or a deny rule.** Anything listed
under `permissions.ask` or `permissions.deny` in the settings files — a
command that destroys local data, say — still prompts or is refused when a
broader allow rule matches it, and so is not run unattended. A suite failing
in a way that looks like it wants clean data is a BLOCKED outcome, not a
reset.

A command that is neither one of those built-ins nor covered below is not run
unattended, with exactly one deliberate exception: `kill <pid>`, and
`kill -9 <pid>` as the second attempt, each put to the permission system once
per attempt, as described next. Freeing a port by pattern, stopping a process
this run did not start, installing a tool, anything under `sudo`, and
`git worktree prune` — which this run never does (D3) — end the task
BLOCKED instead.

**`kill` is deliberately not granted.** Stopping a process this run started
itself, by the PID it recorded at start, is what step 6 requires — and no
rule below permits it, on purpose, in either form: neither `kill <pid>` nor
the `kill -9 <pid>` that follows it. An allow rule takes a command away from
the mode's classifier altogether, so `Bash(kill *)` would auto-approve
`kill -9 <any PID on this machine>`, the granted form of a kill by pattern,
and the prose in step 6 would be the only guard left. A PID cannot be written
into a narrower rule either: it is a different number every time. So every
attempt goes to the classifier on its own — `kill <pid>` once, and
`kill -9 <pid>` once if it is needed — with the PID visible in the command,
and in Auto, the mode a scheduled session starts in, that decides without
putting a prompt in front of an absent owner, so it cannot stall a fire. A
kill the classifier does not allow leaves the process running: report it
with its PID and the command it ran, like a PID that will not die.
`TaskStop`, which stops a background task by its task id (step 6 and End of
run), is a tool, not a Bash command: no rule below covers it, and none is
needed, because Claude Code's tool reference lists it among the tools that
ask no permission. `PushNotification`, which sends the owner a desktop
notification — and to the owner's phone too, once Remote Control is
connected — is a tool as well, not a Bash command, so no rule below covers
it. It may answer that a notification was not sent, because it would be
redundant or notifications are turned off; that is not a failure, and the
result comment still carries the `Owner action needed` line. The outside
review of step 8 is one rule, `Bash(sh .claude/scripts/outside-review.sh *)`:
the script runs Codex itself, and `codex` is neither run directly nor
granted. The same rule covers its acknowledgement,
`sh .claude/scripts/outside-review.sh --reported <key>`. The queue is one
rule, `Bash(node .claude/scripts/delivery-queue.mjs *)`, which covers its
merge too.

The project's own commands are granted by rules `/flow-init` writes from
`.claude/flow.json`: two per command it names — `commands.install`, `check`,
`test`, `taskTest`, `taskDown`, `e2e`, `build` and `delivery.rollback` —
the exact command as `Bash(<command>)` and `Bash(<command> *)`, `{task}`
written as `*`; and, with `<site>` set, `Bash(curl -sS <site>/*)` and
`Bash(curl -sS * <site>/*)`. A pull request that changes `commands.*` or
`delivery.rollback` in `.claude/flow.json` adds the matching rules to
`.claude/settings.json` in the same pull request, and
`.claude/tests/flow-consistency.test.mjs` fails one that does not: without
them this run cannot run the new command, since a command no rule covers is
not run unattended (`docs/DELIVERY.md`, Configuration). A
command among them that sets a variable in front of itself is not granted by
its rule: the project wraps it in a script of its own, which the rule names.
`<owner>/<name>` below is `project.repo`, written into the rules the same way.
`lsof` is still neither run nor granted unattended, and a process this run
did not start is never touched. A change to this procedure that introduces a
new command adds its rule to `.claude/settings.json` and to this block in the
same pull request.

**A refusal that begins `guard-bash refused this command` is not a permission
prompt.** It is the project's hook, `.claude/scripts/guard-bash.mjs`, which
`.claude/settings.json` runs before every Bash call, here and inside the
sub-agents (D9). It refuses `git commit` in this repository where the
branch is `<main>` or where a `node_modules` of the worktree is a symlink;
`lsof` fed into `kill`, `pkill` and `killall`; every merge that does not go
through the queue's `merge` — `gh pr merge` with any options, `gh api` on a
pull request's `merge` path as GitHub routes it, any method, a GraphQL body
carrying `mergePullRequest` or `enablePullRequestAutoMerge`, and
`gh pr create` or `gh pr edit` with an auto-merge option — with a token or
without (D16); a `git push` whose refspec targets the main branch, and any
force push (D26) — on a plan where the repository's rulesets cannot protect
the main branch, this rule is the only mechanism that does; and inside the
`developer`, `tester` and `tester-process` sub-agents any `lsof`. Inside any
sub-agent it also refuses the outside review of step 8 and Codex (D12): the
script and its helper `.claude/scripts/outside-review.mjs` in the spellings
it reads — by path, through a shell or `node` after their options, sourced,
on standard input, behind a wrapper, in a substitution — `codex` itself with
any subcommand, and a command it cannot read to its end that names either; a
sub-agent is told by `agent_id`, so this session, the main one, is never
refused it. That holds "never by a sub-agent" of step 8 for those spellings
only: a name built when the command runs, a renamed copy, `npx codex`,
`sh -c` and `cat … | sh` are out of its reach, and there the rule stays a
rule. Everything else it lets through to the rules below; it grants nothing.
The call is refused at once, so nothing waits for an answer, and its one
line names what to do instead, which is what this procedure already says:
commit in the task worktree, never in the main checkout — the guard takes
the directory from a `cd` or a `git -C` in the same call, and otherwise the
one the call runs in; install dependencies in the worktree; stop a process
by its recorded PID or a task with `TaskStop`; take the lock and merge with
the queue's `merge`; push the task branch, never main. Do that, and do not
try the refused thing in another spelling. If the guard refuses a command
this procedure prescribes, the defect is the guard's: the task ends BLOCKED
and quotes the line, and the owner, in an attended session, takes the
`hooks` key out of `.claude/settings.json` through a pull request of its own,
together with whatever test requires it.

```text
Bash(date *)
Bash(sleep *)
Bash(ps -o pid,ppid,command)
Bash(ps -o pid,ppid,command *)
Bash(docker info *)
Bash(git symbolic-ref *)
Bash(git rev-parse *)
Bash(git worktree list)
Bash(git worktree list *)
Bash(git fetch origin)
Bash(git fetch origin *)
Bash(git switch *)
Bash(git branch *)
Bash(git merge-base *)
Bash(git ls-files *)
Bash(git log *)
Bash(git diff *)
Bash(git show *)
Bash(git worktree add *)
Bash(git worktree remove *)
Bash(git add *)
Bash(git commit *)
Bash(git merge origin/*)
Bash(git revert *)
Bash(git push origin HEAD)
Bash(git push --set-upstream origin HEAD)
Bash(git tag -a v*)
Bash(git push origin refs/tags/v*)
Bash(git ls-remote origin *)
Bash(sh .claude/scripts/delivery-preflight.sh)
Bash(sh .claude/scripts/delivery-preflight.sh *)
Bash(sh .claude/scripts/tree-fingerprint.sh *)
Bash(sh .claude/scripts/review-artifact.sh *)
Bash(sh .claude/scripts/outside-review.sh *)
Bash(node .claude/scripts/delivery-queue.mjs *)
Bash(node .claude/scripts/flow-config.mjs *)
Bash(node .claude/scripts/check-version.mjs *)
Bash(node --test *)
Bash(gh auth status)
Bash(gh issue list *)
Bash(gh issue view *)
Bash(gh issue comment *)
Bash(gh issue edit *)
Bash(gh issue close *)
Bash(gh issue create *)
Bash(gh pr list *)
Bash(gh pr view *)
Bash(gh pr create *)
Bash(gh pr comment *)
Bash(gh pr edit *)
Bash(gh pr ready *)
Bash(gh pr diff *)
Bash(gh pr checks *)
Bash(gh run list *)
Bash(gh run view *)
Bash(gh run watch *)
Bash(gh api --method POST repos/<owner>/<name>/issues/*/comments *)
Bash(gh api --method DELETE repos/<owner>/<name>/issues/*/labels/*)
Bash(curl -sS http://localhost:*)
Bash(curl -sS * http://localhost:*)
```
