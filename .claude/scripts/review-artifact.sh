#!/bin/sh
# Produce the artifact the reviewer reads.
#
# The reviewer holds no Bash, so it cannot run git diff and cannot check for
# itself which commits it is looking at. This file is its whole view of the
# change, and the header is what ties the verdict to an exact base, head and
# working tree: the git commands the reviewer used to run were mostly
# re-deriving those three values.
#
# The fingerprint is of the tree this script is invoked in, so a reviewer
# reading work that is not fully committed can see that it is. That only means
# anything if the tree is the one being reviewed, so the script refuses to run
# in a tree whose HEAD is not <head>: invoked from the main checkout, which sits
# on main and may carry unrelated local changes, it would otherwise stamp the
# header with an unrelated tree's fingerprint and the reviewer has no shell to
# catch it with.
#
# Usage: .claude/scripts/review-artifact.sh <base> <head> <output-path>

set -u

base="${1:-}"
head="${2:-}"
out="${3:-}"
if [ -z "$base" ] || [ -z "$head" ] || [ -z "$out" ]; then
  echo "usage: $0 <base> <head> <output-path>" >&2
  exit 2
fi

for ref in "$base" "$head"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "review-artifact: ref not found: $ref" >&2
    exit 2
  fi
done

base_sha=$(git rev-parse --verify "$base^{commit}")
head_sha=$(git rev-parse --verify "$head^{commit}")
top=$(git rev-parse --show-toplevel) || exit 2

tree_head=$(git rev-parse HEAD) || exit 2
if [ "$tree_head" != "$head_sha" ]; then
  echo "review-artifact: $top is at $tree_head, not at $head ($head_sha)" >&2
  echo "review-artifact: run this in the worktree holding the reviewed head," >&2
  echo "review-artifact: so the fingerprint describes the tree being reviewed" >&2
  exit 1
fi

fingerprint=$(sh "$(dirname "$0")/tree-fingerprint.sh" "$top") || exit 1
generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  echo "# Review artifact"
  echo "# base: $base $base_sha"
  echo "# head: $head $head_sha"
  echo "# tree-fingerprint: $fingerprint"
  echo "# tree: $top"
  echo "# generated: $generated"
  echo "# diff: git diff $base_sha...$head_sha"
  echo "#"
  echo "# Everything below this line is that diff, unedited."
  git diff "$base_sha...$head_sha"
} > "$out" || exit 1

echo "review-artifact: $out ($(wc -l < "$out" | tr -d ' ') lines)"
echo "base=$base_sha head=$head_sha fingerprint=$fingerprint"
