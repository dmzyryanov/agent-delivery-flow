# Scheduled fires

The delivery cycle (`.claude/scheduled/delivery-cycle.md`, by default every 30
minutes) and the scheduled grooming (`.claude/scheduled/grooming.md`, by
default every 15 minutes) are fired by one of two schedulers on the operator's
Mac, never both:

- **The desktop app's scheduled tasks**, the default, which `/flow-init`
  creates.
- **Two launchd jobs** behind a check that spends no tokens, the optional,
  cheaper path (D17).

Both run the same procedure files and the same check first,
`.claude/scripts/fire-check.mjs <cycle|grooming>`, which only reads and
answers `work: <reason>` or `skip: <reason>`. The procedures are the same in
what they do whichever scheduler fires them: a session reads its procedure and
makes every check and gate there itself. The check only decides whether
reading it is worth it. The crons are `schedule.cycle` and
`schedule.grooming` in `.claude/flow.json`, kept off each other's minutes
(`*/30 * * * *` and `7,22,37,52 * * * *` by default), so that a grooming
fetch rarely meets the cycle's in the one main checkout.

## The desktop app's scheduled tasks

`/flow-init` creates two tasks with `create_scheduled_task`, ids
`<repo-name>-delivery-cycle` and `<repo-name>-grooming`, `<repo-name>` the name
half of `project.repo`, on the two crons, with this prompt (the grooming's
names `grooming` and `grooming.md`):

```text
Work in <checkout>. First run `node .claude/scripts/fire-check.mjs cycle` there.
If it prints a line beginning `skip:`, stop and report that line only.
Otherwise read <checkout>/.claude/scheduled/delivery-cycle.md and follow it exactly.
If that file cannot be read, do nothing else and report that in one line.
```

The owner then sets, in the app's Scheduled list, each task's folder to the
main checkout with worktree isolation off — the one step the tool cannot do.
Neither is a free choice: a task run anywhere else loads neither the project's
settings nor its Bash guard, the preflight expects the main checkout on the
main branch, and the run creates its own worktrees outside the repository
(D3); an app-managed worktree would put the session where neither holds.
The permission mode comes from the user-level `~/.claude/settings.json`
(`docs/tooling/claude-mcp.md`, The starting mode): a scheduled session with no
`defaultMode` anywhere starts in Manual and stalls. `docs/RESOURCES.md`
records the settings, so the tasks can be rebuilt.

What the app does, as measured (D5, D16):

- A fire starts a few minutes after its scheduled time, by a fixed offset per
  task.
- A fire of a task is dropped, not queued, while a run of the same task is
  inside an active turn. A run that has ended its turn to wait for background
  work — a delivery waiting on its sub-agents — holds no fire back, and fires
  of different tasks run side by side. One task every 30 minutes is therefore
  enough for several tasks in flight.
- The app's run status and `isRunning` are no sign of life: a run waiting
  between turns reads `succeeded` while it is alive. The delivery queue reads
  liveness from the transcripts instead (see Liveness).
- A fire whose time the Mac slept through is lost; on the next start or wake
  the app opens one catch-up run for the most recently missed time within the
  last seven days. A catch-up is an ordinary fire.
- The tasks run while the app is open and the Mac awake.

The session's system prompt names its scratchpad, and its id is that
directory's name. A fire with nothing to do still opens a session — its fixed
context is paid before the check runs — but it stops at the check's `skip:`
line without reading `CLAUDE.md`, `docs/DELIVERY.md` or the procedure. Where
fires with nothing to do are frequent, the launchd jobs remove that cost.

## The launchd jobs

`.claude/scripts/scheduled-fire.sh <cycle|grooming>` is each job's program,
and the jobs are `dev.agent-flow.<repo-name>.cycle` and
`dev.agent-flow.<repo-name>.grooming`. A fire with nothing to do costs the
check and one log line; a session starts only with work.

1. **The lock.** Each job has one,
   `~/Library/Logs/agent-flow/<repo-name>/<job>.lock`, a directory holding the
   PID of the process it belongs to. A fire that finds it held by a live run
   of the script — a process whose command line, `ps -ww -o command=`, names
   `scheduled-fire.sh` — logs `skip previous <job> run still in its turn
   (pid N)` and ends. A lock whose process is gone, or whose PID the system has
   since given to another program, is stale: the fire takes it over, leaving
   that program alone, and its log line says so.
2. **The check.** `node .claude/scripts/fire-check.mjs <job>` prints
   `work: <reason>` or `skip: <reason>` and exits 0 or 1. A skip is exit 1
   with a `skip: ` line: the fire logs it and ends. Any other answer is work:
   exit 0, or `run cannot tell: fire-check exit <n>[: <its line>]` — exit 1
   with no `skip: ` line among them, as from a node that fails before the
   check runs, its stack trace on stderr and nothing on stdout. A fault costs
   a session, never every fire.
3. **The session.** On work it starts the newest Claude Code the desktop app
   bundles, `~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude`,
   versions compared by number (`~/.local/bin/claude` when the app bundles
   none), as

   ```text
   claude -p "Read <checkout>/.claude/scheduled/<procedure>.md and follow it exactly." --model claude-opus-5-5 --effort <xhigh|medium> --permission-mode auto --output-format stream-json --verbose < /dev/null
   ```

   under `caffeinate -i -s`, in the main checkout, in a clean environment:
   `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`, `LANG`, and
   `SSH_AUTH_SOCK` when launchd has one, and nothing else. The desktop app's
   own variables, inherited, broke the session's sign-in in the measurement.
   `PATH` is set by the script: the newest node under `~/.nvm`, Homebrew,
   `/usr/local/bin`, Docker's, the system's — launchd's own lacks node. The
   effort is `xhigh` for the cycle and `medium` for the grooming.
4. **The lock goes.** The cycle's lock goes as soon as the run's stream shows
   its first `result` line: a run that has ended its turn and waits on its
   background sub-agents must not stop the next fire (D16), and the `-p`
   process lives on until they finish. The grooming's lock is held until the
   process ends: strictly one run at a time (D14). A supervisor process,
   left behind by the job (its plist sets `AbandonProcessGroup`), watches the
   session, so the launchd job itself ends within seconds: launchd starts no
   second instance of a job while its program runs, and would pass fires over
   with no line in the log.
5. **The end.** When the session's process ends, the supervisor logs
   `end exit=<n>`. When the grooming's morning run ends — the check's reason
   is `morning notification` — it also shows the run's final result text as a
   macOS notification with `osascript`, titled with `project.name`, the text
   an argument after `--`, so one that opens with `-` is shown as it is.
   Whether the procedure's own `PushNotification` reaches the owner from a
   headless run is not measured; the procedure keeps sending it, and this is
   the fallback.

When `.claude/flow.json` cannot be read — no node, no file, no `owner/name` —
a fire logs its skip, naming why, to `~/Library/Logs/agent-flow/fires.log`
and starts nothing: a session could not follow the procedure without the
configuration either.

### Install

The owner, once, in Terminal, from the main checkout on the main branch:

1. `claude auth login` — the standalone CLI's own sign-in, with the owner's
   Claude account. The desktop app's sign-in does not carry over to a session
   launchd starts.
2. `sh .claude/scripts/launchd/install.sh`. It checks that the CLI is signed
   in (`scheduled-fire.sh --auth-status`, which prints `signed in` or
   `not signed in` and never a token), reads `project.repo`,
   `schedule.cycle` and `schedule.grooming` from `.claude/flow.json`, renders
   `cycle.plist.in` and `grooming.plist.in` into `~/Library/LaunchAgents/`
   with the label, this checkout's path, the logs directory and the minutes
   filled in, checks each with `plutil -lint`, and loads them with
   `launchctl bootout` and `launchctl bootstrap gui/<uid>`. A cron is taken in
   the two shapes the defaults have, `*/N * * * *` and `M1,M2,… * * * *`; any
   other is refused and nothing is installed. Run again, it replaces both.
3. Disable the desktop app's tasks `<repo-name>-delivery-cycle` and
   `<repo-name>-grooming`: switched on beside the jobs, they would fire the
   procedures twice.

The jobs fire at the crons' minutes, local time, and not at load.

### Read the log

`~/Library/Logs/agent-flow/<repo-name>/fires.log`, one line per fire and one
more when a session ends, in UTC:

```text
2026-10-17T20:30:01Z cycle skip nothing to resume or take (pick: nothing to take)
2026-10-17T20:37:02Z grooming skip 12 open issues wait for the owner (state:needs-owner), 10 or more
2026-10-17T21:00:01Z cycle run #12 is ready to take
2026-10-17T21:00:03Z cycle skip previous cycle run still in its turn (pid 4242)
2026-10-17T22:41:17Z cycle end exit=0
```

`tail -f ~/Library/Logs/agent-flow/<repo-name>/fires.log` follows it. Past
1 MiB it is moved to `fires.log.1`, one generation kept. Each run's stream is
`~/Library/Logs/agent-flow/<repo-name>/runs/<job>-<UTC time>.jsonl`, named by
its `run` line's time, the newest 50 of each job kept, with the session's
stderr beside it in `.err` when there was any; its first line names the
`session_id`. What launchd itself and the supervisor print goes to
`~/Library/Logs/agent-flow/<repo-name>/launchd-<job>.log`.
`launchctl print gui/$(id -u)/dev.agent-flow.<repo-name>.cycle` shows a job's
state and last exit.

### Stop the jobs

`sh .claude/scripts/launchd/uninstall.sh` boots both jobs out and removes
their plists; the logs stay. A session already started is a process of its
own and goes on: while it holds its job's lock, the lock's `pid` file names
its supervisor. One job alone is stopped with
`launchctl bootout gui/$(id -u)/dev.agent-flow.<repo-name>.<job>`, and started
again by running the installer.

### Headless runs and the app

A session a job starts is headless. It does not appear in the desktop app's
sidebar or its Scheduled section; the stream under `runs/` is the same run as
the app would have shown it. Its system prompt names no scratchpad: the
procedures take the session id from `$CLAUDE_CODE_SESSION_ID` and the
scratchpad from the path a desktop session would be given,
`/private/tmp/claude-<uid>/<project dir>/<session id>/scratchpad`, with
`<project dir>` as below, made by the run's first Write there.

## What the check calls work

The check only reads: it never claims, comments, labels or writes the queue.
It runs `node .claude/scripts/delivery-queue.mjs`, `gh`, `git` and, where the
project needs it, `docker` from `PATH`, each with 30 s to answer and 240 s for
the whole check, against `project.repo`.

- **Cycle.** A task Resume first would take: a queue row `DEAD` or `detached`
  (`delivery-queue.mjs status --json`) — not a day task its session has not
  detached, and not a task awaiting the lock while the lock is held or the
  queue is paused. Otherwise a ready issue `pick --json` offers that the
  owner-steps gate and the double-take gate would not pass over at once: no
  unticked box under `## Owner steps before delivery`, and no comment from an
  earlier scheduled run, `Scheduled run <time>: taken` or `DELIVERED`,
  `BLOCKED` or `RECOVERED`. Up to ten candidates are read in `pick`'s order.
  With work, the preconditions: `gh api repos/<project.repo>`,
  `git ls-remote origin HEAD` and, where the project needs it, `docker info`.
  One that fails makes the fire a skip, `precondition <github|remote|docker>
  failed with work present (<the work>)`: the session's own checks would end
  it at once.
- **Grooming.** The fire whose clock reads from `schedule.morningFire` to 14
  minutes after it (09:07–09:21 by default) always has work: it owes the
  morning notification. Otherwise, as the procedure's stop conditions read: an
  earlier run's `Grooming run <time>: taken` claim under two hours old is a
  skip, one two hours old or more is work; with 10 or more open
  `state:needs-owner` issues there is nothing to do, the line giving their
  exact count; else work is an open issue with no `state:` label that the
  owner has not seen — no `ready without the owner` or `waits for the owner`
  result, no `released to a /groom chat`, and no label event that ever added
  `state:grooming`. Up to twenty candidates are read, newest first.
- **Cannot tell.** A command that fails, runs past its time or answers what
  the check does not understand is work, with the reason
  `cannot tell: <what>`: a fault costs a session, never a fire that had
  work. A failed precondition is the one exception, as above. A check that
  never reaches its answer is work too, at the launchd wrapper (step 2); a
  desktop task's session, which reads the line itself, goes on to the
  procedure for any answer that is not a `skip:` line.

## Liveness

A run that ends its turn and waits on its sub-agents, or on a background
command, shows no sign of life in either scheduler. The delivery queue
therefore counts a session alive while the newest of its transcript, its
sub-agents' transcripts and its task's last update in the queue is within the
threshold (90 minutes by default, D16). The transcripts are where every
session's are, desktop or headless:
`~/.claude/projects/<project dir>/<session id>.jsonl`, with its sub-agents'
under `<session id>/subagents/agent-*.jsonl`, where `<project dir>` is the
main checkout's absolute path with every character other than a letter or a
digit turned into `-` — `-Users-me-Projects-app` for
`/Users/me/Projects/app`.

What that needs of the machine:

- **The Mac awake.** A fire whose time the Mac slept through is lost (the app
  makes up one; launchd runs one on waking); a Mac switched off runs none.
  `caffeinate -i -s` keeps it awake only while a launchd session runs and only
  on mains power; a closed lid sleeps. A Mac asleep past the threshold makes
  every session look dead, so the next fire adopts its task; a session that
  wakes after that is refused at its next queue command.
- **Docker running, if the project needs it** — for its test databases, its
  build or its local stack. The cycle's checks, and the launchd check's
  precondition, end a fire with work while it does not answer.
- **The app open**, for the desktop tasks; the standalone CLI signed in, for
  the launchd jobs.

## Known limits

- **A paused task whose reason still holds.** The check cannot tell whether a
  paused task's reason still holds — whether a plan limit has reset — so it
  counts the task as resume work, and each cycle fire starts a session while
  one stands in the queue. The task no longer stalls once the reason clears:
  the fire that resumes it puts it back to work with
  `update --state working --clear-reason`, and it takes its slot and, in its
  turn, the lock.
- **A grooming run that never ends** holds its launchd lock, and every
  grooming fire after it is a skip naming its supervisor's PID, until that
  process ends or is stopped by hand. Under the app, the same run makes the
  app drop the grooming task's fires while it is inside its turn.
- **The scratchpad of a headless run** is made by its first Write there; a
  run that cannot write to `/private/tmp/claude-<uid>/` cannot export
  `origin/main`, and the grooming ends under its stop condition (a).
- **A double-take issue keeps its label.** The check passes over an issue
  with an earlier run's claim or result without a session, so the skip
  comment that removes `state:ready` is written only when a fire started
  for other work reaches it, or by the owner.
- **Two schedulers at once** fire every procedure twice; the installer's last
  step and `/flow-init` keep one.

## Tests

The tests under `.claude/tests/` run the check against stand-ins for `gh`,
`git`, `docker` and the queue first on `PATH`, answering from a file — the
commands that fail, hang or answer garbage among them — and its readers of
issue text on made-up text at growing sizes; the wrapper with stand-ins for
`claude`, `caffeinate`, `osascript` and the check under a temporary `HOME`:
one skip line and no session, the clean environment and the exact command
line, the cycle's lock gone at the first result while the session lives on,
the grooming's held until it ends, the morning notification and a text
opening with a dash, a stale lock taken over — its process gone, or its PID
another program's — the log's rotation and the 50 streams, and a check that
exits 1 with no `skip: ` line starting the session; and the installer with a
stand-in `launchctl`, `plutil -lint` on macOS.
