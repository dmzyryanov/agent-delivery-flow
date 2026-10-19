#!/bin/sh
# One scheduled fire (D17): the program of the launchd jobs that
# `.claude/scripts/launchd/install.sh` installs, one per job.
#
#   sh .claude/scripts/scheduled-fire.sh <cycle|grooming>
#   sh .claude/scripts/scheduled-fire.sh --auth-status
#
# A fire asks `.claude/scripts/fire-check.mjs <job>` whether there is work.
# With none — exit 1 and a `skip: ` line, nothing else — it appends one line
# to ~/Library/Logs/agent-flow/<repo-name>/fires.log and ends: no session
# starts, no token is spent. Every other answer is work: exit 0, or
# `cannot tell` for one the check would not give — exit 1 with no line, as
# from a node that fails before the check runs — so a fault costs a session,
# never the fires. With work it starts a headless session — the newest
# app-bundled Claude Code, `claude -p` with the procedure's pointer — under
# `caffeinate -i -s`, in the main checkout, in a clean environment: the app's
# own variables broke the session's sign-in when it inherited them. Its
# stream goes to ~/Library/Logs/agent-flow/<repo-name>/runs/<job>-<UTC
# time>.jsonl, the newest 50 of each job kept, and a second line,
# `end exit=<n>`, follows when it ends.
#
# <repo-name> is the name half of `project.repo` in `.claude/flow.json`, read
# through `flow-config.mjs` beside this script. When it cannot be read — no
# node, no file, no `owner/name` — the fire appends its skip line, naming why,
# to ~/Library/Logs/agent-flow/fires.log instead and starts nothing: a session
# could not do the procedure without the configuration either.
#
# A fire never overlaps a run of the same job inside its turn: each job has a
# lock, a directory holding the PID of the process the lock belongs to, and a
# fire that finds it held logs a skip. Held means a live process whose command
# line names scheduled-fire.sh; a lock whose process is gone, or whose PID the
# system has since given to another program, is stale and taken over. The
# cycle's lock goes as soon as the first `result` line of the stream
# appears — the run has ended its first turn, and one that waits
# on its background sub-agents must not stop the next fire (D16) — while the
# process lives on until they finish. The grooming's lock is held until the
# process ends: strictly one run at a time (D14). The launchd job itself
# ends within seconds either way; a supervisor process, left running by the
# job's AbandonProcessGroup, watches the session.
#
# When the grooming's morning run ends (fire-check's reason
# `morning notification`), the supervisor also shows the run's final result
# text as a macOS notification with `osascript`, titled with `project.name`
# (the repository's name when that is empty), the text an argument after
# `--`, so that one opening with `-` is no option: whether `PushNotification`
# reaches the owner from a headless run is not measured, so this is the
# fallback, beside the procedure's own step.
#
# `--auth-status` asks the same binary, in the same clean environment,
# whether the standalone CLI is signed in, and prints only `signed in` or
# `not signed in`: exit 0 or 1. install.sh runs it.
#
# The checkout is the one this script is in. PATH is set here, since
# launchd's lacks node: the newest node under ~/.nvm, Homebrew, /usr/local,
# Docker's, the system's.

set -u

here=$(cd "$(dirname "$0")" && pwd -P) || exit 1
checkout=$(cd "$here/../.." && pwd -P) || exit 1
self=$here/scheduled-fire.sh

CYCLE_PROMPT="Read $checkout/.claude/scheduled/delivery-cycle.md and follow it exactly."
GROOMING_PROMPT="Read $checkout/.claude/scheduled/grooming.md and follow it exactly."
MODEL=claude-opus-5-5
CYCLE_EFFORT=xhigh
GROOMING_EFFORT=medium
LOG_LIMIT=1048576
RUNS_KEPT=50

flow_logs=$HOME/Library/Logs/agent-flow

# --- PATH --------------------------------------------------------------------

node_bin=
if [ -d "$HOME/.nvm/versions/node" ]; then
  newest=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
    sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)
  if [ -n "$newest" ] && [ -x "$HOME/.nvm/versions/node/$newest/bin/node" ]; then
    node_bin=$HOME/.nvm/versions/node/$newest/bin
  fi
fi
PATH=${node_bin:+$node_bin:}/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

# --- The project ---------------------------------------------------------------

# The repository's name names the logs; `repo_fault` says why it could not be
# read, and the logs are then the parent directory's.
repo_fault=
name=
if ! command -v node >/dev/null 2>&1; then
  repo_fault="no node on PATH ($PATH)"
elif ! repo=$(node "$here/flow-config.mjs" project.repo 2>/dev/null); then
  repo_fault=$(node "$here/flow-config.mjs" project.repo 2>&1 >/dev/null | head -n 1)
  [ -n "$repo_fault" ] || repo_fault="flow-config.mjs could not read project.repo"
else
  name=${repo#*/}
  case $repo in
    ?*/?*) ;;
    *) name= ;;
  esac
  case $name in
    '' | . | .. | */* | *[!A-Za-z0-9._-]*)
      repo_fault="project.repo in $checkout/.claude/flow.json is not owner/name: run /flow-init"
      name=
      ;;
  esac
fi
if [ -n "$name" ]; then
  logs=$flow_logs/$name
else
  logs=$flow_logs
fi
runs=$logs/runs
log=$logs/fires.log

# --- The log -----------------------------------------------------------------

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# One line: the time, the job and the rest, with no line break in it.
log_line() {
  mkdir -p "$logs" 2>/dev/null
  if [ -f "$log" ]; then
    size=$(wc -c <"$log" | tr -d ' ')
    if [ "${size:-0}" -gt "$LOG_LIMIT" ]; then
      mv -f "$log" "$log.1"
    fi
  fi
  text=$(printf '%s' "$*" | tr '\n\r\t' '   ' | cut -c1-600)
  printf '%s\n' "$text" >>"$log"
  if [ -t 1 ]; then printf '%s\n' "$text"; fi
}

# --- Claude Code ---------------------------------------------------------------

# The newest app-bundled binary, by version, or the standalone CLI.
find_claude() {
  base="$HOME/Library/Application Support/Claude/claude-code"
  if [ -d "$base" ]; then
    for version in $(ls -1 "$base" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' |
      sort -t. -k1,1nr -k2,2nr -k3,3nr); do
      for candidate in "$base/$version"/*/claude.app/Contents/MacOS/claude; do
        if [ -x "$candidate" ]; then
          printf '%s\n' "$candidate"
          return 0
        fi
      done
    done
  fi
  if [ -x "$HOME/.local/bin/claude" ]; then
    printf '%s\n' "$HOME/.local/bin/claude"
    return 0
  fi
  return 1
}

# Run a command in the clean environment a session gets: these variables and
# no other. SSH_AUTH_SOCK is kept when set, so that git can reach the remote
# through the agent; it names a socket, not a secret.
clean() {
  user=${USER:-$(id -un)}
  if [ -n "${SSH_AUTH_SOCK:-}" ]; then
    env -i HOME="$HOME" USER="$user" LOGNAME="${LOGNAME:-$user}" SHELL="${SHELL:-/bin/zsh}" \
      PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
      SSH_AUTH_SOCK="$SSH_AUTH_SOCK" "$@"
  else
    env -i HOME="$HOME" USER="$user" LOGNAME="${LOGNAME:-$user}" SHELL="${SHELL:-/bin/zsh}" \
      PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" "$@"
  fi
}

# --- The stream ----------------------------------------------------------------

# Whether the stream holds a line whose own type is `result`, read as JSON:
# a tool's output quoting those words is a string inside another line.
HAS_RESULT='
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
const found = lines.some((line) => {
  try { const value = JSON.parse(line); return value !== null && value.type === "result"; }
  catch { return false; }
});
process.exit(found ? 0 : 1);
'

# The last non-empty `result` text of the stream, one line, at most 400
# characters; nothing when there is none.
FINAL_RESULT='
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
let last = "";
for (const line of lines) {
  try {
    const value = JSON.parse(line);
    if (value !== null && value.type === "result" && typeof value.result === "string" && value.result.trim() !== "") last = value.result;
  } catch {}
}
const text = last.replace(/\s+/g, " ").trim();
process.stdout.write(text.length > 400 ? text.slice(0, 399) + "…" : text);
'

has_result() {
  grep -q '"type":"result"' "$1" 2>/dev/null && node -e "$HAS_RESULT" "$1" 2>/dev/null
}

# --- The lock ------------------------------------------------------------------

lock_pid() {
  pid=$(cat "$1/pid" 2>/dev/null)
  case $pid in
    '' | *[!0-9]*) pid= ;;
  esac
  printf '%s' "$pid"
}

# Whether a PID holds a lock: a live process running this script, the fire or
# its supervisor. A PID reused by another program since is no holder.
holds_lock() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  case $(ps -ww -o command= -p "$1" 2>/dev/null) in
    *scheduled-fire.sh*) return 0 ;;
  esac
  return 1
}

set_lock_pid() {
  printf '%s\n' "$2" >"$1/pid.tmp" && mv -f "$1/pid.tmp" "$1/pid"
}

# Remove the lock only while it is still the one this process was given.
release_lock() {
  if [ "$(lock_pid "$1")" = "$2" ]; then
    rm -rf "$1"
  fi
}

# --- --auth-status -------------------------------------------------------------

if [ "${1:-}" = --auth-status ] && [ "$#" -eq 1 ]; then
  claude=$(find_claude) || {
    echo "not signed in: no Claude Code binary under ~/Library/Application Support/Claude/claude-code or ~/.local/bin"
    exit 1
  }
  if clean "$claude" auth status </dev/null 2>/dev/null | grep -Eq '"loggedIn": *true'; then
    echo "signed in"
    exit 0
  fi
  echo "not signed in"
  exit 1
fi

# --- The supervisor ------------------------------------------------------------
#
# sh scheduled-fire.sh --supervise <job> <stamp> <morning 0|1> <claude>
# started by a fire with work, its PID written into the job's lock.

if [ "${1:-}" = --supervise ] && [ "$#" -eq 5 ]; then
  [ -n "$name" ] || exit 1
  job=$2
  stamp=$3
  morning=$4
  claude=$5
  lock=$logs/$job.lock
  stream=$runs/$job-$stamp.jsonl
  errors=$runs/$job-$stamp.err
  case $job in
    cycle) prompt=$CYCLE_PROMPT effort=$CYCLE_EFFORT ;;
    grooming) prompt=$GROOMING_PROMPT effort=$GROOMING_EFFORT ;;
    *) exit 2 ;;
  esac
  cd "$checkout" || exit 1
  clean caffeinate -i -s "$claude" -p "$prompt" --model "$MODEL" --effort "$effort" \
    --permission-mode auto --output-format stream-json --verbose \
    </dev/null >"$stream" 2>"$errors" &
  child=$!
  if [ "$job" = cycle ]; then
    while kill -0 "$child" 2>/dev/null; do
      if has_result "$stream"; then break; fi
      sleep 1
    done
    release_lock "$lock" "$$"
  fi
  wait "$child"
  code=$?
  release_lock "$lock" "$$"
  log_line "$(now_iso) $job end exit=$code"
  if [ "$morning" = 1 ]; then
    text=$(node -e "$FINAL_RESULT" "$stream" 2>/dev/null)
    [ -n "$text" ] || text="The morning grooming run ended (exit $code) with no result text; see fires.log."
    title=$(node "$here/flow-config.mjs" project.name 2>/dev/null | tr '\n\r\t' '   ')
    title=$(printf '%s' "$title" | sed -e 's/^ *//' -e 's/ *$//')
    [ -n "$title" ] || title=$name
    osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
      -e 'end run' -- "$text" "$title · grooming" >/dev/null 2>&1
  fi
  [ -s "$errors" ] || rm -f "$errors"
  exit 0
fi

# --- A fire --------------------------------------------------------------------

if [ "$#" -ne 1 ] || { [ "$1" != cycle ] && [ "$1" != grooming ]; }; then
  echo "usage: sh .claude/scripts/scheduled-fire.sh <cycle|grooming> | --auth-status" >&2
  exit 2
fi
job=$1
started=$(now_iso)

if [ -n "$repo_fault" ]; then
  log_line "$started $job skip $repo_fault ($checkout)"
  exit 0
fi

lock=$logs/$job.lock
mkdir -p "$logs" "$runs" || exit 1

owned=0
cleanup() {
  if [ "$owned" = 1 ]; then release_lock "$lock" "$$"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The lock: made, or held by a live run of this script, or stale and taken
# over.
note=
if mkdir "$lock" 2>/dev/null; then
  set_lock_pid "$lock" "$$"
  owned=1
else
  holder=$(lock_pid "$lock")
  if holds_lock "$holder"; then
    log_line "$started $job skip previous $job run still in its turn (pid $holder)"
    exit 0
  fi
  rm -rf "$lock"
  if mkdir "$lock" 2>/dev/null; then
    set_lock_pid "$lock" "$$"
    owned=1
    note=" [stale lock of pid ${holder:-unknown} taken over]"
  else
    log_line "$started $job skip previous $job run still in its turn (pid unknown)"
    exit 0
  fi
fi

answer=$(node "$here/fire-check.mjs" "$job")
status=$?
answer=$(printf '%s\n' "$answer" | head -n 1)
# A skip is exit 1 with a `skip: ` line and nothing else: node exits 1 too
# when it fails before the check runs, printing nothing on stdout.
case $status in
  0) reason=${answer#work: } ;;
  *)
    case $status:$answer in
      '1:skip: '*)
        log_line "$started $job skip ${answer#skip: }$note"
        exit 0
        ;;
    esac
    # Whatever else fire-check answers is a check that could not tell: work.
    reason="cannot tell: fire-check exit $status${answer:+: $answer}"
    ;;
esac

claude=$(find_claude) || {
  log_line "$started $job skip no Claude Code binary found, with work present ($reason)$note"
  exit 0
}

# The newest runs of this job are kept, this one among them.
ls -1 "$runs" 2>/dev/null | grep -E "^$job-[0-9]{8}T[0-9]{6}Z\.jsonl\$" | sort -r |
  tail -n +"$RUNS_KEPT" | while read -r run_name; do
  rm -f "$runs/$run_name" "$runs/${run_name%.jsonl}.err"
done

stamp=$(printf '%s' "$started" | tr -d ':-')
morning=0
case $reason in
  'morning notification'*) [ "$job" = grooming ] && morning=1 ;;
esac

log_line "$started $job run $reason$note"
sh "$self" --supervise "$job" "$stamp" "$morning" "$claude" \
  </dev/null >>"$logs/launchd-$job.log" 2>&1 &
set_lock_pid "$lock" "$!"
owned=0
exit 0
