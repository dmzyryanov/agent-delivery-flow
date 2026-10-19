# Codex CLI: the outside review

OpenAI's Codex CLI gives a change a review by another vendor's model. It is
**off unless the project turns it on**: `outsideReview.enabled` in
`.claude/flow.json` is `false` by default, and while it is, the script skips
at once (`outside review skipped: disabled in .claude/flow.json.`, exit 3, no
owner action) and the pull request records that the step was skipped and why.
Turning it on is the owner's choice: it sends the diff and the issue text to
OpenAI under the owner's ChatGPT account (see Privacy).

When it is on, the main session runs it through one script,
`.claude/scripts/outside-review.sh`, when `docs/DELIVERY.md` step 4 says to;
no sub-agent runs Codex (D12). The Bash guard holds that for the spellings it
reads: inside any sub-agent it refuses the script, its helper and `codex`
itself (D9; `docs/tooling/claude-mcp.md` lists what is out of its reach).
The review runs at most once per task, on the final candidate after Tester
PASS and Reviewer APPROVED, or a verdict `docs/DELIVERY.md` step 5 accepts in
their place after the third correction round, and only for a branch that
touches one of the areas `outsideReview.areas` names — area names of
`.claude/delivery-areas.json`, which
`node .claude/scripts/delivery-queue.mjs areas <branch>` maps the branch's
files onto; never again on the fixes it caused (D15). The rule — when it
runs, how its notes are posted and answered, what a skip does to the
delivery — is in that step and in the outside-review step of
`.claude/scheduled/delivery-cycle.md`. This file is the tool: installing and
signing in, the allowance, what the script pins, and what each of its answers
means.

## Install and sign in

On the operator's Mac, once, by the owner:

1. `brew install --cask codex` in Terminal. `codex --version` answered 0.160.0
   when the script was written.
2. `codex login` in Terminal, then "Sign in with ChatGPT" in the browser, with
   the owner's ChatGPT account (Plus or above). `codex login status` then
   prints `Logged in using ChatGPT`.
3. `"enabled": true` under `outsideReview` in `.claude/flow.json`, and the
   areas it covers under `areas`, through a pull request like any other
   change to the flow.

The login is cached outside the repository, in `~/.codex/auth.json` (or the
operating system's credential store), and Codex refreshes it during use. Nobody
reads, prints or copies that file: the script asks `codex login status`, and
the owner's terminal is where the login is renewed. No API key is used: an
OpenAI API key is a paid service this does not use, so the script takes
`OPENAI_API_KEY` and `CODEX_API_KEY` out of Codex's environment and refuses to
run when Codex is signed in any other way than with ChatGPT.

**When the login expires**, or is signed out, the script skips, and its line
ends with `Owner action needed:` and the step: run `codex login` in Terminal
and choose Sign in with ChatGPT. The owner does exactly that. Once the main
session has told the owner and acknowledged it with `--reported signIn`, the
key that line names, the same skip says `Owner action already reported
<time>:` instead until it is fixed, so the owner is asked once (see Reported
once until it is fixed). To stop outside review altogether, the owner sets
`outsideReview.enabled` back to `false`, or signs Codex out with
`codex logout`, after which every run is a skip, reported once.

## The allowance and the credits

With "Sign in with ChatGPT", Codex runs on the plan's Codex allowance: a
5-hour window and a weekly window, one shared limit called `codex` for every
model. When that is used up, Codex draws on Codex credits, which the owner buys
for this use and records where `docs/RESOURCES.md` says the project keeps its
costs. The owner also uses the subscription, so a quarter of each window stays
the owner's: the script starts no run while the 5-hour or the weekly window is
more than 75% used, unless credits are left to draw on (at 75% exactly it
still runs). A window at 100% or more with no credits to spend is the
allowance used up: a skip only the owner can clear, by buying credits, rather
than the owner's quarter, which clears by itself when the window resets.

Where it is seen:

- by the script, and by anyone repeating it, through `codex app-server`: the
  JSON-RPC request `account/rateLimits/read`, sent after `initialize`, answers
  with `primary` (the 5-hour window) and `secondary` (the week), each with
  `usedPercent` and `resetsAt`, a `credits` snapshot with `hasCredits`,
  `unlimited` and `balance`, a decimal string in the probe, and
  `rateLimitReachedType`, which the script does not read: the probe saw it
  only as `null`, and what else it holds is not documented, so the windows
  decide. The answer also carries the account id; do not paste it anywhere;
- by the owner, in the Codex usage settings in ChatGPT, where credits are also
  bought.

Credits count only when they can be spent: an `unlimited` allowance or a
`balance` that is a decimal string, or a number, above zero, `hasCredits` not
`false`, and `spendControlReached` not `true`. A balance in any other form —
an exponent, a sign, a space — counts as none.

What a review costs, as measured when the script was written: one flagship
review at `xhigh` of a 323-line artifact took 140 s, about 495,000 input
tokens (most of them cached) and 4,000 output tokens, and moved the 5-hour
window from 0% to 15% and the week from 0% to 2%. With the owner's quarter
kept, that is about 5 reviews per 5-hour window. Each run's own cost is in its
success line, which gives both windows before and after it, and its tokens are
in the `turn.completed` events it leaves (see Files).

## What the script pins

- **Models:** `gpt-6-astra` ("Frontier intelligence for the most demanding
  work" in `codex debug models`) at `model_reasoning_effort=xhigh`; the
  fallback `gpt-6.1-sol` ("Latest workhorse model"), also at `xhigh`, tried
  once and only when the first run was refused for its allowance — never after
  any other failure. The pins are constants in
  `.claude/scripts/outside-review.mjs`, the helper the script runs; a change
  of model is a pull request that edits them and the test that names them.
- **The command:**
  `codex exec --ephemeral --sandbox read-only -C <worktree> -m <model> -c model_reasoning_effort=xhigh -c shell_environment_policy.inherit=core --json -o <output-file> -`,
  with the prompt on stdin. The sandbox is read-only, so Codex can read the
  tree but cannot write, commit or push; `--ephemeral` keeps no session on
  disk; `shell_environment_policy.inherit=core` gives the shell commands the
  model runs Codex's core environment only (see Privacy).
- **The prompt:** a fixed brief kept in the helper — failure paths and
  ordering, races included; sender-controlled input; redaction and security;
  deployment and migration risk; numbered findings, each with the file, the
  evidence, the consequence and a grade, blocking or not blocking; `No
  findings.` when there are none; and that the prompt and the read-only tree
  are everything the reviewer has — then the issue description verbatim and the
  artifact verbatim, each between a `BEGIN` and an `END` line carrying a token
  drawn at random for the run, so text inside them cannot pass for either line.
- **Bounds:** 30 s for `codex login status` and for each exchange with
  `codex app-server`; 20 minutes for each model run. A run past its bound is
  stopped and is a skip — the login skip when it named an expired login before
  it (see below). The environment variables `OUTSIDE_REVIEW_READ_LIMIT_MS` and
  `OUTSIDE_REVIEW_RUN_LIMIT_MS` shorten them for the tests only.
- **Process groups:** each Codex command — `codex login status`,
  `codex app-server`, `codex exec` — runs as the leader of a process group of
  its own, and every stop signals the whole group: SIGTERM, then SIGKILL 2 s
  later to whatever is left. So the commands Codex starts in its sandbox end
  with it: past a run's bound, when the script is stopped by SIGTERM, SIGINT
  or SIGHUP — which then ends within about those 2 s — when the script fails,
  and when a run ends but leaves one running.

**How a refusal for the allowance is recognised.** Only from Codex's own error
reports: an `error` event, a `turn.failed` event or an error item in the
`--json` stream, and the lines on its stderr. A report matching, without regard
to case, `usage limit`, `rate limit`, `too many requests`, `429` or `quota` is
a refusal for the allowance, which lets the fallback run. The model's messages
and the output of the commands it ran are never read for it, because they quote
the diff under review. A report naming a `401`, `unauthorized`, `not logged
in`, a refresh token, or a token or login that has expired is a login that no
longer works. Login evidence wins over allowance evidence, a generic failure
and a timeout, in the run as in the allowance read: a report that names both,
such as `failed to fetch rate limits: 401 Unauthorized`; a run that reports
one of each; a run that names such a login and then fails in any other way or
hangs until its bound; and an allowance read that failed in any way — an error
answer, no answer, no answer in time — while its stderr named such a login,
before or after: each is a login that no longer works, so the skip asks the
owner to sign in again and never runs the fallback or asks for credits. Only
two outcomes of a run come before it: an events or stderr file that could not
be written, whose cause is local, and a run that ended on its own with exit 0
and a final message, which is a review. An allowance read that answered with
the windows stands whatever its stderr said, because the login worked for it.
This is a heuristic over Codex's wording, which may change: a refusal worded
otherwise becomes an ordinary failed run, which is a skip without a fallback.

## Running it

From the worktree that holds the reviewed head, with Bash
`run_in_background: true`, and wait for the completion notice — a run takes
minutes, longer than the Bash tool's default limit:

```sh
cd <worktree> && sh .claude/scripts/outside-review.sh <artifact> <issue-file> <output-file>
```

- `<artifact>`: the file `sh .claude/scripts/review-artifact.sh` wrote for the
  SHA being reviewed, header included.
- `<issue-file>`: the issue description verbatim, as the reviewer's brief
  carries it — a design link or acceptance criterion added in a comment
  follows it, nothing else from the comments does.
- `<output-file>`: where Codex's final message goes, outside the worktree,
  under the session's scratchpad for one.

After telling the owner of a skip whose line carries `Owner action needed:`
— in an attended session in the chat; in an unattended run of the delivery
cycle once the result comment carrying the line is posted and
`PushNotification` is sent — acknowledge the key that line names, from the
worktree the review ran in or the main checkout; the line gives the command
whole:

```sh
sh .claude/scripts/outside-review.sh --reported <key>
```

`<key>` is `install`, `signIn`, `chatgpt` or `credits`. It records that key
alone as reported, when it is pending, and touches nothing else: no Codex, no
worktree, no artifact. A skip another line made pending, whose line no caller
reported, stays pending (see Reported once until it is fixed).

`.claude/settings.json` allows `Bash(sh .claude/scripts/outside-review.sh *)`,
which covers `--reported <key>` too, and nothing else of this: `codex` itself
is not allow-listed, and the helper is not run directly.

## Exit statuses and lines

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Review written to `<output-file>` | one line on stdout: `outside review: <output-file> (<model> xhigh, <N> s; 5-hour <a>% -> <b>%, week <c>% -> <d>%)` |
| 2 | Refused input: a caller error, not a skip | one line on stderr, `outside review refused: <reason>`; nothing on stdout |
| 3 | Skip, never a verdict | exactly one line on stdout, `outside review skipped: <reason>.`, ending, when only the owner can clear it and the caller has not yet acknowledged it, with `` Once the owner is told, acknowledge with `sh .claude/scripts/outside-review.sh --reported <key>`. Owner action needed: <step>`` — the step stays the end of the line — or with ` Owner action already reported <time>: <step>` once it has; no `<output-file>` left |

`--reported <key>` answers with one line too:

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Recorded, or nothing to record | on stdout, `outside review: recorded as reported: <key>` — the pending key, now reported with the time — or `outside review: not pending: <key>` when it is reported already or not recorded, and nothing is written |
| 2 | Wrong usage: `--reported` without a key, with a word other than the four keys as the line writes them, or with anything more | one line on stderr, `outside review refused: usage: …`; nothing changed |
| 3 | Nothing could be recorded | on stdout, `outside review: could not record as reported: <key> (<why>); …` when the record cannot be written — another run holding it past 2 s among the reasons — or `outside review: nothing recorded as reported: <why>.` when it cannot be read, there is no state directory, or `.claude/flow.json` names no repository to name the record after. The skip then says `Owner action needed:` again, which errs on reporting; name it in the report |

When the first model was refused and the fallback wrote the review, the success
line reads `(gpt-6.1-sol xhigh, after gpt-6-astra was refused for its
allowance, <N> s; …)`. When the allowance cannot be read again after the run,
the line gives `?` for the after values and says so —
`5-hour <a>% -> ?, week <c>% -> ?: the allowance after the run could not be
read` — and the review stands. A stop by a signal once the review is written,
while the allowance is read again, ends the same way: exit 0, the review kept,
and that line.

Refusals (exit 2): wrong usage; a path given, the working directory or the
worktree whose path holds a line break, a newline or a carriage return, which
the one-line output cannot carry; not inside a git worktree; an artifact that
is missing or does not start with `review-artifact.sh`'s header
(`# Review artifact`, `# base:`, `# head:`, `# tree-fingerprint:`); an
artifact whose head is not the worktree's HEAD; a worktree whose fingerprint
is no longer the artifact's — Codex reads the tree, so it must be the tree
reviewed; a worktree with uncommitted or untracked changes, even when the
artifact was built from it — the brief tells Codex it reads the repository at
the change's head, so commit or clean them and build the artifact again (what
git ignores, such as `node_modules/`, does not count); a missing or empty
issue file; an output path that would overwrite the artifact or the issue
file, whose directory does not exist, that lies inside the worktree, or that
is a directory. The output path is compared with the inputs and the worktree
as the filesystem resolves it, through symlinks and, on a filesystem that
ignores letter case such as macOS's, in any case. Whatever the filesystem
would refuse the output file or the events and stderr files beside it is
refused too, with its error code: a name too long (`ENAMETOOLONG` — the files
beside the review add up to 25 bytes to its name, so a review name of 255
bytes is refused for its events file), a part of the path that is not a
directory (`ENOTDIR`), a directory that cannot be written (`EACCES`), a
directory where one of the files goes (`EISDIR`), a symbolic link loop
(`ELOOP`), or a file left from an earlier run that cannot be removed (`EPERM`,
for one). These are checked before Codex is asked anything; the files an
earlier run left are then removed, the review last, so an earlier review stays
when a file beside it cannot be removed. Fix the call and run it again.

Skips (exit 3) that need the owner — the caller reports the step when the
line says `Owner action needed:`, and only then, and acknowledges the key the
line names with `--reported <key>` once it has (see Reported once until it is
fixed):

| Reason begins | Owner action needed | Recorded as |
| --- | --- | --- |
| `Codex CLI is not on PATH` / `could not be started` | `brew install --cask codex`, then `codex login` | `install` |
| `Codex is not signed in` | `codex login`, Sign in with ChatGPT | `signIn` |
| `Codex is signed in, but not with ChatGPT` | `codex logout`, then `codex login` with ChatGPT | `chatgpt` |
| `the Codex login has expired` (reading the allowance, or in the run) | `codex login`, Sign in with ChatGPT | `signIn` |
| `the Codex allowance is used up` (a window at 100% or more, no credits) | buy Codex credits in the Codex usage settings in ChatGPT | `credits` |
| `both gpt-6-astra and gpt-6.1-sol were refused for their allowance` | buy Codex credits in the Codex usage settings in ChatGPT | `credits` |

Skips that do not, named in the pull request and the run's report only:

- `disabled in .claude/flow.json` — the project has not turned outside review
  on, or the file cannot be read; the step is skipped with that reason.
- `the owner's quarter: …` — a window is above 75% and no credits can be
  spent. It clears by itself when the window resets, at `resetsAt`.
- `the Codex allowance could not be read: …` — `codex app-server` answered
  with an error, ended without answering, did not answer within 30 s, or
  answered without both windows. If it repeats, check `codex login status` and
  the request above by hand, in an attended session.
- `` `codex login status` did not answer within 30 s ``.
- `the <model> run failed with exit <n>`, `was ended by <signal>`, `did not
  finish within 20 minutes and was stopped`, or `ended without a final
  message` — each naming the events file to read. After a refusal of the first
  model it begins `gpt-6-astra was refused for its allowance, and …`.
- `the <model> run could not have its events file written (<code>, …) and was
  stopped`, or its stderr file — the filesystem refused the file after the
  checks, a full disk for one; the run is stopped at once.
- `stopped by <signal> before the review finished` — the script itself was
  stopped, by `TaskStop` for one; it stops the Codex process it started first.
  Once the review is written, a stop keeps it and is no skip (see above).
- `the script failed: <error>` — anything else the helper threw, as one line
  with its error code; it stops what it started first. No outcome of the
  helper is exit 1 and a stack trace.
- `node is not on PATH` — the helper could not run at all.

When a skip cannot remove the output file — something other than a file, such
as a directory, stands in its place — the line adds `; the output file could
not be removed (<code>), so it is no review` before its full stop.

## Reported once until it is fixed

The owner's rule for a skip only the owner can clear (D12) is that it is
reported once until it is fixed, and reported means the owner was told. The
script keeps the record, because a caller — an attended session, or one of
the delivery cycle's runs among several — cannot know what another one
reported; and only the caller knows when the owner has been told, so it says
so:

- **Pending:** an owner-action skip's line ends
  `` Once the owner is told, acknowledge with `sh .claude/scripts/outside-review.sh --reported <key>`. Owner action needed: <step>``,
  and the script records its key (`install`, `signIn`, `chatgpt` or
  `credits`, the table above) as `pending`. The line says that every time,
  until the caller acknowledges that key. The caller reports only a line that
  carries those words — in an attended session in the chat, in an unattended
  run in the result comment and one `PushNotification` — and records any
  other in the pull request as a skip, like any skip.
- **Acknowledged:** once it has told the owner — in an attended session in
  the chat; in an unattended run once the result comment carrying the line is
  posted and `PushNotification` is sent — the caller runs the command the line
  gave, `sh .claude/scripts/outside-review.sh --reported <key>` with the key
  that line names, from the worktree the review ran in or the main checkout,
  which records that key alone as reported, with the time. From then on the
  same skip's line ends ` Owner action already reported <time>: <step>`
  instead, without the words `Owner action needed:` or the command. Another
  key left pending — by a caller that stopped before telling the owner —
  stays pending, whatever other key is acknowledged, so the owner is still
  told of that skip at its next occurrence: a caller that stops, or fails to
  post, before it acknowledges leaves its key pending, and the next run
  reports the skip again. A missed acknowledgement errs on telling the owner
  twice, never on not telling them.
- **Cleared:** a later run that sees the condition gone forgets the key,
  pending or reported, and a recurrence is reported again: `install` once
  `codex` is found; `signIn` and `chatgpt` once `codex login status` says
  ChatGPT and the allowance read is no login failure; `credits` once the
  allowance read shows both windows below 100% or credits to spend. A run that
  ends in the same skip keeps its key, whatever it saw before: an allowance
  read below 100% followed by both models refused is still the credits skip,
  pending or already reported.
- **Where:** `${XDG_STATE_HOME:-$HOME/.local/state}/agent-flow/<repo-name>/outside-review-reported.json`,
  `<repo-name>` the name half of `project.repo` in `.claude/flow.json`, so
  `~/.local/state/agent-flow/<repo-name>/outside-review-reported.json` on the
  operator's Mac, outside the repository; an `XDG_STATE_HOME` that is not an
  absolute path is passed over. Mode 0600, in a directory of mode 0700, written
  whole to a temporary file and renamed into place. It holds one JSON object of
  reason keys, each `pending` or the time it was acknowledged, nothing else and
  never a credential. A record that holds keys with times only reads as all
  reported. The record is named after the repository whether or not the
  review is enabled now, so a skip recorded before it was turned off can still
  be acknowledged.
- **Lock:** every change — by a run or by `--reported` — is made holding
  `outside-review-reported.json.lock` beside it, created exclusively and
  removed afterwards, so that two at the same moment cannot undo each other's
  change, a cleared key brought back as reported among them. A run with
  nothing to change takes no lock. A lock another process holds is waited for
  up to 2 s; past that the record counts as one that cannot be written. A lock
  older than 10 s was left by a process that died holding it and is taken
  over; a directory in its place never is (see Known limits).
- **Faults:** a record that is missing, cannot be read, is not a regular file,
  is a symbolic link — opened with `O_NOFOLLOW`, never followed, and replaced
  by the next write — is over 64 KiB, is not that JSON object, or holds a
  value that is neither `pending` nor a time counts as nothing recorded, entry
  by entry; one that cannot be written is left as it was. Either way the skip
  says `Owner action needed:` again rather than being lost, and the exit
  status and the one line are as they would be. `--reported` facing such a
  record says on its one line, exit 3, that it recorded nothing.
- **Reset:** delete the file,
  `rm ~/.local/state/agent-flow/<repo-name>/outside-review-reported.json`;
  every owner-action skip is then new again and reported at its next
  occurrence.

## Files

Besides `<output-file>`, each model run leaves
`<output-file>.<model>.events.jsonl` — Codex's `--json` event stream, with the
token counts in its `turn.completed` events — and
`<output-file>.<model>.stderr.txt`. A skip removes `<output-file>` and keeps
these, for reading why. A run starts by removing all of them, so nothing from an
earlier run passes for this one; the review is removed last, and a file that
cannot be removed is a refusal (see Exit statuses and lines). The events and
stderr files are then created, never opened as found: whatever stands in
their place by the time a model runs — a directory, a FIFO, a symbolic link,
which is not followed — stops that run at once, as the skip that its file
could not be written (`EEXIST`). The final message is read only when it is a
regular file, so a FIFO in its place is no message rather than a wait.

The record of owner-action skips, and its lock file while it is changed, are
the only files written elsewhere (see Reported once until it is fixed).

## Known limits

- A SIGKILL to the script leaves a `codex exec` it started running, with its
  process group: only SIGTERM, SIGINT and SIGHUP are handled, so stop it with
  `TaskStop`, which the caller does anyway.
- A process Codex starts in a process group or session of its own leaves
  Codex's group, and the group's signals do not reach it.
- The events file, `<output-file>.<model>.events.jsonl`, grows with everything
  the run streams and is bounded only by the run's time limit, 20 minutes.
- A line of Codex's stderr or of its `--json` event stream longer than 1 MiB
  is dropped whole by the script's line reader, so evidence inside it — a
  refusal for the allowance, an expired login — is not seen, and the run is
  judged by what else it reported; the events and stderr files still hold the
  line. An answer from `codex app-server` longer than that is no answer.
- The script stops `codex app-server` on its answer, so an expired login it
  names on its stderr after that answer is seen only if the server writes the
  line before it ends: the probed server ignored SIGTERM, which leaves the
  line the 2 s before SIGKILL, but one that exited on SIGTERM first would lose
  it, and the read would be judged by the answer alone.
- Two deliveries run at once (D16) may each read the allowance below the
  owner's quarter and each run a review, so their sum can pass the quarter:
  the allowance is read before a run, and nothing holds it between that
  reading and the run's end.
- The lock's stale takeover is not atomic: runs racing on one lock older than
  10 s may both take it and hold it at once, and a holder stalled for more
  than 10 s can be overtaken, so one change can undo another. This needs two
  changes to the record at the same moment on one machine, which two
  deliveries at once (D16) can bring about.
- A lock path that is a directory, a symbolic link or a FIFO is never taken
  over and blocks every change to the record until it is removed; a lock file
  whose modification time lies in the future blocks them until it is removed
  or that time is 10 s past. Each blocked change is reported as
  `the record is in use by another run`, and each such run errs towards
  `Owner action needed:`.
- `--reported <key>` stopped by a signal leaves its lock, taken over after 10 s,
  and a temporary file `.outside-review-reported.json.<pid>.<hex>.tmp` beside
  the record, which nothing removes; delete it by hand.

## Privacy

The artifact holds the diff of the repository and the prompt holds the issue
text; both go to OpenAI under the owner's ChatGPT account, when
`docs/DELIVERY.md` step 4 says to run it, in an attended session and in an
unattended run alike. The owner agrees to that by turning
`outsideReview.enabled` on (D12). Credentials are never in Git, so none is in
the artifact, and the review runs in a worktree, which holds no `.env`.
Codex's read-only sandbox still lets it read files outside the worktree; the
brief tells it to read only inside the tree and never to quote a credential.
Read its notes before posting them, as any text bound for the pull request.

The shell commands the model runs get a minimal environment:
`-c shell_environment_policy.inherit=core` hands them Codex's core set only —
in a probe, `CODEX_*`, `HOME`, `LANG` and the `LC_*` locale, `LOGNAME`,
`PATH`, `PWD`, `SHELL`, `TERM`, `TMPDIR`, `USER` and a few pager and colour
settings. Without it the commands saw the whole Claude Code session
environment, dozens of `CLAUDE_CODE_*` names among it, one of them a token,
which Codex's default exclusions did not cover. The Codex CLI process itself
keeps the session environment it needs to reach the network, less
`OPENAI_API_KEY` and `CODEX_API_KEY`, which the script removes.

## Tests

The tests under `.claude/tests/` run the script against a stand-in `codex`
first on PATH — CI has no Codex, and a real run spends the owner's allowance —
with a temporary HOME whose `auth.json` holds only a sentinel that must never
appear in anything the script prints or writes, and under which the record of
owner-action skips is kept and acknowledged, with `FLOW_CONFIG` pointing at a
fixture `.claude/flow.json` that turns the review on or off. The stand-in's
`exec` can start a command of its own that ignores SIGTERM and holds the run's
pipes, which every stop must end. Each stand-in process and command leaves its
PID, and the fixture stops whatever of them, and of the scripts a test
started, is still running when the test ends, whatever its assertions did.
