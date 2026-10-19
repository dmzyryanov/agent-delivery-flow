#!/bin/sh
# Outside review: one review of a change by OpenAI's Codex CLI, signed in with
# the owner's ChatGPT account, run by the main session and by nobody else
# (D12, docs/tooling/codex.md). No sub-agent runs it: inside one, the Bash
# guard refuses it, this script's helper and `codex` in the spellings it reads
# (`.claude/scripts/guard-bash.mjs`, D9).
#
# Usage, from the worktree that holds the reviewed head:
#
#   cd <worktree> && sh .claude/scripts/outside-review.sh \
#     <artifact> <issue-description-file> <output-file>
#
# <artifact> is the file `review-artifact.sh` wrote for the reviewed SHA;
# <issue-description-file> holds the issue description verbatim, as the
# reviewer's brief carries it; <output-file> is where Codex's final message
# goes, outside the worktree. A run takes minutes (a flagship `xhigh` review of
# 323 lines took 140 s), longer than the Bash tool's default limit, so the
# caller starts it with `run_in_background: true` and waits for its completion
# notice.
#
# And once the caller has told the owner of a skip line carrying
# `Owner action needed:` — in an attended session in the chat; in an
# unattended run once the result comment carrying that line is posted and
# `PushNotification` is sent — it
# acknowledges the key that line names, from the worktree it ran the review in
# or the main checkout:
#
#   sh .claude/scripts/outside-review.sh --reported <key>
#
# <key> is `install`, `signIn`, `chatgpt` or `credits`, as the line writes it.
# That key alone, when pending, is recorded as reported (see exit 3 below); a
# skip another line made pending stays pending until its own key is
# acknowledged. It touches the record and nothing else: no Codex, no
# worktree, no artifact.
#
# What it does, in order:
#
# - skips, before anything else, when `outsideReview.enabled` in
#   `.claude/flow.json` is not true, or the file cannot be read (exit 3, no
#   owner action): the project has not asked for outside reviews;
# - refuses a path that holds a line break, which every line it prints would
#   carry;
# - refuses an artifact that does not start with `review-artifact.sh`'s header
#   (`# Review artifact`, `# base:`, `# head:`, `# tree-fingerprint:`),
#   whose head is not this worktree's HEAD, or whose fingerprint is not this
#   tree's now, and a tree with uncommitted or untracked changes: Codex reads
#   the tree as the repository at the change's head, so the tree must be that
#   head and nothing else;
# - checks that `codex` is on PATH and `codex login status` says it is signed
#   in with ChatGPT; it never reads, prints or copies `~/.codex/auth.json`;
# - reads the allowance through `codex app-server` (`account/rateLimits/read`)
#   and keeps the owner's quarter: no run while the 5-hour or the weekly
#   `usedPercent` is above 75, unless Codex credits are left to draw on; at
#   100 or above with no credits, the allowance is used up, which needs the
#   owner;
# - runs `codex exec --ephemeral --sandbox read-only -C <worktree> -m <model>
#   -c model_reasoning_effort=xhigh -c shell_environment_policy.inherit=core
#   --json -o <output-file> -` with the prompt on stdin: a fixed brief, the
#   issue description verbatim and the artifact verbatim. The shell commands
#   Codex's model runs get Codex's core environment only, not the session's.
#   The model is `gpt-6-astra`; `gpt-6.1-sol` is tried only when that run was
#   refused for its allowance. Each run is bounded to 20 minutes;
# - reads the allowance again and prints one line.
#
# Each Codex command runs as the leader of a process group of its own, and
# every stop — a run past its bound, a signal to this script, a failure —
# sends SIGTERM to the whole group, then SIGKILL 2 s later to what is left, so
# the commands Codex started end with it.
#
# The pins, the brief, the bounds and the heuristics live in
# `outside-review.mjs` beside this file, which this script runs and nothing
# else does: the allow rule names this script, not the helper.
#
# Exit status and output, the caller's contract:
#
#   0  review written to <output-file>. stdout is one line:
#      outside review: <output-file> (<model> xhigh, <N> s; 5-hour <a>% -> <b>%, week <c>% -> <d>%)
#      with the run's duration and the allowance before and after it; when the
#      second reading fails, the line says so instead of failing:
#      `5-hour <a>% -> ?, week <c>% -> ?: the allowance after the run could not
#      be read`. A stop by a signal once the review is written ends the same
#      way: the review is kept, and the line is that one.
#   2  refused input, a caller error and not a skip: wrong usage, a path with a
#      line break, not inside a git worktree, an artifact without the header,
#      another head or another tree, a tree with uncommitted or untracked
#      changes, a missing or empty issue file, an output path that is the
#      artifact or the issue file, in a missing directory, inside the worktree
#      or a directory. Paths are compared as the filesystem resolves them,
#      through symlinks and letter case. Also refused, naming the error code,
#      is whatever the filesystem would refuse the output file or the events
#      and stderr files beside it: a name too long, a part of the path that is
#      not a directory, a directory that cannot be written, a directory in a
#      file's place, or a file left from an earlier run that cannot be removed
#      (the review is removed last, so it stays then). One line on stderr,
#      `outside review refused: <reason>`; nothing on stdout.
#   3  skip, never a verdict. stdout is exactly one line,
#      `outside review skipped: <reason>.`, and no <output-file> is left. A
#      skip only the owner can clear appends, on that same line,
#      `` Once the owner is told, acknowledge with `sh .claude/scripts/outside-review.sh --reported <key>`. Owner action needed: <one step>``,
#      so the step stays the end of the line — Codex not on PATH, not signed
#      in or not with ChatGPT, the login expired, a window at 100% or more with
#      no credits, or both models refused for their allowance. It is reported
#      once until it is fixed, and reported means the owner was told: the
#      script records the skip's key as pending, and the line says
#      `Owner action needed:` every time until the caller acknowledges that
#      key with `--reported <key>`; from then on the same skip appends
#      ` Owner action already reported <ISO time>: <one step>` instead, without
#      the words `Owner action needed:` or the command, so a caller reports
#      only a line that carries them, and a caller that stopped before telling
#      the owner leaves the skip to be reported again, whatever other key is
#      acknowledged meanwhile. A later run that sees the condition cleared
#      forgets it, pending or reported, and a recurrence is reported again.
#      The record is
#      `${XDG_STATE_HOME:-$HOME/.local/state}/agent-flow/<repo-name>/outside-review-reported.json`,
#      <repo-name> the name half of `project.repo` in `.claude/flow.json`,
#      mode 0600, the reason keys, each `pending` or the time it was
#      acknowledged, changed only under a lock file beside it; deleting it
#      makes every such skip new again. A record that cannot be read or
#      written, a symbolic link in its place among them, which is never
#      followed, counts as nothing recorded and changes nothing else.
#      The other skips carry no such text: outside review disabled in
#      `.claude/flow.json` (`outside review skipped: disabled in
#      .claude/flow.json.`) or that file unreadable, the owner's quarter, the
#      allowance unreadable, a run that failed, timed out or ended without a
#      final message, a run stopped because its events or stderr file could
#      not be written, a stop by a signal before the review was written, and
#      `the script failed: <error>` for anything else the helper throws,
#      never exit 1 and a stack trace. When the output file cannot be removed,
#      the line says so, and that file is no review.
#
# `--reported <key>` prints one line on stdout:
#
#   0  `outside review: recorded as reported: <key>`, the pending key now
#      reported with the time, or `outside review: not pending: <key>` when
#      it is reported already or not recorded, and nothing is written;
#   2  wrong usage — `--reported` without a key, with a word other than the
#      four keys as written above, or with anything more: one line on
#      stderr, `outside review refused: usage: …`, and nothing changed;
#   3  nothing could be recorded, so the skip says `Owner action needed:`
#      again: `outside review: could not record as reported: <key> (<why>);
#      …`, or `outside review: nothing recorded as reported: <why>.` when the
#      record cannot be read, there is no state directory, or
#      `.claude/flow.json` cannot be read or names no `project.repo`.
#      Nothing for the caller to do but name it in its report.
#
# Besides <output-file> a run leaves, per model it ran,
# <output-file>.<model>.events.jsonl (Codex's `--json` events, token counts
# included) and <output-file>.<model>.stderr.txt.

set -u

if ! command -v node >/dev/null 2>&1; then
  echo "outside review skipped: node is not on PATH, and the review runs on it."
  exit 3
fi

exec node "$(dirname "$0")/outside-review.mjs" "$@"
