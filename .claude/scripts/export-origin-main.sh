#!/bin/sh
# Export the tree of origin's main branch into <directory>/origin-main/ and
# print the SHA it was taken at. The scheduled grooming (D14) runs it after
# `git fetch origin`: its sub-agents read files and the architect has no shell,
# so they read this tree, not the main checkout, which can lag behind. The main
# branch is `project.mainBranch` in `.claude/flow.json`, read through
# `flow-config.mjs` beside this script; `main` when the file cannot be read.
#
# The one allow rule, `Bash(sh .claude/scripts/export-origin-main.sh *)`,
# grants this script, not `git archive` or `tar`, whose options run other
# programs or write anywhere (`tar --use-compress-program`, `-P`). So the
# checks are here: exactly one argument, an absolute path to a directory that
# exists and, resolved with every symlink and `..` followed, lies under
# `/private/tmp/claude-` (the session scratchpads on macOS) or `/tmp/claude-`
# (on Linux), and that holds no `origin-main` yet. Anything else is refused
# with exit 2 and one line saying why.
#
# The archive goes to a file in that directory first, so a failure of
# `git archive` and one of `tar` are each seen, which a pipe in POSIX sh does
# not report. On either, the script removes what it wrote and exits 1.
#
# Usage, from the repository: sh .claude/scripts/export-origin-main.sh <directory>

set -u

refuse() {
  echo "export-origin-main: $1" >&2
  exit 2
}
fail() {
  echo "export-origin-main: $1" >&2
  exit 1
}

[ "$#" -eq 1 ] || refuse "takes exactly one argument, a directory under /private/tmp/claude-* or /tmp/claude-*; got $#"
dir=$1
case $dir in
  /*) ;;
  *) refuse "not an absolute path: $dir" ;;
esac
[ -d "$dir" ] || refuse "no such directory: $dir"
resolved=$(cd -P "$dir" && pwd -P) || refuse "cannot enter: $dir"
case $resolved in
  /private/tmp/claude-?* | /tmp/claude-?*) ;;
  *) refuse "not under /private/tmp/claude-* or /tmp/claude-*: $dir resolves to $resolved" ;;
esac
target=$resolved/origin-main
if [ -e "$target" ] || [ -L "$target" ]; then
  refuse "already exists: $target"
fi

main_branch=$(node "$(dirname "$0")/flow-config.mjs" project.mainBranch 2>/dev/null) || main_branch=
[ -n "$main_branch" ] || main_branch=main
git check-ref-format --branch "$main_branch" >/dev/null 2>&1 ||
  refuse "project.mainBranch in .claude/flow.json is not a branch name: $main_branch"

top=$(git rev-parse --show-toplevel) || fail "not in a git repository"
cd "$top" || fail "cannot enter $top"
# The remote-tracking ref by its full name: a bare `origin/main` resolves to a
# local branch or tag of that name first.
sha=$(git rev-parse --verify --quiet "refs/remotes/origin/$main_branch^{commit}") ||
  fail "no origin/$main_branch here; fetch it first"

archive=$(mktemp "$resolved/origin-main.XXXXXX") || fail "cannot write in $resolved"
if ! git archive --format=tar --prefix=origin-main/ -o "$archive" "$sha"; then
  rm -f "$archive"
  fail "git archive failed"
fi
if ! tar -x -f "$archive" -C "$resolved"; then
  rm -f "$archive"
  rm -rf "$target"
  fail "tar failed"
fi
rm -f "$archive"
echo "$sha"
