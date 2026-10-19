#!/bin/sh
# Stop the scheduled fires (D17): boot both launchd jobs out of the user's
# GUI domain and remove their plists from ~/Library/LaunchAgents/.
#
#   sh .claude/scripts/launchd/uninstall.sh
#
# The jobs are `dev.agent-flow.<repo-name>.cycle` and `.grooming`, <repo-name>
# the name half of `project.repo` in `.claude/flow.json`, read through
# `flow-config.mjs` as install.sh reads it, so node must be on PATH. A session
# a fire already started is not stopped: it is a process of its own, named by
# the PID in ~/Library/Logs/agent-flow/<repo-name>/<job>.lock while it holds
# the lock. The logs under that directory stay.

set -u

fail() {
  echo "uninstall: $1" >&2
  exit 1
}

here=$(cd "$(dirname "$0")" && pwd -P) || fail "cannot enter the script's directory"
checkout=$(cd "$here/../../.." && pwd -P) || fail "cannot enter the checkout"
agents=$HOME/Library/LaunchAgents
uid=$(id -u)

command -v node >/dev/null 2>&1 || fail "no node on PATH: .claude/flow.json is read with it"
if ! repo=$(node "$checkout/.claude/scripts/flow-config.mjs" project.repo 2>/dev/null); then
  why=$(node "$checkout/.claude/scripts/flow-config.mjs" project.repo 2>&1 >/dev/null | head -n 1)
  fail "${why:-flow-config.mjs could not read project.repo}"
fi
name=${repo#*/}
case $repo in
  ?*/?*) ;;
  *) name= ;;
esac
case $name in
  '' | . | .. | */* | *[!A-Za-z0-9._-]*)
    fail "project.repo in $checkout/.claude/flow.json is not owner/name"
    ;;
esac

for job in cycle grooming; do
  label=dev.agent-flow.$name.$job
  if launchctl bootout "gui/$uid/$label" >/dev/null 2>&1; then
    echo "booted out $label"
  else
    echo "$label was not loaded"
  fi
  if [ -e "$agents/$label.plist" ]; then
    rm -f "$agents/$label.plist" && echo "removed $agents/$label.plist"
  fi
done
echo "The logs stay in $HOME/Library/Logs/agent-flow/$name/."
