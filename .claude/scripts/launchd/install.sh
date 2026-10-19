#!/bin/sh
# Install the scheduled fires' two launchd jobs (D17), once, by the owner:
#
#   sh .claude/scripts/launchd/install.sh
#
# The optional, cheaper path beside the desktop app's scheduled tasks, which
# `/flow-init` creates: a launchd job asks `fire-check.mjs` for work and
# starts a session only when there is some.
#
# It reads three values of `.claude/flow.json` through `flow-config.mjs`, so
# node must be on PATH: `project.repo`, whose name half names the jobs
# (`dev.agent-flow.<repo-name>.cycle` and `.grooming`) and their logs
# (~/Library/Logs/agent-flow/<repo-name>/), and the crons `schedule.cycle`
# and `schedule.grooming`. A cron is installed in either of the two shapes
# the defaults have, `*/N * * * *` (every N minutes of every hour from minute
# 0) and `M1,M2,… * * * *` (those minutes of every hour), as one calendar
# interval per minute; any other is refused with one line, and nothing is
# installed.
#
# It renders cycle.plist.in and grooming.plist.in into
# ~/Library/LaunchAgents/, filling in the label, this checkout's path, the
# logs directory and the minutes, checks each with `plutil -lint`, and loads
# it into the user's GUI domain: `launchctl bootout` first, whose failure for
# a job not loaded yet is ignored, then `launchctl bootstrap`. Run again, it
# replaces both. Before it installs anything it checks that the standalone
# CLI is signed in, through the binary and the clean environment the fires
# use (`scheduled-fire.sh --auth-status`), which prints no token. Nothing in
# the repository changes; uninstall.sh undoes it.
#
# The desktop app's scheduled tasks of the cycle and the grooming are
# disabled beside it: both would fire the same procedures again.

set -u

fail() {
  echo "install: $1" >&2
  exit 1
}

here=$(cd "$(dirname "$0")" && pwd -P) || fail "cannot enter the script's directory"
checkout=$(cd "$here/../../.." && pwd -P) || fail "cannot enter the checkout"
agents=$HOME/Library/LaunchAgents
uid=$(id -u)

# The paths go into XML and into a sed replacement: letters, digits, spaces
# and . _ / @ + - only.
for path in "$checkout" "$HOME"; do
  if printf '%s' "$path" | LC_ALL=C grep -q '[^A-Za-z0-9._/@+ -]'; then
    fail "the path $path holds a character the plist templates do not take"
  fi
done
[ -f "$checkout/.claude/scripts/scheduled-fire.sh" ] || fail "no .claude/scripts/scheduled-fire.sh in $checkout"

# --- The configuration -----------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "no node on PATH: .claude/flow.json is read with it"
config() {
  node "$checkout/.claude/scripts/flow-config.mjs" "$1" 2>/dev/null && return 0
  why=$(node "$checkout/.claude/scripts/flow-config.mjs" "$1" 2>&1 >/dev/null | head -n 1)
  fail "${why:-flow-config.mjs could not read $1}"
}

repo=$(config project.repo) || exit 1
name=${repo#*/}
case $repo in
  ?*/?*) ;;
  *) name= ;;
esac
case $name in
  '' | . | .. | */* | *[!A-Za-z0-9._-]*)
    fail "project.repo in $checkout/.claude/flow.json is not owner/name: run /flow-init"
    ;;
esac

# The minutes of every hour a cron fires at, space-separated, for the two
# shapes installed here; status 1 for any other. Globbing is off while the
# cron is split, so its `*` stays a word.
cron_minutes() {
  (
    set -f
    # shellcheck disable=SC2086 # split into the cron's fields on purpose
    set -- $1
    [ "$#" -eq 5 ] && [ "$2" = '*' ] && [ "$3" = '*' ] && [ "$4" = '*' ] && [ "$5" = '*' ] || exit 1
    out=
    case $1 in
      '*/'*)
        step=${1#??}
        case $step in '' | *[!0-9]* | ???*) exit 1 ;; esac
        step=${step#0}
        [ -n "$step" ] && [ "$step" -ge 1 ] && [ "$step" -le 59 ] || exit 1
        minute=0
        while [ "$minute" -lt 60 ]; do
          out="$out $minute"
          minute=$((minute + step))
        done
        ;;
      *)
        case $1 in '' | ,* | *, | *,,* | *[!0-9,]*) exit 1 ;; esac
        IFS=,
        # shellcheck disable=SC2086 # split on the commas on purpose
        set -- $1
        for minute in "$@"; do
          case $minute in '' | ???*) exit 1 ;; esac
          minute=${minute#0}
          [ -n "$minute" ] || minute=0
          [ "$minute" -le 59 ] || exit 1
          out="$out $minute"
        done
        ;;
    esac
    printf '%s\n' "${out# }"
  )
}

# The minutes of a job's cron, or the one line refusing it.
job_minutes() {
  cron=$(config "schedule.$1") || exit 1
  cron_minutes "$cron" ||
    fail "schedule.$1 in .claude/flow.json is \"$cron\"; only \"*/N * * * *\" and \"M1,M2,... * * * *\" install as launchd jobs: use the desktop app's scheduled task for it"
}
minutes_cycle=$(job_minutes cycle) || exit 1
minutes_grooming=$(job_minutes grooming) || exit 1

label_of() { printf 'dev.agent-flow.%s.%s' "$name" "$1"; }
logs=$HOME/Library/Logs/agent-flow/$name

# --- The jobs --------------------------------------------------------------------

command -v launchctl >/dev/null 2>&1 || fail "no launchctl: the jobs are for macOS"
command -v plutil >/dev/null 2>&1 || fail "no plutil: the jobs are for macOS"

signed=$(sh "$checkout/.claude/scripts/scheduled-fire.sh" --auth-status) ||
  fail "the standalone CLI is ${signed:-not signed in}: run \`claude auth login\` in Terminal once, then run this script again"

mkdir -p "$agents" "$logs" || fail "cannot make $agents or $logs"

# The template with its placeholders filled in: the line `@CALENDAR@` becomes
# one calendar interval per minute.
render() {
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = '@CALENDAR@' ]; then
      for minute in $3; do
        printf '    <dict>\n      <key>Minute</key>\n      <integer>%s</integer>\n    </dict>\n' "$minute"
      done
    else
      printf '%s\n' "$line"
    fi
  done <"$1" | sed -e "s#@LABEL@#$2#g" -e "s#@CHECKOUT@#$checkout#g" -e "s#@LOGS@#$logs#g"
}

for job in cycle grooming; do
  label=$(label_of "$job")
  target=$agents/$label.plist
  draft=$target.draft.$$
  case $job in
    cycle) minutes=$minutes_cycle ;;
    *) minutes=$minutes_grooming ;;
  esac
  render "$here/$job.plist.in" "$label" "$minutes" >"$draft" || {
    rm -f "$draft"
    fail "cannot write $draft"
  }
  if grep -q '@[A-Z][A-Z]*@' "$draft"; then
    rm -f "$draft"
    fail "$label: a placeholder is left unfilled"
  fi
  if ! plutil -lint "$draft" >/dev/null; then
    rm -f "$draft"
    fail "$label: plutil -lint refuses the rendered plist"
  fi
  mv -f "$draft" "$target" || fail "cannot write $target"
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$uid" "$target"; then
    # A job booted out a moment ago can still be on its way out.
    sleep 2
    launchctl bootstrap "gui/$uid" "$target" || fail "launchctl bootstrap refused $target"
  fi
  echo "installed $label: $target"
done

listed() { printf '%s' "$1" | sed 's/ /, /g'; }
cat <<TEXT

The fires run at minutes $(listed "$minutes_cycle") (cycle) and $(listed "$minutes_grooming") (grooming)
of every hour, local time. Each appends one line to $logs/fires.log.
Disable the desktop app's scheduled tasks of the cycle and the grooming, if
there are any: they would fire the same procedures again.

Check a job:  launchctl print gui/$uid/$(label_of cycle) | grep -E 'state|runs|last exit'
Read the log: tail -f $logs/fires.log
Stop both:    sh $checkout/.claude/scripts/launchd/uninstall.sh
TEXT
