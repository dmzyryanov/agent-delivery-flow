# Change delivery

## Authority

The owner approves this process by running `/flow-init`
(`.claude/skills/flow-init/SKILL.md`), which records the date in `CLAUDE.md`
(D24).

An owner-approved task and design (when applicable) authorise the Coordinator
to implement, push, open/update the PR, fix findings, merge, observe the
deployment, verify the site, tag a changed version, and recover a failed
delivery within the limits below. No separate owner acceptance, morning
visual review, or merge approval is required. A narrower instruction for a
particular task (plan only, draft only, no merge) takes precedence.

**"Coordinator" below names a function, not a sub-agent.** The main session
performs it: it holds git and GitHub access, reads each role's report directly
rather than as a summary of a summary, and can ask the owner mid-run. The
sub-agents are `developer`, `tester` and `reviewer`, with `architect` as a
read-only tool invoked on demand; `tester-look` is a narrower variant of
`tester` for the grooming's look, and `tester-process` a copy of `tester` on
another model for the PRs step 4 routes to it (D21). The name is left as it
stands throughout this document, because the responsibility it describes did
not change. The Coordinator invokes any of these roles, `architect` included,
without a `model` parameter, because that parameter overrides the model pinned
in the role's definition (D8).

## Configuration

`.claude/flow.json` holds the project's configuration of this process (D23):
`/flow-init` fills it, the scripts read it through
`.claude/scripts/flow-config.mjs`, and this document names its values as
`commands.check`, `delivery.deploy` and so on. `main` below is
`project.mainBranch`, and every `gh` command names the repository with
`--repo` and `project.repo`. These values turn steps off:

- `delivery.versioning` false: no `VERSION` bump or `CHANGELOG.md` entry, no
  version set under the delivery lock, no tag (step 6, Version).
- `delivery.deploy` false: step 6 is the run of the main workflow for the
  merge commit passing — no deploy, no smoke, no site check — and the
  delivery lock is released once it has passed and the tag is pushed;
  Recovery reduces to a fix or revert PR.
- `delivery.rollback` empty: recovery after a failed deploy or smoke is a
  revert PR through the same lock, never a command (Recovery).
- `outsideReview.enabled` false, or a branch that touches none of
  `outsideReview.areas`: step 4's outside review does not run, and the PR
  records why in one line.
- `design.figma` false: no Figma directions; the design reference is a saved
  image or a description in the issue (step 3).
- `commands.taskTest` empty: suites run with `commands.test`, and tasks
  developed side by side then must not share state the suite writes (Several
  tasks at once).
- `project.site` empty: there is no site to check changed behaviour on; the
  main workflow's run is the evidence.
- `schedule.cycle`, `schedule.grooming`, `schedule.morningFire`: when the
  scheduled tasks fire (Unattended scheduled runs).

`delivery.draftPullRequests` says how a PR is held back until it is to merge
(D22). GitHub has no draft pull requests on a private repository of a Free or
Pro account, so the key is false by default, and `/flow-init` sets it true for
a public repository or a private one on Team or Enterprise.

- True: the PR is opened with `gh pr create --draft …`, marked ready with
  `gh pr ready <n> --repo <project.repo>`, and put back to draft with
  `gh pr ready <n> --repo <project.repo> --undo`.
- False: the PR is opened with `gh pr create …` without `--draft`, its title
  prefixed `Draft: `; it is marked ready with
  `gh pr edit <n> --repo <project.repo> --title '<title without the prefix>'`,
  and put back to draft by the same command re-adding the prefix. The title
  goes in single quotes, with none inside it, so that a backtick in it is not
  a command substitution.

Either way a PR is *draft* while it is a GitHub draft or its title starts
`Draft: `, and a draft PR is never merged: marking it ready is the step right
before the queue's `merge` (step 5), and "the PR, still draft" below means
either form.

The project's own commands — `commands.*` and `delivery.rollback` — run
without a prompt only through allow rules in `.claude/settings.json`, which
`/flow-init` writes from `.claude/flow.json`. A PR that changes any of them in
`.claude/flow.json` adds the matching allow rules to `.claude/settings.json`
in the same PR: the exact command as `Bash(<command>)` and
`Bash(<command> *)`, `{task}` written as `*`.
`.claude/tests/flow-consistency.test.mjs` fails a PR that does not. Without
them an unattended run cannot run the new command: a command no rule covers
is not run unattended (`.claude/scheduled/delivery-cycle.md`, Permissions).

## Modes

A task names one mode. `full` is the default for an owner-approved
implementation request; a narrower mode is an explicit instruction.

- `plan`: investigate and answer. No branch, no PR, no implementation, and a
  discussion mentioning a future feature does not start one.
- `review`: read an existing diff and return a verdict. Nothing is mutated.
- `verify`: run the stated criteria against a named SHA and report evidence.
- `draft`: implement and verify one PR, then stop before merge.
- `full`: implement, verify and review, merge, follow the deployment, verify
  the changed behaviour on the site, and tag a changed version — each as far
  as Configuration leaves it on.

A scoping or grooming chat ends in a written issue, not a delivery; filing
follows `/create-task` (`.claude/skills/create-task/SKILL.md`), and grooming
`/groom` (`.claude/skills/groom/SKILL.md`). A large goal goes to `/decompose`
(`.claude/skills/decompose/SKILL.md`), which files it as an epic labelled
`type:epic`, its `## Children` the small issues it is delivered through, each
groomed and delivered as any other (D25). The scheduled grooming
(`.claude/scheduled/grooming.md`) is the same as `/groom`, unattended: one
issue per run, no branch, worktree, commit or PR, and the issue left
`state:ready` on the narrow class that procedure defines or
`state:needs-owner` (D14).

When `delivery.deploy` is true, the environment the main workflow deploys to
is the owner's. Keep its name, domain, credentials and CI routing; this
process does not authorise deleting data or weakening security.

## One task, one PR

1. Capture the owner's goal, scope, observable acceptance criteria, design link
   or saved design reference, target version and recovery plan in one PR,
   opened as a draft (Configuration).
   A conversational handoff is sufficient input: record it in that same PR.
   A new brief, issue, milestone or requirements-only PR is not a prerequisite.
   The PR names its issue as `Issue: #<n>`, never with a closing keyword
   (`Closes`, `Fixes`, `Resolves`): GitHub would close the issue at the merge,
   before the deployed check, and step 6 closes it (D22).
2. Run `sh .claude/scripts/delivery-preflight.sh` twice: once from `main`
   before branching, and once from the task branch after cutting it. The first
   call fetches `origin`, verifies that the base carries the six agent
   definitions — a branch cut from a base without them loses the team on
   checkout — reports the worktrees without pruning any, and prints the
   BASE_SHA to record plus the `git worktree add` command to run next, at a
   path outside the repository. Read that worktree report before branching:
   a tree belonging to another session — a task in the delivery queue, or an
   attended session's — is left alone, never tidied, a tree inside the
   repository is moved out, and a stale entry left by a crashed run of your own
   is pruned there and then, deliberately, by a person in an attended session
   (Worktrees); an unattended run never prunes. The
   second call derives the commit the branch was actually cut from, checks the
   definitions there, and prints it as the BASE_SHA: that is the value the run
   stays pinned to, and it is what the diff and a review of the whole change
   are taken against until main is integrated. `origin/main` advancing while
   the task is in flight does not change it; the script says so and step 5
   integrates main before merging. From that integration on, for one task as
   for several, that review artifact's base is the main SHA merged in (Several
   tasks at once); a review of a fix alone starts at the reviewed SHA (step 4).
   A branch sharing no history with the base fails. The PR targets `main`, and
   there is no release or develop branch.
3. Implement code, tests and necessary documentation in this PR. Commits may
   contain their related documentation. Consult the Architect for material
   technical choices; do not require a full architecture pass for a small edit.
   With `design.figma` true, Claude draws the design in Figma — two or three
   directions for a new screen — and the owner approves it before
   implementation; otherwise the design reference is a saved image or a
   description in the issue, which the owner approves the same way. There is
   no Designer agent.
4. Developer checks the change; Tester verifies the acceptance criteria and
   Reviewer independently reviews the final diff. Fix material findings,
   within the round cap of Decisions and compatibility below.
   Rerun checks affected by fixes; do not repeat a full local regression just
   for prose. All required checks still run and must pass. Reviewer APPROVED
   WITH MINORS and Tester PASS may merge the reviewed SHA, as step 5 permits;
   minors left unfixed are recorded in the PR or in a follow-up issue.

   A PR whose changed files against its base all match `*.md` or lie under
   `.claude/` is verified by `tester-process`; every other PR is verified by
   `tester` (D21). The class is not text alone: the scripts, tests and
   settings under `.claude/`, such as `delivery-queue.mjs` and
   `delivery-areas.json`, are in it. A PR whose diff warrants the tester's
   hostile-input pass, one that touches a parser, a formatter, a regular
   expression, redaction, or URL, header or request-line handling, such as
   the Bash guard, stays with `tester`, even inside the class. If
   `tester-process` is not available in the session, `tester` verifies.

   If minors are fixed, the Reviewer verdict and the Tester PASS carry forward
   to the fix commit only when all of these hold:

   - `git diff --name-only <reviewed SHA> <fix SHA>` lists only `*.md` files;
   - none of them is `CLAUDE.md`, `docs/DELIVERY.md`, `CHANGELOG.md`, a file
     under `.claude/`, a contract document of a part `docs/ARCHITECTURE.md`
     lists under `Stable parts`, or a Markdown file the product serves or
     ships at run time;
   - every changed hunk is at a place one of the reviewer's numbered minors
     named: the Coordinator compares the diff with the findings, hunk by hunk;
   - the fix commits sit directly on the reviewed SHA, with no integration of
     main between them.

   The Coordinator records in the PR the reviewed SHA, the fix SHA, the files,
   and the finding number each hunk answers. Anything else is re-checked as
   follows, a fix only by the role whose finding it answers and only the fix;
   a verdict the re-check leaves standing carries forward, and the PR records
   it (D19):

   - **A wording fix.** The Coordinator itself fixes a documentation or
     wording finding of Tester or Reviewer, of any severity, whose fix touches
     only `*.md` files, none of them one the second condition excludes: every
     hunk answers a named finding, which it checks hunk by hunk, and it records
     the fix in the PR as above. It makes the fix while no Developer is at
     work in that worktree, before one is started or after its report. No
     agent is started, and the fix is not a round. A FAIL or CHANGES REQUESTED
     whose findings that stop a merge were all of this kind counts, once they
     are fixed, as PASS or APPROVED for the fix. A documentation or wording fix
     that touches an excluded file is checked as before: a fresh Reviewer on
     the branch's whole change, its `Base` the `BASE_SHA` or, after an
     integration, the main SHA merged in, and Tester reruns the checks it
     affects; it is a round.
   - **A Tester finding.** Tester reruns that scenario and the criteria the
     fix touches; the Reviewer verdict carries forward.
   - **A Reviewer finding.** A fresh Reviewer gets the brief below with
     `Base` set to the reviewed SHA, or the SHA its verdict was carried to,
     so it reads only the fix diff, next to its earlier findings verbatim.
     Tester runs only if the fix changes something a criterion checks. A fix
     answering both roles is re-checked by both. A fix that answers no Tester
     or Reviewer finding — a CI fix, a flaky-test fix, a follow-up of the
     session's own, a hunk no finding named — is re-checked as a fix
     answering both roles is: a fresh Reviewer on the fix diff, and Tester
     reruns the checks it affects.
   - **Minors.** After APPROVED WITH MINORS no Reviewer runs again for them:
     a minor is fixed only when its fix carries forward under the four
     conditions above or is a wording fix; any other minor goes into the PR
     or a follow-up issue.
   - **Critical areas.** When the branch's changed files, mapped by
     `node .claude/scripts/delivery-queue.mjs areas <branch>`, fall in an
     area that `.claude/delivery-areas.json` marks `"critical": true`, the
     full pair — Tester on every criterion, and a fresh Reviewer on the
     branch's whole change — runs once more on the SHA that is to merge,
     after main is integrated, whatever the items above skipped. It does not
     when their full verdicts are already for that SHA, or carried to it under
     the four conditions above or by a wording fix.
   - **Merging main in.** The Coordinator checks by its diff an integration
     whose conflicts are none or only in the bookkeeping files
     `.claude/delivery-areas.json` names, the version it sets included, and
     the checks run: the verdicts carry forward, and no Reviewer is started
     but for a critical area. Any other conflict resolution goes to a fresh
     Reviewer on the branch's whole change, and Tester reruns the checks it
     affects.

   The checks run for every SHA, and they must still pass for the merged SHA
   (step 5).

   A criterion that needs a rendered page compared with the approved design
   reference is one Tester answers when it has the client-provided browser
   tools, which it confirms with `ToolSearch` rather than assuming (D4).
   When it does not have them it reports that criterion NOT VERIFIED and does
   not describe a page it did not see; the main session then makes the
   comparison itself and records the result in the PR, naming the design
   reference and the screens it compared. The deployed service is the other
   such judgement and is confirmed in step 6 either way.

   The Coordinator — the main session, outside the Tester session — runs
   `sh .claude/scripts/tree-fingerprint.sh <worktree>` immediately before and
   after each Tester run and compares the two readings itself. Tester may quote
   and re-read the value, but that reading is corroborating only: the audited
   agent does not report whether it stayed inside its boundary. A mismatch means
   that run's verdict is discarded, the worktree is removed and recreated at the
   reviewed SHA, and the verification is run again.

   Reviewer holds no shell, so its diff is produced for it by
   `sh .claude/scripts/review-artifact.sh <base> <head> <path>`, run in the
   worktree that holds `<head>`: the script refuses to run in any other tree.
   Its header records the base, the head and the fingerprint the verdict
   applies to.

   Outside review is run by the Coordinator, with no label (D12, D15): a
   review by another vendor's model, OpenAI's Codex CLI signed in with the
   owner's account, run by the main session and never by a sub-agent. It runs
   only when `outsideReview.enabled` is true, at most once per task, on the
   final candidate: after Tester has passed and Reviewer has approved a SHA,
   or a verdict step 5 accepts in their place, on that SHA, and only when the
   change touches one of the areas `outsideReview.areas` names — areas of
   `.claude/delivery-areas.json`, a branch's files mapped onto them by
   `node .claude/scripts/delivery-queue.mjs areas <branch>`. The owner names
   those areas at `/flow-init` for the code where a defect costs most, the
   parts the first of `CLAUDE.md`'s Development priorities protects.

   It does not run for any other change: not on the Coordinator's judgement
   for code outside those areas, never a second time on the fixes it caused,
   and never for a change to documentation or process text alone. When it
   does not run, the PR says why in one line: disabled, or no listed area
   touched.

   Where a blocking automated test can cover the risk, that test is still
   preferred. The run is
   `sh .claude/scripts/outside-review.sh <artifact> <issue-file> <output-file>`,
   in the worktree that holds the head, with the artifact for that SHA, the
   issue description verbatim in a file, and an output path outside the
   worktree. It takes minutes, so it is called with Bash
   `run_in_background: true` and its completion notice is waited for.
   `.claude/settings.json` allows `Bash(sh .claude/scripts/outside-review.sh *)`
   and not `codex` itself. The models, the allowance it keeps for the owner,
   its exit statuses and what each skip means are in
   `docs/tooling/codex.md`.

   The Coordinator posts Codex's notes on the PR verbatim, in one comment
   naming the reviewed SHA and the model, and answers every numbered finding
   there: fixed in `<sha>`, filed as follow-up `#<n>`, or declined with the
   reason. "No findings." is posted too. A finding graded blocking that lies
   inside the task's scope is fixed within the round cap (Decisions and
   compatibility); after the third round it is fixed only when it is a
   blocking defect as that section defines it, and otherwise filed as a
   follow-up. A finding that is wrong is declined with the reason recorded; if
   the Coordinator would decline a blocking finding about a material risk, it
   asks the owner in an attended session, and in an unattended run the run
   ends BLOCKED with the PR, still draft, and the finding named. Every other
   finding becomes a follow-up issue filed with `/create-task`. Fixes made in
   answer are ordinary changes: a fresh Reviewer reads them as it reads a
   Reviewer finding's fix, with `Base` set to the reviewed SHA, and Tester
   reruns what they affect in every case, since they never carry a verdict
   forward, whatever files they touch — an exception to the carry-forward and
   to the wording fix above.

   A skip — exit 3 and one line `outside review skipped: <reason>` — is never
   a verdict and does not stop the delivery: the PR records the reason and
   merges on the internal verdicts. A skip that needs the owner — Codex
   missing; its login missing, expired, or signed in but not with ChatGPT; or
   the allowance used up with no credits, a window at 100% or both models
   refused for their allowance; the full list is in `docs/tooling/codex.md`,
   and the caller goes by the `Owner action needed:` marker either way — is
   reported once until it is fixed: in an attended session once in the chat,
   at once, with the step; in an unattended run in its result comment on the
   issue, as the line `Owner action needed: <step>`, and in one desktop
   notification sent with `PushNotification`, which also reaches the owner's
   phone when Remote Control is set up. The script tells the caller
   which skip is still to be reported: report only a line carrying
   `Owner action needed:`; a line saying `Owner action already reported` is
   recorded in the PR as a skip and not reported again. A skip counts as
   reported only once the owner has been told: after telling the owner — in
   an attended session in the chat; in an unattended run once the result
   comment carrying the line is posted and `PushNotification` is sent — the
   Coordinator acknowledges the
   key its line names, with the command the line gives,
   `sh .claude/scripts/outside-review.sh --reported <key>`, from the worktree
   it ran the review in, or the main checkout; that marks the key alone.
   Until then the same skip says `Owner action needed:` again, so a session
   that stops before telling the owner leaves it to the next one, whatever
   other key is acknowledged meanwhile; an acknowledgement that answers exit 3
   recorded nothing, which errs the same way and is named in the report. The
   script keeps that record outside the repository and forgets a skip once a
   later run sees it fixed (`docs/tooling/codex.md`). Other skips — the
   owner's quarter of the allowance, a run that failed — are named in the PR
   and in the run's report only.

   Reviewer's brief is this template with its fields filled in and nothing
   added, in an attended session and in an unattended run alike:

   ```text
   Review the change in this artifact against the issue description below.

   Artifact: <path>
   Base: <base SHA>
   Head: <head SHA>

   Issue description, verbatim:
   <the issue's description>

   Previous reviewer findings, verbatim:
   <the previous reviewer's findings>
   ```

   The brief carries only the issue description verbatim, the artifact path,
   and the base and head. Its last two lines are for a Reviewer started fresh
   in a correction round, which also gets the previous reviewer findings
   verbatim; every other brief leaves them out. Never Developer's or Tester's
   conclusions, nor a summary of the change or of the fix: a Reviewer told
   what another role concluded is checking that conclusion, not the change
   (D2). A task with no issue puts the goal, scope and criteria recorded in
   its PR (step 1) in the description's place, verbatim too. A design link or
   an acceptance criterion added in an issue comment counts as part of the
   description and follows it, verbatim too, and nothing else from the
   comments does: no delivery note and no role's conclusion.

   In a correction round, Developer and Tester are resumed only if their last
   report arrived under 5 minutes ago, while their prompt cache still holds;
   otherwise a fresh one is started with the branch, the base and head SHAs,
   the numbered findings and its previous report. Reviewer is never resumed in
   a correction round: it always starts fresh, with the brief above and the
   previous reviewer findings verbatim (D10).

   A Developer whose report opens with `Handover` has reached about 350k
   tokens of context (D20): the Coordinator starts a fresh Developer with the
   original brief, the branch, the base and head SHAs and the handover note,
   the same path a correction round uses for a fresh one. A handover is not a
   correction round.
5. Coordinator checks the latest PR head SHA, correct base, mergeability
   (`mergeable` and `mergeStateStatus` from `gh pr view`), resolved blocking
   review threads, Tester PASS, Reviewer APPROVED/APPROVED WITH MINORS —
   each given for that SHA, by a full check or a re-check step 4 limits, or
   carried forward to it from the reviewed SHA under step 4's conditions and
   recorded in the PR, and in a critical area the full pass step 4 requires
   on that SHA; after the third correction round, a Tester or Reviewer
   verdict for that SHA whose every
   open finding the Coordinator rated not blocking and filed as a follow-up
   listed in the PR stands in their place (Decisions and compatibility) —
   where an outside review ran, outside notes posted and every finding
   answered, or the recorded skip or reason it did not run,
   and the PR's checks passed for that exact SHA with every required check
   passed (`gh pr checks`, and `gh run list --commit <sha>` for the runs): a
   verdict carries forward, a check does not. A skipped, cancelled or neutral
   check does not count as a passed required one. Preserve the repository's
   rulesets. If main changed, integrate it, resolve conflicts, and check the
   combined state as step 4 says of merging main in.
   Merge through GitHub with the checked head SHA as a concurrency guard; the
   repository deletes the merged head branch itself, a setting `/flow-init`
   makes. A draft PR is never merged: the Coordinator marks it ready
   (Configuration) right before the queue's `merge`, and a PR that then does
   not merge and whose task ends BLOCKED goes back to draft. Merge and
   deployment happen under the delivery lock (Several tasks at once): the
   Coordinator takes it with
   `node .claude/scripts/delivery-queue.mjs lock <task> --session <id>` and
   merges through the queue with the token it prints,
   `node .claude/scripts/delivery-queue.mjs merge <task> --token <token> --sha <sha>`,
   which checks that the token is the lock's current one and then runs
   `gh pr merge <pr> --repo <project.repo> --merge --match-head-commit <sha>`
   itself, the SHA written in full — no `--auto`, `--admin` or
   `--delete-branch`; the Bash guard refuses every other way of merging, with
   a token or without (D16). All GitHub operations target `project.repo`;
   the main session supplies `--repo` explicitly on PR and issue commands and
   the checked head SHA on merge. No direct main push or force push is
   authorised, and the Bash guard refuses both (D26).
6. Follow the run of `.github/workflows/<delivery.mainWorkflow>` for the
   resulting merge commit (`gh run list --commit <sha>`, then
   `gh run watch <id> --exit-status`): the `validate / flow` and
   `validate / project` jobs, which reuse `ci.yml`, then `deploy` and
   `<delivery.smokeJob>`; with `delivery.deploy` false the run validates
   only, and its conclusion passing ends this step but for the tag and the
   issue. Verify changed behaviour on the deployed service where it is not
   covered by the generic smoke. The owner has authorised disposable test
   data on that service for the verification; touch no data that is not the
   check's own.
   Then publish the version if it changed (Version).

   Then close the issue, in an attended session as in an unattended run: an
   issue a delivery leaves open keeps every issue whose `Depends on` line
   names it waiting for ever. A task with no issue has nothing to close.

   - **Its epic.** When the issue's description has an `Epic: #<e>` line, the
     Coordinator ticks the issue's box in that epic while it still holds the
     delivery lock, before
     `node .claude/scripts/delivery-queue.mjs finish <task> delivered --session <id> --token <token>`
     takes the task out of the queue and releases the lock, so that two
     deliveries never write one epic's description at once (D25). It reads
     the epic, `gh issue view <e> --repo <project.repo> --json number,state,body`;
     writes the whole body, with the issue's `- [ ] #<n>` line under
     `## Children` turned to `- [x] #<n>`, to a scratchpad file with the
     Write tool; and in a later call — never in the same parallel batch as
     that Write, which gives no order —
     `gh issue edit <e> --repo <project.repo> --body-file <file>`, its exit
     code checked. A box already ticked needs no edit; an epic already
     closed, or one with no line for the issue, is left as it is and named
     in the report. When no `- [ ]` box is left under `## Children`, the epic
     is done: a comment on it saying that every child is delivered, naming
     them, `gh issue comment <e> --repo <project.repo> --body-file <file>`,
     then `gh issue close <e> --repo <project.repo>`.
   - **The issue.** A comment naming the merge commit's SHA,
     `gh issue comment <n> --repo <project.repo> --body-file <file>`, then
     `gh issue close <n> --repo <project.repo>`. An unattended run's
     DELIVERED result comment is that comment, posted once the task has left
     the queue (`.claude/scheduled/delivery-cycle.md`, Outcomes).

   A step here that fails is named in the report and does not undo the
   delivery. Then give a short evidence-based report.

Split into multiple PRs only for a concrete delivery, review or recovery reason;
a split made at grooming (`/groom`, D20) is one.
Multiple agents do not imply multiple PRs. There is one delivery to this
environment at a time: the delivery lock is held from the integration of main
until the deployment has passed smoke and the site check, or has been
recovered, and no other PR merges meanwhile.

### Worktrees

Each role works in its own `git worktree`, so verification runs on a stable tree
at the same time as implementation continues, and so unrelated local work in the
main checkout is never disturbed. **A worktree goes outside the repository** —
a sibling directory such as `<repo>-worktrees/<task-branch>`, which is what the
preflight prints. A path inside the repository has to be ignored, or every tree
fingerprint moves; and an ignored path inside the repository is exactly what
`git clean -xdf` removes. Sessions share the one checkout, so a routine clean by
any of them deletes every other session's working tree, and the loss is silent
(D3). `.gitignore` still lists `.claude/worktrees/` so that a worktree someone
puts there anyway does not move the fingerprint: the entry is damage control,
not the recommended location.

Every worktree runs its own `commands.install`. A dependency directory —
`node_modules`, a virtual environment — is never symlinked between them: an
ignore pattern such as `node_modules/` matches a directory, not a symlink of
that name, so a symlinked tree turns up as an untracked path, moves the
fingerprint and can be committed by accident.

Worktrees are removed with `git worktree remove` at the end of the run. A run
that crashes leaves both an administrative entry and, usually, the directory
itself. `delivery-preflight.sh` prunes nothing. It lists the worktrees, names
the entries whose directory is gone, names the worktrees the run did not create
— measured as every tree that is neither the main checkout nor the one it was
called from — and names any worktree sitting inside the repository, and it
leaves every removal to a person. Pruning was dropped because it
destroys evidence: an entry left by your own crashed run and an entry whose
tree another session was working in until something deleted it are identical
afterwards, so the prune hides the second case (D3). Read the list, establish
which case it is — a concurrent session's tree is a reason to leave it alone,
not to tidy it — then run `git worktree prune` deliberately, a person in an
attended session: no allow rule grants it, so it always asks, and an
unattended run never runs it (D3). The same applies to a leftover directory,
which no prune removes: until it is gone, a later `git worktree add` to that
path fails.

Processes are owned like trees: each role stops what it started before it
reports (D5, D6), and the main session stops with `TaskStop` any task id a
sub-agent reports still running, when it reads that report.

A few of these rules are also held by a mechanism. `.claude/settings.json`
runs a hook, `.claude/scripts/guard-bash.mjs`, before every Bash call of a
session in this project and of its sub-agents (D9). It refuses `git commit`
in this repository where the target directory's branch is `main` or where a
`node_modules` of the target worktree is a symlink; `lsof` fed into `kill`,
`pkill` and `killall`; every merge that does not go through the delivery
queue's `merge` — `gh pr merge` with any options, `gh api` on a pull
request's `merge` path (`repos/<owner>/<repo>/pulls/<n>/merge`) with any
method, read as GitHub routes it, or on an endpoint a substitution gives, a
GraphQL body carrying `mergePullRequest` or `enablePullRequestAutoMerge`, and
`gh pr create` or `gh pr edit` with an auto-merge option — with a token in
front or without, and any command it cannot read to its end that names `gh`
(D16); a `git push` whose refspec targets the main branch — `main`,
`HEAD:main`, `refs/heads/main`, with a leading `+` or without — and any force
push, `-f`, `--force` or `--force-with-lease` (D26); and, inside `developer`,
`tester` and `tester-process`, any `lsof`. The push rule carries most weight
where the repository has no ruleset: GitHub protects a private repository's
branches only on a paid plan, and on a free one the guard is the only
mechanism that keeps main changing through merged PRs alone. `/flow-init`
creates the ruleset where the plan allows it (D24). A
throwaway repository built to test a script is not this repository, whatever
its branch is called. Inside any sub-agent — told by the `agent_id` only a
sub-agent's hook input carries, so a main session started with
`claude --agent` is not one — it also refuses the outside review and Codex,
which are the main session's (D12): `outside-review.sh` and its helper
`outside-review.mjs` run by their path or through `sh`, `bash`, `zsh`,
`dash`, `ksh` or `node` after their options, sourced, fed on standard input,
behind a wrapper or in a substitution, in any letter case; `codex` itself,
any subcommand, any path; and a command it cannot read to its end that names
either. So "no sub-agent runs Codex" is held by the guard for the spellings it
reads; `command -v codex`, `which codex` and reading or quoting the script
pass. A refusal that begins
`guard-bash refused this command` is that hook and not a permission prompt:
the call did not run, nothing waits for an answer, and the line names what to
do instead. The guard grants nothing — a command it lets through still goes to
the permission rules — and it reads only the leading words of each part of a
command, so the rules above stay rules for what it does not catch: `sh -c`,
`eval`, a function, an alias, a variable holding a command, a brace expansion,
a script file, and wrappers such as `env -S`, `stdbuf`, `script`,
`find -exec` and `npx` are not looked into; nor is a push whose target git's
configuration supplies rather than the command line; nor, for the outside
review, are a name built when the command runs (a variable, a brace
expansion, a glob), a renamed copy or a link, `npx codex`, `cat … | sh`, a
here-document fed to a shell, or Codex reached outside Bash. A wrong refusal
is fixed in `guard-bash.mjs` and its tests under `.claude/tests/` through an
ordinary PR; taking the `hooks` key out of `.claude/settings.json` turns every
rule off at once, and is the owner's decision.

## Several tasks at once

Several tasks run side by side, each in a session of its own — a fire of the
delivery cycle, or an attended session, the owner in the chat — and up to
three are developed at once; merge, deployment and smoke still happen one at a
time, under the delivery lock. `node .claude/scripts/delivery-queue.mjs` keeps
what they share on the operator's machine, under the repository's git
directory and never in Git: the tasks and their state, the slots, the lock
and its token, and the decision-id counter (D16). When the owner gives one
session several tasks at once, it still implements them in parallel without
asking again (D11), each registered as a task of its own.

- **Registered.** Every task is in the queue: a fire registers the issue it
  takes, and an attended session registers its task with
  `node .claude/scripts/delivery-queue.mjs start <n> --session <id> --branch <branch> --worktree <path> --base <BASE_SHA> --day`,
  or, for one without an issue, the same with `day-<word>` in place of `<n>`
  and `--areas <a,b>` added — a day task, in the queue's words, its origin
  `day` — so that fires count it toward the slot limit and see what it
  touches. An attended session is never refused. Each command names the
  session by its CLI session id, the directory that holds its scratchpad —
  in a headless run, whose system prompt names none,
  `$CLAUDE_CODE_SESSION_ID` — as `.claude/scheduled/delivery-cycle.md`
  describes. The task's PR is recorded
  with `update <task> --session <id> --pr <n>`.
- **Isolated.** Each task has its own branch and worktree, cut from the
  BASE_SHA its own preflight prints, its own coordinator session and its own
  sub-agents with the existing roles. Every agent that runs a suite binding
  ports or using a database takes ports of its own and a database of its own
  (`CLAUDE.md`, Sub-agent hygiene). Its test suite runs on resources of its
  own: Developer and Tester run `commands.taskTest` with `{task}` filled in,
  which brings them up — a disposable database, say — and runs the suite
  against them, and `commands.taskDown` removes them when the task ends. With
  `commands.taskTest` empty they run `commands.test`, and the project's
  suite must then share no state between two tasks run at once.
- **Slots.** Three by default, `set slots <n>` to change it. A task holds a
  slot while it is being worked on; one waiting for the lock, a dependency or
  an unavailable resource holds none, and the one holding the lock holds none
  either: the lock is a place of its own. A task that comes back to work takes
  its slot back even over the limit, and new starts wait until fewer tasks
  hold a slot than the limit.
- **What a task touches.** Each issue names its areas in `## Touches`, from
  `.claude/delivery-areas.json`; grooming writes it. A fire does not start a
  task that shares a hard area — migrations, the API contract and shared
  types, dependencies, CI and deployment, the delivery process — with one in
  flight, and prefers the one that shares the fewest areas (the procedure's
  pick).
- **Decision ids** are reserved from the queue's counter when a task needs
  one, `reserve <task>` — at the start when the brief knows a lasting decision
  is coming, or when the Developer reports one — not at every start, so
  parallel branches never take the same one; an id left by a stopped task
  stays unused.
- **The version**, with `delivery.versioning` on, is set under the lock,
  relative to main at that moment: `VERSION` and the CHANGELOG heading, the
  next minor or patch after main's as `.claude/scripts/check-version.mjs`
  requires. A branch that bumps the version sets the next one after its
  BASE_SHA's while it is developed, so that its PR checks pass, and is
  renumbered under the lock.
- **Tester and Reviewer** run on each branch before it queues for the lock,
  beside the other tasks; in a critical area the full pair runs once more
  under the lock, on the SHA that is to merge (step 4).
- **The delivery lock.** Merge and deployment happen under the delivery lock,
  one PR at a time: integrate current main into the branch — a merge commit,
  not a rebase — resolve conflicts, set the version, have the integration
  checked and, in a critical area, the full pair run once more, as step 4
  says, merge, follow the deployment, pass the smoke job, check the
  site, tag. The lock is released after the smoke
  and the site check pass, or after a verified recovery; with
  `delivery.deploy` false, once the main workflow's run has passed and the
  tag is pushed. A session waits for
  it with `lock <task> --session <id> --wait 25`, run in the background so that
  waiting spends no tokens and the wait ends inside the call's 30 minutes, and
  is given a token: it checks the token with `check <task> <token>` before
  merging, before tagging and after every wait, and a session whose token is
  stale stops acting, reads the actual state and queues again. A call that
  ends without a token is taken as past the bound only on the refusal past
  its bound (`… stays awaiting the lock`), on a paused queue (a refusal
  beginning `the queue is paused: `), when the tool stops it, or on an exit 1
  or 2 of `lock`, a fault or a usage error: the task is recorded, detached,
  and a later fire resumes it and calls `lock` again. Any other refusal is
  answered as it says: the one for a paused task names
  `update <task> --session <id> --state working --clear-reason`, which puts
  it back to work before it calls `lock` again. The merge is the queue's,
  `merge <task> --token <token> --sha <sha>`, which refuses a stale token and
  runs `gh pr merge` itself. After that integration a review of the whole
  change takes its artifact against the main SHA merged in, not the original
  BASE_SHA, so that it shows the branch's whole change, conflict resolutions
  included, and nothing of the branches merged before it. A PR that needs a
  fix after integration releases the lock,
  `unlock <task> <token> --next "<the step it goes back to>"`, and goes back to
  its task, so the next ready PR may take it.
- **A session that died.** A task's session counts as alive while its
  transcript, its sub-agents' transcripts or the task's last update in the
  queue is younger than 90 minutes; the app's own run status is no sign of
  life. Past that, the next fire adopts a fire's task (`adopt`); a day task,
  the owner's, only once its session has detached it. The adopter reads the
  actual state on GitHub — the PR, the main workflow's run for the merge
  commit and its `deploy` and smoke jobs, the tag — records what it found,
  and goes on from the saved step with the saved round count; a lock the dead
  session held passes to it under a new token, and the old one is refused.
  Nothing already merged, deployed or tagged is done again.
- **The correction-round cap** (Decisions and compatibility) applies to each
  task separately, its rounds counted in the queue: after a task's third round
  only a blocking defect is fixed, and in an unattended run a blocking defect
  still open then ends that task BLOCKED; the other tasks go on.
- **An unavailable resource** — a plan limit (an HTTP 429), Docker or another
  local service the commands need, GitHub, GitHub Actions minutes — pauses
  the task with its state; the other tasks go on, and a later
  fire resumes it, putting it back to work right after its `adopt` with
  `update <task> --session <id> --state working --clear-reason --next "<step>"`,
  so that it takes its slot back, over the limit if need be.
- A Developer or Tester stopped by a session limit (an HTTP 429, for one) is
  resumed with `SendMessage` to the same agent, after the main session has
  inspected its worktree — uncommitted diff, debug lines left in, containers
  still up — and told it what it found. A stop by a session limit is not a
  report, so step 4's 5 minutes, which count from a report, do not apply to
  it: the agent is resumed to finish the work it was given however long the
  limit lasted. A Reviewer stopped by a session limit is started fresh, as
  step 4 says, with the brief there. Once an agent has reported, the next
  correction round follows step 4.

Every push to a PR's branch runs its checks, and every integration of main
runs them again, so more tasks in flight spend more GitHub Actions minutes.
Whether a deployment interrupts the service, and for how long, is the
project's to record in `docs/ARCHITECTURE.md`: the cycle merges and deploys
at any hour (D16).

## Unattended scheduled runs

A scheduled task on the operator's machine runs the delivery cycle, following
`.claude/scheduled/delivery-cycle.md`: it fires on `schedule.cycle` — every
30 minutes, around the clock, by default — and each fire continues a task
whose session died, or takes one ready issue while a slot is free (D16). Two
schedulers can fire it, and both run the same procedure files (D17,
`docs/tooling/scheduled-fires.md`):

- **The desktop app's scheduled tasks**, the default, which `/flow-init`
  creates. A task's prompt first runs
  `node .claude/scripts/fire-check.mjs <cycle|grooming>`, which only reads,
  and stops on a `skip:` line; otherwise it follows the procedure. A fire
  with nothing to do still opens a session and costs its fixed context.
- **launchd jobs behind the same check**, the optional cheaper path on a
  Mac: `.claude/scripts/scheduled-fire.sh <job>` asks the check first and
  opens a headless session only when there is work, so a fire with nothing to
  do writes one line to its log and costs no tokens. The owner installs them
  with `sh .claude/scripts/launchd/install.sh`.

One or the other fires, never both: with both on, every procedure fires
twice. The procedure is there; what belongs here is what it rests on.

`state:ready` on an open issue is the owner's request to implement it, and the
authority for mode `full` above. GitHub does not keep labels of one kind
exclusive: every `gh issue edit` that sets a `state:` or `prio:` label
removes the others of its kind in the same call, and an issue carrying
two `state:` or two `prio:` labels is a fault to report, read as neither
(D22). A fire takes at most one new issue, and none when it continued a task:
the candidate that overlaps the tasks in flight least — none sharing a hard
area with them, then the highest `prio:*`, issues with none last, then the
fewest shared areas, then the smallest issue number. An issue with a
`Depends on #<n>` line whose issue is still open waits, keeping its label. An
issue labelled `area:frontend` without a design reference is not
implemented unattended: the run says on the issue what is missing, removes
the label, and moves on. The
same applies to an issue whose observable acceptance criteria cannot be
derived from it. An issue labelled `delivery:attended` — one whose delivery
needs a person present, or that a delivery run already took (below) — is
left for an attended session, and one whose `Owner steps before delivery`
checklist has an unticked box is passed over until every box is ticked;
neither loses its label (D7, D18).

Issues reach `state:ready` through grooming (`.claude/skills/groom/SKILL.md`),
which rewrites the issue with the owner and never starts a delivery;
`state:ready` and `prio:*` are set only on the owner's explicit word, and so
is `state:deferred`, an issue the owner has put off for later — the scheduled
grooming below sets `state:ready` on its narrow class (D14). Grooming marks
the issue it holds `state:grooming`, so that another grooming chat passes it
over, and passes over deferred issues unless the owner names one. The
delivery cycle ignores both labels (D13), and `state:needs-owner` too.

A fire starts nothing when the main checkout is not on `main`, when GitHub or
the remote cannot be reached, or when a local service the project's commands
need — Docker, when `commands.taskTest` runs on containers — does not answer:
those checks come first, before any task is touched. Other worktrees do not
stop it — the queue knows which belong to its tasks — and a tree the queue
does not know is left exactly as found (D3).

The label comes off when the task leaves the queue — delivered, blocked,
recovered or stopped — not at the end of each fire, so a later fire does not
retry the same failure; a delivered issue is closed, and its epic ticked, as
step 6 says. Everything above in this document applies unchanged, including
the correction and recovery limits: where they say to ask the owner or report
a blocker, an unattended run records that on the issue and stops. D5, D16.

A second scheduled task grooms, following `.claude/scheduled/grooming.md`
(D14), from the same scheduler as the cycle and behind the same check. On
`schedule.grooming` — every 15 minutes by default, around the clock — and
strictly one run at a time — an earlier run is recognised by its
`Grooming run <fire time>: taken` claim on the issue it holds — it takes the
first open issue that carries none of `state:ready`, `state:grooming`,
`state:deferred` and `state:needs-owner` and that the owner has not seen
yet — no grooming result, no `/groom` chat's release and never
`state:grooming` on it — in `/groom`'s order, and none while 10 or more open
issues wait for the owner as `state:needs-owner` (D17). It grooms it against
freshly fetched `origin/main`, with a look from `architect` and a
planning-only look from `tester-look`. The issue gets `## Touches`, as
`/groom` writes it, and `## Delivery notes` — approach, files, documents,
version, attack list, overlap, verification, size and the SHA checked — and
ends `state:ready` only when it is a small `type:bug` or `type:chore`
invisible to users and outside the delivery machinery, otherwise
`state:needs-owner`, with `## Questions for the owner` and, for a visual
change, directions in Figma when `design.figma` is true, which `/groom`
proposes first. It writes nothing to the repository, fires off the delivery
cycle's minutes, with no guard window, since fires of different scheduled
tasks run side by side (D16), and sends the owner one notification each
morning its `schedule.morningFire` fire runs.

### Does delivery need a person present?

An attended session is one with the owner in the chat; a fire of a scheduled
task is an unattended run, with nobody to ask. Which of the two delivers an
issue is settled at grooming by one question: does delivery need a person
present? Only a yes keeps an issue out of the delivery cycle (D18). The owner
has little time: a person is required only for an important change that
cannot be delivered safely without them, never "just in case", for
convenience, or because a change is large or touches the process. When in
doubt, the answer is no.

A person is needed only when the owner watches or checks something during or
right after deployment, such as a new alert or backup that has to be seen
firing once; when a step mid-delivery is one only the owner can run, such as
granting the deploy a permission between the merge and the deploy job; or
when a decision is expected mid-way. An action the owner can take before
delivery is a box of the `## Owner steps before delivery` checklist, not a
reason for the label. Changing the delivery machinery — `.claude/`, the
scheduled procedures, CI, `docs/DELIVERY.md` — is not by itself a reason: such
a change is delivered unattended like any other, with no safeguard beyond its
hard area — `delivery-process`, or `ci-deploy` for CI — which keeps two of
them from running at once. A broken role or procedure shows as a `BLOCKED`
result and a notification, and recovery is a revert; a change to
`.claude/agents/` takes effect in a later session, which is the next fire
(D4).

One more case keeps an issue out of the cycle: a delivery run already took
it — its `Scheduled run <time>: taken` claim or a `DELIVERED`, `BLOCKED` or
`RECOVERED` result stands (a `not taken` skip and a grooming run's claim are
not one) — so the double-take gate never takes it again, and its leftover
branch and PR are finished in an attended session, with the reason
`Attended because: leftover branch from scheduled run <time>`.

Both cases carry the label `delivery:attended`, and grooming — `/groom` and
the scheduled grooming alike — sets it only with a one-line reason in the
issue's description, on a line of its own: `Attended because: <reason>`. No
reason, no label.

## Decisions and compatibility

Stay within the approved task. Resolve ordinary reversible implementation and
small design gaps autonomously, recording relevant choices in the PR. Update
`docs/PRODUCT.md`, `docs/ARCHITECTURE.md` and any contract document the
project keeps when their described behaviour changes. Record only
significant lasting decisions in DECISIONS, with explicit amendments to old
rules when needed. Historical briefs remain history; nothing becomes approved
scope automatically, and an open GitHub issue is a candidate, not scope.

An additive in-scope contract change — a field, an endpoint, an optional
parameter, an error code, a looser limit — updates every side of the
contract, its shared types, tests and documentation in one PR, without a
separate approval. A breaking change to a part the project declares stable —
listed in `docs/ARCHITECTURE.md` under `Stable parts`, with the notice its
users are owed, if any — needs the owner's approval, recorded in the PR: in
an attended session the Coordinator asks the owner; an unattended run ends
BLOCKED with the PR, still draft. The Reviewer checks a change against that
section. Beyond what it promises there is no obligation to maintain unused
external versions.

Consider clients already running — open browser tabs, installed clients,
scripts others run against the service — retained data and recovery:
document a refresh requirement or implement compatibility where actually
needed. Do not silently remove an existing compatibility mechanism: a removal
is stated in the PR, with its effect on running clients and retained data.

Ask only for missing material product intent, an unapproved scope expansion,
new paid services, material security/privacy changes, credentials that are
unavailable, data-destructive recovery, or a technical blocker that cannot be
resolved with existing authority. Using existing authenticated tools and
credential references is permitted; printing, committing or rotating credentials
is not. Infrastructure changes outside the approved task still need authority.

A delivery has at most three correction rounds, and the cap asks no one for
permission (D15). A round is a Developer fix and its re-verification by
Reviewer, Tester or both. A Markdown fix whose verdicts carry forward under
step 4's conditions (D10) is not a round, nor is a wording fix the
Coordinator makes itself under step 4 (D19); any other fix is, a
wording-only fix to one of the files step 4 excludes from the carry-forward
included.
Merging main in to resolve a conflict or a moved base is not a round unless it
needs a fix. Within the cap, fix in-scope defects autonomously. After two
attempts with no new evidence or reduction of the same problem, reassess the
approach with the relevant specialist; this holds inside the cap. After that
reassessment, if the next attempt still makes no progress, report the
concrete blocker.

After the third round only a blocking defect is fixed. Every other finding
from then on — Tester, Reviewer or Codex — becomes a follow-up issue filed
with `/create-task`, the PR lists them, and the PR merges on the internal
verdicts: Tester PASS and Reviewer APPROVED or APPROVED WITH MINORS. In an
attended session, a blocking defect still open after the third round is fixed
in further rounds limited to it, with no second Codex run, and after each such
round the Coordinator tells the owner in the chat what is being fixed and why.
If outside review is enabled and has not run yet, it runs once on the final
candidate, as step 4 says. In an unattended run — a fire of the delivery
cycle, at any hour — the run ends BLOCKED with the PR, still draft, the
defect named.

A defect is blocking when, in a realistic case, data is lost or corrupted,
one client can take the service down, data leaks, or a documented contract
breaks; or when what the first of `CLAUDE.md`'s Development priorities
protects fails in a realistic case. A hostile shape outside the issue's stated
scope is a follow-up, not a blocker.

After the third round, the Coordinator classifies every finding still open in
the latest Tester, Reviewer or Codex verdict as blocking or not, by the
definition above. A finding it rates not blocking becomes a follow-up issue
filed with `/create-task`, and the PR records, per finding, the follow-up
issue and one sentence on why it is not blocking. When every open finding of
a verdict is so filed, that verdict no longer stops the merge: step 5 accepts
it in place of Tester PASS or Reviewer APPROVED or APPROVED WITH MINORS for
that SHA, with the follow-ups listed in the PR, and the checks must still
pass for that SHA. A finding the Coordinator rates blocking is fixed as the
cap says: in an attended session in further rounds for it alone, in an
unattended run BLOCKED. In an attended session, after the third round and
after each round past it, the Coordinator names in the chat each finding it
rated not blocking. Until the cap is reached nothing of this applies: a
CHANGES REQUESTED or FAIL verdict is answered by a fix.

In an attended session, after the second round, the Coordinator tells the
owner in the chat, without being asked, why the delivery continues and what is
left. Report prolonged work after roughly 60 minutes of fixing; elapsed time
alone does not make a progressing, authorised correction require new
permission.
Nonblocking style suggestions do not prevent delivery.

## Version

With `delivery.versioning` true, `VERSION` is the product-version source of
truth. A version field in a package manifest is packaging metadata, and
images, where the project builds any, are tagged by commit SHA.

- Feature or noticeable UX improvement: next minor, reset patch (`1.0.0` → `1.1.0`).
- Fix or runtime/dependency change: next patch (`1.1.0` → `1.1.1`).
- Only docs, tests, agent instructions or delivery tooling: keep the version.
- A new major version (`1.4.2` → `2.0.0`), the first `1.0.0` included, is a
  separate owner decision. Do not reuse or move published tags.

Update VERSION and add a short CHANGELOG entry in the implementation PR.
The PR checks run `node .claude/scripts/check-version.mjs <base>`, which
requires a changed VERSION to be the next patch, minor or major after the
base's, the CHANGELOG's first `## ` heading to name it, and a change to a
runtime file to change it.
Recheck the next number after updating from main; with several tasks in
flight, the number is set under the delivery lock, relative to main at that
moment (Several tasks at once). Branches normally name the
task (`feat/request-search`); version prefixes are optional.

Link the agreed design reference — the Figma nodes with `design.figma`, the
saved image or description otherwise — and preserve changed approved
screens/specifications under `docs/design/v<version>/` when needed for
reproducible implementation. Do not copy the entire design for a patch
without visual changes.

For a changed version, after the main workflow's run for the merge commit
and the deployed verification pass, the Coordinator creates annotated
`v<VERSION>` at the **merge commit**, not the head branch's last commit or
whatever main has become later:
`git tag -a v<VERSION> <merge sha> -m "v<VERSION>"`, then
`git push origin refs/tags/v<VERSION>`. Verify that the tag resolves to that
SHA with `git ls-remote origin 'refs/tags/v<VERSION>^{}'`, which prints the
commit an annotated tag points at; `git ls-remote --tags origin v<VERSION>`
alone prints the tag object's own SHA. Use the existing authenticated git
remote; do not add a token to CI. An existing tag at another SHA is a
conflict, never a reason to overwrite it. If the version did not change,
create no tag. A tag push starts no workflow run: the workflows run on pull
requests and on pushes to main. A GitHub release is optional; CHANGELOG plus
the PR and tag are sufficient.

## Recovery

Before merging, record in the PR the last verified deployment — main's SHA,
the main workflow's run id, and what `delivery.rollback` needs to restore it
— and the recovery choice. The Coordinator uses the existing access
documented in RESOURCES. Read only the relevant deployment metadata; never
print secrets or credential files. For migrations, have the Reviewer check
that the previous version serves on the post-migration schema and data during
the rollout and after a rollback: rolling the application back does **not**
undo a migration.

On failure, pause further merges — the delivery lock stays held, and a
recovery that fails leaves the queue paused,
`node .claude/scripts/delivery-queue.mjs pause --reason <why>`, until the
owner's word unpauses it — and diagnose the actual run of the main workflow:

- Validation/build failed: no deploy occurred; leave the existing deployment
  alone. Fix through the same task's follow-up PR, or revert the merge commit
  through a revert PR under the same lock. With `delivery.deploy` false this
  is the only case.
- Deploy/smoke failed and a reviewed recovery target is compatible: when
  `delivery.rollback` is a command, the Coordinator may run it once, with the
  recorded target. Confirm the failed deployment is still current and no
  newer deployment is running before acting; do not race the workflow's
  concurrency group. Check what the restored service runs and that its
  storage and configuration expectations are unchanged, not just a revision
  number. With `delivery.rollback` empty, recovery is a revert PR through the
  same lock, deployed as any merge is.
- Migration/state/config makes rollback incompatible or compatibility is
  unknown: do not guess, run down-migrations or restore a database automatically.
  Prepare a forward fix if possible; escalate only when safe recovery is blocked.

After rollback, check the restored service as the smoke job does and verify
the failed feature's relevant baseline behaviour. Keep the failed run and
recovery visible. Never tag a failed delivery or call it delivered because
rollback succeeded. Follow with a revert/fix PR so main no longer describes
the broken desired state. Do not reuse a consumed product version; bump the
patch for an application correction.
Use at most one automated recovery attempt; a failed recovery is a blocker.
No data-destructive recovery: no automatic database reset, volume deletion,
infrastructure-wide change or secret rotation.

## Reporting

- `READY`: checked PR, awaiting only an explicitly imposed hold/dependency.
- `DELIVERED`: merged SHA, main workflow's run including smoke passed, changed
  behaviour checked, version tag verified when required.
- `RECOVERED`: delivery failed; verified earlier service restored; follow-up noted.
- `BLOCKED`: concrete missing decision/access or unresolved technical failure.

Include the PR, version (or unchanged), deployed SHA, the main workflow's run,
checks and any known limitation. Never present a local pass as a deployment or
self-review as an independent Reviewer verdict. Missing actual role/tool access
is reported honestly.
