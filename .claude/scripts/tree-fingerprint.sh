#!/bin/sh
# Print one stable fingerprint of a working tree: its HEAD and a hash of
# everything git reports as not committed.
#
# Taken before and after every tester run. Tester holds Bash and can therefore
# write files; this is what makes "it did not" checkable rather than promised.
# Two identical fingerprints mean the verdict describes the tree that was handed
# over; a mismatch invalidates that run's verdict.
#
# Ignored paths stay out of it. `git status --porcelain` lists tracked changes
# and untracked files, but reports ignored ones only when asked with --ignored,
# so node_modules/, build output, test reports and .claude/worktrees/ — every
# pattern in the repository's .gitignore — cannot move the fingerprint. An
# install or a test run inside the worktree is therefore invisible here, which
# is the point: those are expected, edits are not.
#
# The hash comes from git itself rather than sha256sum or shasum, whose
# availability differs between macOS and the slim Linux images the checks run
# in. Fingerprinting a git worktree already requires git.
#
# Usage: .claude/scripts/tree-fingerprint.sh <worktree-path>

set -u

tree="${1:-}"
if [ -z "$tree" ]; then
  echo "usage: $0 <worktree-path>" >&2
  exit 2
fi
if [ ! -d "$tree" ]; then
  echo "tree-fingerprint: no such directory: $tree" >&2
  exit 2
fi
if ! git -C "$tree" rev-parse --git-dir >/dev/null 2>&1; then
  echo "tree-fingerprint: not a git worktree: $tree" >&2
  exit 2
fi

head=$(git -C "$tree" rev-parse HEAD) || exit 2
status=$(git -C "$tree" status --porcelain --untracked-files=all) || exit 2
status_hash=$(printf '%s' "$status" | git hash-object --stdin) || exit 2

echo "$head $status_hash"
