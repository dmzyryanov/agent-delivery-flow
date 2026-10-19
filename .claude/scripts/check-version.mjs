// The version rule of `docs/DELIVERY.md` (Version), checked in CI for every
// pull request and by the Coordinator before merging.
//
//   node .claude/scripts/check-version.mjs <base ref or sha>
//
// Compares the working tree's commit (HEAD) with the merge base of HEAD and
// the base. With `delivery.versioning` false in `.claude/flow.json` it checks
// nothing. Otherwise:
//
// - `VERSION` holds one `MAJOR.MINOR.PATCH` line;
// - a changed VERSION is the next patch, the next minor with patch 0, or the
//   next major with minor and patch 0 (a new major is the owner's decision;
//   the check only keeps the number well-formed), and `CHANGELOG.md` has a
//   `## <version>` heading for it as its first `## ` heading;
// - a change to a runtime file needs a changed VERSION; a change to nothing
//   but documentation, tests and delivery tooling keeps it.
//
// Not runtime: `*.md`, `docs/**`, `.claude/**`, `.github/**`, `VERSION`,
// `CHANGELOG.md`, and test files (`*.test.*`, `*.spec.*`, anything under a
// `test/`, `tests/`, `__tests__/` or `e2e/` directory). Everything else is.
//
// Exit 0 and one line saying what was checked; 1 a violation, one line per
// problem; 2 wrong usage or git could not answer.

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { FlowConfigError, loadFlow } from './flow-config.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isRuntimePath(path) {
  if (path === 'VERSION' || path === 'CHANGELOG.md') return false;
  if (path.endsWith('.md')) return false;
  if (/^(docs|\.claude|\.github)\//.test(path)) return false;
  if (/\.(test|spec)\.[^/]+$/.test(path)) return false;
  if (/(^|\/)(test|tests|__tests__|e2e)\//.test(path)) return false;
  return true;
}

export function parseVersion(text) {
  const lines = text.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
  if (lines.length !== 1) return null;
  const match = SEMVER.exec(lines[0]);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isNextVersion([a, b, c], [x, y, z]) {
  return (
    (x === a && y === b && z === c + 1) ||
    (x === a && y === b + 1 && z === 0) ||
    (x === a + 1 && y === 0 && z === 0)
  );
}

export function firstChangelogHeading(text) {
  const match = /^## +(\S+)/m.exec(text);
  return match ? match[1].replace(/^v/, '') : null;
}

// The checks on given inputs, so tests need no git: returns problem lines.
export function checkVersion({ baseVersion, headVersion, changelog, changedFiles }) {
  const problems = [];
  const head = parseVersion(headVersion ?? '');
  if (!head) {
    problems.push('VERSION is not one MAJOR.MINOR.PATCH line');
    return problems;
  }
  const base = baseVersion === null ? null : parseVersion(baseVersion);
  const changed = base === null || head.join('.') !== base.join('.');
  const runtime = changedFiles.filter(isRuntimePath);
  if (changed && base !== null) {
    if (!isNextVersion(base, head)) {
      problems.push(
        `VERSION ${head.join('.')} is not the next patch, minor or major after ${base.join('.')}`,
      );
    }
    if (firstChangelogHeading(changelog ?? '') !== head.join('.')) {
      problems.push(`CHANGELOG.md does not open with a "## ${head.join('.')}" entry`);
    }
  }
  if (!changed && runtime.length > 0) {
    problems.push(
      `runtime files changed but VERSION stays ${head.join('.')}: ${runtime.slice(0, 5).join(', ')}${runtime.length > 5 ? ', …' : ''}`,
    );
  }
  if (changed && base !== null && runtime.length === 0) {
    problems.push('only documentation, tests or delivery tooling changed: keep the version');
  }
  return problems;
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout;
}

function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    process.stderr.write('usage: node .claude/scripts/check-version.mjs <base ref or sha>\n');
    return 2;
  }
  let flow;
  try {
    flow = loadFlow(undefined, { requireRepo: false });
  } catch (error) {
    if (!(error instanceof FlowConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (!flow.delivery.versioning) {
    process.stdout.write('version: not checked, delivery.versioning is false\n');
    return 0;
  }
  const mergeBase = git(['merge-base', 'HEAD', argv[0]])?.trim();
  if (!mergeBase) {
    process.stderr.write(`git cannot find the merge base of HEAD and ${argv[0]}\n`);
    return 2;
  }
  const names = git(['diff', '--name-only', '-z', mergeBase, 'HEAD']);
  if (names === null) {
    process.stderr.write('git diff did not answer\n');
    return 2;
  }
  const changedFiles = names.split('\0').filter(Boolean);
  const problems = checkVersion({
    baseVersion: git(['show', `${mergeBase}:VERSION`]),
    headVersion: git(['show', 'HEAD:VERSION']),
    changelog: git(['show', 'HEAD:CHANGELOG.md']),
    changedFiles,
  });
  if (problems.length > 0) {
    for (const problem of problems) process.stdout.write(`version: ${problem}\n`);
    return 1;
  }
  process.stdout.write(
    `version: ${git(['show', 'HEAD:VERSION']).trim()} fits ${changedFiles.length} changed file(s)\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
