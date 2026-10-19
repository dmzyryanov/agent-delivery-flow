#!/bin/sh
# Check the conditions of a delivery run, at both points where they can be
# checked. The script detects which one it is called at and is safe to run twice.
#
#   1. Before branching, from a checkout on the main branch. Fetches, verifies
#      the base, reports the worktrees, and prints the BASE_SHA and the
#      `git worktree add` command to run next — at a path outside the
#      repository, because an ignored path inside it is what `git clean -xdf`
#      deletes, from any session sharing the checkout (D3). It does not
#      refuse to run on the main branch: refusing there would make the
#      documented order impossible, and the only order that passed would check
#      the base after the branch had already been cut from it.
#   2. From the task branch or its worktree. It derives the branch's actual base
#      as the merge base with the base ref, checks the definitions there rather
#      than at whatever the ref points to now, and reports it. A base ref that
#      has moved on since the branch was cut is the ordinary case and not an
#      error; sharing no history with it at all is.
#
# The failure this guards against happens at checkout time: the agent
# definitions are versioned files, so a branch cut from a base without
# .claude/agents loses the whole team the moment it is checked out. Call 1 is
# what prevents that; call 2 can only detect it afterwards. The check inspects
# the base ref itself, not the working tree, and --full-tree keeps the pathspec
# relative to the repository root, so the answer is the same from any working
# directory.
#
# Freshness of origin is established by fetching rather than by testing how old
# the last fetch was: a staleness report leaves the caller to fetch anyway, and
# a time-based test would pass on a fetch that failed an hour ago. A fetch that
# cannot reach the remote fails this script, so an offline run is never mistaken
# for an up-to-date one.
#
# The main branch is `project.mainBranch` in `.claude/flow.json`, read through
# `flow-config.mjs` beside this script; `main` when the file cannot be read.
#
# Usage: .claude/scripts/delivery-preflight.sh [base-ref]   (default origin/<main branch>)

set -u

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  echo "usage: $0 [base-ref]" >&2
  exit 2
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "delivery-preflight: not inside a git repository" >&2
  exit 2
fi

main_branch=$(node "$(dirname "$0")/flow-config.mjs" project.mainBranch 2>/dev/null) || main_branch=
[ -n "$main_branch" ] || main_branch=main
if ! git check-ref-format --branch "$main_branch" >/dev/null 2>&1; then
  echo "delivery-preflight: project.mainBranch in .claude/flow.json is not a branch name: $main_branch" >&2
  exit 2
fi

base="${1:-origin/$main_branch}"

# Which remote to fetch. A base is normally `origin/<main branch>`, but it may
# be fully qualified (`refs/remotes/origin/main`) or a local branch whose name
# contains a slash (`feat/thing`), and the leading path component of those is
# not a remote. Anything that does not name a configured remote falls back to
# origin rather than failing, because the fetch is about freshness, not about
# the ref's syntax.
case "$base" in
  refs/remotes/*)
    remote=${base#refs/remotes/}
    remote=${remote%%/*}
    ;;
  */*) remote=${base%%/*} ;;
  *) remote=origin ;;
esac
if ! git remote get-url "$remote" >/dev/null 2>&1; then
  remote=origin
fi
if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "delivery-preflight: no remote named $remote is configured" >&2
  exit 2
fi
if ! git fetch --quiet "$remote"; then
  echo "delivery-preflight: could not fetch $remote; origin state is unknown" >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "delivery-preflight: base ref not found: $base" >&2
  exit 2
fi
base_sha=$(git rev-parse --verify "$base^{commit}")

branch=$(git symbolic-ref --quiet --short HEAD || true)

# Which commit this run is pinned to. Before the branch exists that is the base
# ref itself. Afterwards it is the merge base: the main branch moves on while a
# task is in flight, so the ref's current tip is not what the branch was cut
# from, and it is the commit it was cut from whose tree the branch inherited.
if [ "$branch" = "$main_branch" ]; then
  recorded=$base_sha
  recorded_label="$base"
elif [ -z "$branch" ]; then
  echo "delivery-preflight: HEAD is detached; check out the task branch" >&2
  exit 1
else
  if ! recorded=$(git merge-base "$base_sha" HEAD 2>/dev/null) || [ -z "$recorded" ]; then
    echo "delivery-preflight: $branch shares no history with $base ($base_sha)" >&2
    echo "delivery-preflight: it was not cut from this base; cut it again from" >&2
    echo "delivery-preflight: $base, or pass the base it really has" >&2
    exit 1
  fi
  recorded_label="$branch's base"
fi

present=$(git ls-tree -r --full-tree --name-only "$recorded" -- .claude/agents/)
missing=""
for agent in architect developer reviewer tester tester-look tester-process; do
  if ! echo "$present" | grep -qx ".claude/agents/$agent.md"; then
    missing="$missing $agent.md"
  fi
done
if [ -n "$missing" ]; then
  echo "delivery-preflight: $recorded ($recorded_label) is missing:$missing" >&2
  exit 1
fi

# Worktrees are reported here and never acted on. `git worktree prune` would
# erase the evidence of the failure it would be cleaning up after (D3). An
# entry whose directory is gone is either the wreckage of a crashed run of your
# own or a tree another session was working in until something deleted it —
# `git clean -xdf` over an ignored in-repo worktree does exactly that — and
# after the prune the two are indistinguishable. Worktrees this run did not
# create are named for a related reason: several tasks are developed side by
# side (D16), each in a worktree of its own, and a tree another session is
# working in is left alone; `node .claude/scripts/delivery-queue.mjs status`
# says whose it is. One delivery to this environment at a time is held by the
# delivery lock, not by the trees.
# A worktree inside the repository is named because it is the condition D3
# exists because of and this is the one place that sees it. None of the three
# changes the exit status: the script cannot tell a live sibling session from a
# finished run's leftover directory, and failing on the second would block
# every later run on a stale entry.
#
# The listing itself is not allowed to fail quietly. `main_worktree` below comes
# from it, and an empty value would make the suggested path `./-worktrees` —
# relative, inside the repository, untracked: the exact failure this script is
# supposed to steer away from.
if ! worktree_list=$(git worktree list) || [ -z "$worktree_list" ]; then
  echo "delivery-preflight: git worktree list failed or returned nothing;" >&2
  echo "delivery-preflight: the worktree state is unknown, so the worktree" >&2
  echo "delivery-preflight: path this script would suggest cannot be trusted" >&2
  exit 1
fi
echo "worktrees:"
printf '%s\n' "$worktree_list" | sed 's/^/  /'

# The first record of `git worktree list --porcelain` is the main worktree; the
# current one is wherever this script was called from. Neither is a leftover.
# Directory existence is tested here rather than read from git's `prunable`
# annotation, which older git versions do not print.
if ! worktree_porcelain=$(git worktree list --porcelain) || [ -z "$worktree_porcelain" ]; then
  echo "delivery-preflight: git worktree list --porcelain failed or returned" >&2
  echo "delivery-preflight: nothing; the worktree state is unknown" >&2
  exit 1
fi
if ! self=$(git rev-parse --show-toplevel) || [ -z "$self" ]; then
  echo "delivery-preflight: cannot resolve this worktree's root" >&2
  exit 1
fi

main_worktree=""
stale=""
stale_n=0
foreign=""
foreign_n=0
inside=""
inside_n=0
while IFS= read -r line; do
  case "$line" in
    "worktree "*) path=${line#worktree } ;;
    *) continue ;;
  esac
  if [ -z "$main_worktree" ]; then
    main_worktree=$path
    continue
  fi
  if [ ! -d "$path" ]; then
    stale="$stale$path
"
    stale_n=$((stale_n + 1))
    continue
  fi
  if [ "$path" != "$self" ]; then
    foreign="$foreign$path
"
    foreign_n=$((foreign_n + 1))
  fi
  # Reported independently of the two classifications above: a tree inside the
  # repository is dangerous whoever created it, including this run.
  case "$path" in
    "$main_worktree"/*)
      inside="$inside$path
"
      inside_n=$((inside_n + 1))
      ;;
  esac
done <<PORCELAIN
$worktree_porcelain
PORCELAIN

if [ -z "$main_worktree" ]; then
  echo "delivery-preflight: no main worktree in git worktree list --porcelain" >&2
  exit 1
fi

if [ "$stale_n" -gt 0 ]; then
  echo "note: worktree entries whose directory is gone: $stale_n"
  printf '%s' "$stale" | sed 's/^/note:   /'
  echo "note: this script does not prune them. A stale entry left by a crashed"
  echo "note: run of your own and one whose tree another session was using"
  echo "note: until something deleted it look identical here, and pruning"
  echo "note: removes that difference along with the entry. Establish which it"
  echo "note: is, then prune deliberately:"
  echo "note:   git worktree prune"
fi

if [ "$foreign_n" -gt 0 ]; then
  echo "note: worktrees this run did not create: $foreign_n"
  printf '%s' "$foreign" | sed 's/^/note:   /'
  echo "note: measured as every worktree that is neither the main checkout nor"
  echo "note: the one this script was called from, so a second call from the"
  echo "note: main checkout names this run's own tree as well."
  echo "note: another session may be working in them right now. They belong"
  echo "note: to other tasks in the delivery queue or to an attended session,"
  echo "note: which node .claude/scripts/delivery-queue.mjs status says. Leave"
  echo "note: them alone: do not remove or clean them. One delivery to this"
  echo "note: environment at a time is held by the delivery lock."
fi

if [ "$inside_n" -gt 0 ]; then
  echo "note: worktrees inside the repository: $inside_n"
  printf '%s' "$inside" | sed 's/^/note:   /'
  echo "note: these sit under $main_worktree, so a git clean -xdf run by any"
  echo "note: session sharing this checkout deletes them, ignored or not, and"
  echo "note: the loss is silent (D3). Move each one outside the repository"
  echo "note: with git worktree move, or finish and remove it."
fi

if [ "$branch" = "$main_branch" ]; then
  echo "BASE_SHA=$recorded ($base; record this value for the run)"
  echo "on $main_branch: no task branch yet. Create one, then run this script again:"
  wt_home="$(dirname "$main_worktree")/$(basename "$main_worktree")-worktrees"
  echo "  git worktree add -b <task-branch> $wt_home/<task-branch> $recorded"
  exit 0
fi

echo "BASE_SHA=$recorded (the commit $branch was cut from; pin the run to this)"
if [ "$recorded" != "$base_sha" ]; then
  # Not an error, and the common one of the two readings of this condition: the
  # branch is fine and the ref moved. The other reading — a branch cut from the
  # wrong place — shares no history at all and failed above.
  echo "note: $base has advanced to $base_sha since $branch was cut."
  echo "note: that is expected; integrate it into the branch before merging,"
  echo "note: the integration checked as docs/DELIVERY.md step 4 says (step 5)."
  echo "note: BASE_SHA above is unchanged by it: the diff and a review of the"
  echo "note: whole change are taken against it until $main_branch is integrated."
fi
echo "branch=$branch"
cat <<'SEQUENCE'
Sequence: developer implements on the task branch; tester verifies the stated
criteria in its own worktree, which the main session fingerprints before and
after; reviewer reads the artifact from review-artifact.sh; the main session
opens and merges the pull request, follows the deployment where the project
deploys, verifies the site where it has one and tags a changed version.
SEQUENCE
