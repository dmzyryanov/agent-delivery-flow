// The delivery shell scripts under .claude/scripts — the preflight, the tree
// fingerprint, the review artifact and the export of origin's main branch —
// exercised against throwaway repositories in a temporary directory. Nothing
// here touches this repository, a remote or a database: each fixture is a
// fresh `git init` plus a bare repo standing in for origin, so even the
// preflight fetch stays local. The main branch the scripts read from
// `.claude/flow.json` comes from a fixture file named by FLOW_CONFIG.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const scripts = join(process.cwd(), '.claude', 'scripts');

// A flow.json for the fixtures, in a directory of its own, named by
// FLOW_CONFIG for every script run, so that the kit's own file never decides
// a result. `mainBranch` is the only value these scripts read.
const flowDir = mkdtempSync(join(tmpdir(), 'flow-delivery-config-'));
process.on('exit', () => rmSync(flowDir, { recursive: true, force: true }));
let flowConfigs = 0;
function flowConfig(project = {}) {
  flowConfigs += 1;
  const path = join(flowDir, `flow-${flowConfigs}.json`);
  writeFileSync(
    path,
    JSON.stringify({ project: { name: 'Fixture', repo: 'owner/fixture-repo', ...project } }),
  );
  return path;
}
const FLOW = flowConfig();

const run = (command, args, cwd, env = {}) =>
  spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', FLOW_CONFIG: FLOW, ...env },
  });

const git = (cwd, ...args) => {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const sh = (script, args, cwd, env) => run('sh', [join(scripts, script), ...args], cwd, env);

// A `git` earlier on PATH that fails the given `git worktree list` form and
// forwards everything else to the real one. Used to reach the script's guards
// on a listing that does not answer.
function gitShim(t, { porcelainOnly = false } = {}) {
  const real = run('sh', ['-c', 'command -v git'], process.cwd()).stdout.trim();
  assert.ok(real, 'no git on PATH');
  const dir = mkdtempSync(join(tmpdir(), 'flow-git-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const match = porcelainOnly
    ? 'if [ "$1" = worktree ] && [ "$2" = list ] && [ "$3" = --porcelain ]; then exit 3; fi'
    : 'if [ "$1" = worktree ] && [ "$2" = list ]; then exit 3; fi';
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${match}\nexec ${real} "$@"\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH}` };
}

// The definitions the preflight requires of a base: the four roles, and the
// tester's two definitions of D21.
const TEAM = ['architect', 'developer', 'reviewer', 'tester', 'tester-look', 'tester-process'];

// A repository with `origin` pointing at a local bare clone, an agent team on
// the base branch and one commit on a task branch.
function fixture(t, { agents = TEAM, branch = 'main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  const origin = join(root, 'origin.git');

  mkdirSync(work);
  git(work, 'init', '--quiet', `--initial-branch=${branch}`);
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  mkdirSync(join(work, '.claude', 'agents'), { recursive: true });
  for (const agent of agents) {
    writeFileSync(join(work, '.claude', 'agents', `${agent}.md`), `# ${agent}\n`);
  }
  writeFileSync(join(work, 'README.md'), 'fixture\n');
  writeFileSync(join(work, '.gitignore'), 'node_modules/\n.claude/worktrees/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');

  run('git', ['init', '--bare', '--quiet', `--initial-branch=${branch}`, origin], root);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', 'origin', branch);
  git(work, 'fetch', '--quiet', 'origin');

  return { root, work, origin, base: git(work, 'rev-parse', `origin/${branch}`) };
}

// Call site 1: on main, before the branch exists. Refusing here would make the
// documented order impossible and leave the base checked only after the branch
// had been cut from it.
test('preflight on main prepares the branch instead of refusing', (t) => {
  const { work, base } = fixture(t);
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`BASE_SHA=${base} \\(origin/main; record this value`));
  // The suggested path is outside the repository: an ignored path inside it is
  // what `git clean -xdf` from any session sharing the checkout deletes (D3).
  // Asserted as that property and not as the shape of the path, because
  // `<repo>/role-worktrees/<task-branch>` has the shape and is inside.
  const suggested = new RegExp(`git worktree add -b <task-branch> (\\S+) ${base}`).exec(
    result.stdout,
  );
  assert.ok(suggested, `no worktree add command in: ${result.stdout}`);
  const root = git(work, 'rev-parse', '--show-toplevel');
  assert.ok(isAbsolute(suggested[1]), `suggested path is relative: ${suggested[1]}`);
  assert.ok(
    suggested[1] !== root && !suggested[1].startsWith(`${root}/`),
    `suggested path is inside the repository ${root}: ${suggested[1]}`,
  );
  assert.doesNotMatch(result.stdout, /Sequence: developer implements/);
});

test('preflight on main still refuses a base without the agent definitions', (t) => {
  const { work } = fixture(t, { agents: ['architect', 'developer'] });
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /is missing: reviewer\.md tester\.md tester-look\.md tester-process\.md\n/,
  );
});

test('preflight refuses a base that does not carry the agent definitions', (t) => {
  const { work } = fixture(t, { agents: ['architect', 'developer'] });
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /is missing: reviewer\.md tester\.md tester-look\.md tester-process\.md\n/,
  );
});

// A base with the four roles and without the tester's two definitions of
// D21 is refused too, on main and from a branch, naming the two.
test('preflight refuses a base without tester-look and tester-process', (t) => {
  const { work } = fixture(t, { agents: ['architect', 'developer', 'reviewer', 'tester'] });
  const onMain = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(onMain.status, 1, onMain.stdout);
  assert.match(onMain.stderr, /is missing: tester-look\.md tester-process\.md\n/);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /is missing: tester-look\.md tester-process\.md\n/);
});

// Call site 2: from the task branch.
test('preflight on a task branch prints BASE_SHA and the sequence', (t) => {
  const { work, base } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`BASE_SHA=${base} \\(the commit chore/task was cut from`));
  assert.match(result.stdout, /branch=chore\/task/);
  assert.doesNotMatch(result.stdout, /has advanced/);
  assert.match(result.stdout, /Sequence: developer implements/);
});

test('preflight refuses a branch that was not cut from the recorded base', (t) => {
  const { work, base } = fixture(t);
  // An unrelated history: a valid base ref that is not this branch's base.
  git(work, 'checkout', '--quiet', '--orphan', 'chore/elsewhere');
  writeFileSync(join(work, 'README.md'), 'unrelated\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'unrelated root');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(`chore/elsewhere shares no history with origin/main \\(${base}\\)`),
  );
  assert.doesNotMatch(result.stderr, /ancestor/);
});

// The condition that used to be reported as a wrong base is, far more often,
// a correct branch and a base ref that moved while the task was in flight.
test('preflight accepts a correct branch whose base ref has moved on', (t) => {
  const { work, base } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  writeFileSync(join(work, 'task.txt'), 'task work\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'task commit');

  // main advances and is pushed, as another delivery would do.
  git(work, 'switch', '--quiet', 'main');
  writeFileSync(join(work, 'other.txt'), 'someone else\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'unrelated delivery');
  git(work, 'push', '--quiet', 'origin', 'main');
  const moved = git(work, 'rev-parse', 'main');
  git(work, 'switch', '--quiet', 'chore/task');

  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  // The pinned value is the branch's own base, not the ref's new tip.
  assert.match(result.stdout, new RegExp(`BASE_SHA=${base} \\(the commit chore/task was cut from`));
  assert.doesNotMatch(result.stdout, new RegExp(`BASE_SHA=${moved}`));
  assert.match(result.stdout, new RegExp(`origin/main has advanced to ${moved}`));
  assert.match(result.stdout, /integrate it into the branch/);
  // The integration is checked as step 4 says of merging main in, not
  // revalidated whole, and BASE_SHA is the base of a whole-change review
  // only until then (D19).
  assert.match(result.stdout, /the integration checked as docs\/DELIVERY\.md step 4 says/);
  assert.match(
    result.stdout,
    /a review of the\nnote: whole change are taken against it until main is integrated/,
  );
  assert.doesNotMatch(result.stdout, /revalidate/);
});

// The merge base and the ref tip are the same commit in every other fixture,
// so nothing there distinguishes checking the definitions at one from the
// other. This is the case the second call site exists for: the branch was cut
// before the team was committed, so it has no team in its tree, while the ref
// tip that call site 1 would check does.
test('preflight checks the definitions at the merge base, not at the ref tip', (t) => {
  const { work } = fixture(t, { agents: [] });
  git(work, 'switch', '--quiet', '--create', 'task/cut-early');
  const cutFrom = git(work, 'rev-parse', 'HEAD');

  git(work, 'switch', '--quiet', 'main');
  mkdirSync(join(work, '.claude', 'agents'), { recursive: true });
  for (const agent of TEAM) {
    writeFileSync(join(work, '.claude', 'agents', `${agent}.md`), `# ${agent}\n`);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'add the agent team');
  git(work, 'push', '--quiet', 'origin', 'main');

  // Call site 1 is satisfied: the ref tip carries the team.
  const onMain = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(onMain.status, 0, onMain.stderr);

  // Call site 2 is not: this branch's own base does not.
  git(work, 'switch', '--quiet', 'task/cut-early');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    new RegExp(
      `${cutFrom} \\(task/cut-early's base\\) is missing:` +
        ' architect\\.md developer\\.md reviewer\\.md tester\\.md tester-look\\.md tester-process\\.md',
    ),
  );
});

test('preflight refuses a detached HEAD, which is neither call site', (t) => {
  const { work } = fixture(t);
  git(work, 'checkout', '--quiet', '--detach');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HEAD is detached/);
});

test('preflight accepts a fully qualified base ref', (t) => {
  const { work, base } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const result = sh('delivery-preflight.sh', ['refs/remotes/origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`BASE_SHA=${base}`));
});

test('preflight reports an unreachable origin instead of passing offline', (t) => {
  const { work, root } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  rmSync(join(root, 'origin.git'), { recursive: true, force: true });
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not fetch origin/);
});

// Worktrees are reported, never pruned (D3). Pruning cannot distinguish the
// wreckage of your own crashed run from a tree another session was using until
// something deleted it, so it destroys the only evidence that the second
// happened — which is how the incident behind D3 stayed invisible.
test('preflight reports a stale worktree entry and does not prune it', (t) => {
  const { work, root } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  // realpath, because git reports the resolved path and the macOS temporary
  // directory is reached through a symlink.
  const gone = join(realpathSync(root), 'gone');
  git(work, 'worktree', 'add', '--quiet', '--detach', gone);
  rmSync(gone, { recursive: true, force: true });

  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worktree entries whose directory is gone: 1/);
  assert.match(result.stdout, new RegExp(`note: {3}${gone}`));
  assert.match(result.stdout, /this script does not prune them/);
  assert.match(result.stdout, /git worktree prune/);

  // The administrative entry survived the run: the evidence is still there.
  assert.match(git(work, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${gone}`));
});

test('a stale worktree entry does not change the preflight exit status', (t) => {
  const { work, root } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const clean = sh('delivery-preflight.sh', ['origin/main'], work);

  const gone = join(root, 'gone');
  git(work, 'worktree', 'add', '--quiet', '--detach', gone);
  rmSync(gone, { recursive: true, force: true });
  const stale = sh('delivery-preflight.sh', ['origin/main'], work);

  assert.equal(stale.status, clean.status, stale.stderr);
  assert.equal(stale.status, 0, stale.stderr);
  // And a failing condition still fails with one present.
  git(work, 'checkout', '--quiet', '--detach');
  assert.equal(sh('delivery-preflight.sh', ['origin/main'], work).status, 1);
});

// Several tasks are developed side by side, each in a worktree of its own
// (D16): a worktree this run did not create belongs to another task in the
// delivery queue or to an attended session, and is left alone. One delivery at a
// time is the delivery lock's to hold, so the note no longer says a second
// one may not start, which every fire would read as its stop condition.
const PREFLIGHT_FOREIGN = [
  'another session may be working in them right now.',
  'They belong to other tasks in the delivery queue or to an attended session, which node .claude/scripts/delivery-queue.mjs status says.',
  'Leave them alone: do not remove or clean them.',
  'One delivery to this environment at a time is held by the delivery lock.',
];
// The `note:` lines of the preflight's output, joined into the prose they
// wrap.
const notes = (stdout) =>
  stdout
    .split('\n')
    .filter((line) => line.startsWith('note: '))
    .map((line) => line.slice('note: '.length).trim())
    .join(' ');

test('preflight names worktrees this run did not create', (t) => {
  const { work, root } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  // At the documented location, which is a string-prefix neighbour of the
  // repository root: `<repo>-worktrees/<branch>` starts with `<repo>`.
  const other = join(realpathSync(root), 'work-worktrees', 'other-task');
  git(work, 'worktree', 'add', '--quiet', '--detach', other);

  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worktrees this run did not create: 1/);
  assert.match(result.stdout, new RegExp(`note: {3}${other}`));
  assert.match(result.stdout, /another session may be working in them/);
  for (const sentence of PREFLIGHT_FOREIGN) {
    assert.ok(notes(result.stdout).includes(sentence), `the note no longer says "${sentence}"`);
  }
  for (const old of [
    'allows one delivery to this environment at a time',
    'do not start a second one',
  ]) {
    assert.ok(!notes(result.stdout).includes(old), `the note still says "${old}"`);
    assert.ok(
      !readFileSync(join(scripts, 'delivery-preflight.sh'), 'utf8')
        .replace(/\s+/g, ' ')
        .includes(old),
      `delivery-preflight.sh still says "${old}"`,
    );
  }
  // And it is a neighbour, not an inhabitant: the in-repository test is a
  // prefix match on `<main worktree>/`, and losing that slash would condemn
  // every worktree the script itself recommends.
  assert.doesNotMatch(result.stdout, /worktrees inside the repository/);

  // The main checkout this run was called from is not one of them.
  assert.doesNotMatch(result.stdout, new RegExp(`note: {3}${realpathSync(work)}$`, 'm'));
});

// The destructive condition behind D3, in the one place that can see it: the
// script already holds the main worktree's path and every worktree path.
test('preflight names a worktree inside the repository', (t) => {
  const { work } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const inRepo = join(realpathSync(work), '.claude', 'worktrees', 'tester');
  git(work, 'worktree', 'add', '--quiet', '--detach', inRepo);

  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worktrees inside the repository: 1/);
  assert.match(result.stdout, new RegExp(`note: {3}${inRepo}`));
  assert.match(result.stdout, /git clean -xdf run by any/);
  assert.match(result.stdout, /Move each one outside the repository/);
});

test('preflight without an in-repository worktree says nothing about one', (t) => {
  const { work } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const result = sh('delivery-preflight.sh', ['origin/main'], work);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /worktrees inside the repository/);
});

// `main_worktree` is read out of the listing, and an empty one would turn the
// suggested path into `./-worktrees/<task-branch>`: relative, inside the
// repository, ignored — the failure the suggestion exists to avoid.
test('preflight stops when git worktree list does not answer', (t) => {
  const { work } = fixture(t);
  const result = sh('delivery-preflight.sh', ['origin/main'], work, gitShim(t));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git worktree list failed or returned nothing/);
  assert.doesNotMatch(result.stdout, /git worktree add/);
});

test('preflight stops when the porcelain worktree listing does not answer', (t) => {
  const { work } = fixture(t);
  const result = sh(
    'delivery-preflight.sh',
    ['origin/main'],
    work,
    gitShim(t, { porcelainOnly: true }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git worktree list --porcelain failed or returned/);
  assert.doesNotMatch(result.stdout, /git worktree add/);
});

test('the fingerprint is stable, moves with a tracked change and ignores ignored paths', (t) => {
  const { work } = fixture(t);
  const fingerprint = () => {
    const result = sh('tree-fingerprint.sh', [work], work);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  const before = fingerprint();
  assert.match(before, /^[0-9a-f]{40} [0-9a-f]{40}$/);
  assert.equal(fingerprint(), before, 'an unchanged tree keeps its fingerprint');

  // An ignored path: what `npm ci` and a worktree of this run look like. Both
  // carry files, because `git status --porcelain -uall` never reports an empty
  // directory and an empty one would pass with or without the ignore rule.
  mkdirSync(join(work, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(work, 'node_modules', 'left-pad', 'index.js'), 'export default 1;\n');
  const worktree = join(work, '.claude', 'worktrees', 'tester');
  git(work, 'worktree', 'add', '--quiet', '--detach', worktree);
  assert.ok(existsSync(join(worktree, 'README.md')), 'the nested worktree has real files');
  assert.equal(fingerprint(), before, 'ignored paths stay out of the fingerprint');
  git(work, 'worktree', 'remove', worktree);

  writeFileSync(join(work, 'README.md'), 'edited by something that should not have\n');
  const edited = fingerprint();
  assert.notEqual(edited, before, 'a tracked edit moves the fingerprint');

  // An untracked file that is not ignored counts too: a stray report dropped
  // into the tree is still a write.
  writeFileSync(join(work, 'notes.txt'), 'stray\n');
  assert.notEqual(fingerprint(), edited);

  // Committing changes HEAD, which is the other half of the fingerprint.
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'edit');
  const committed = fingerprint();
  assert.notEqual(committed.split(' ')[0], before.split(' ')[0]);
  assert.equal(committed.split(' ')[1], before.split(' ')[1], 'a clean tree hashes alike');
});

test('a symlinked node_modules is visible to the fingerprint, a real one is not', (t) => {
  // Why worktrees never share node_modules through a symlink: `node_modules/`
  // in .gitignore matches a directory, and git does not treat a symlink as one,
  // so the symlink is an untracked path that moves the fingerprint and can be
  // committed by accident. The rule in docs/DELIVERY.md rests on this.
  const { work } = fixture(t);
  const fingerprint = () => sh('tree-fingerprint.sh', [work], work).stdout.trim();

  const before = fingerprint();
  mkdirSync(join(work, 'node_modules'));
  assert.equal(fingerprint(), before, 'a real node_modules directory is ignored');

  rmSync(join(work, 'node_modules'), { recursive: true });
  mkdirSync(join(work, 'shared-modules'));
  symlinkSync(join(work, 'shared-modules'), join(work, 'node_modules'));
  assert.notEqual(fingerprint(), before, 'a symlinked node_modules is not ignored');
});

test('the fingerprint rejects a path that is not a worktree', (t) => {
  const { root } = fixture(t);
  assert.equal(sh('tree-fingerprint.sh', [], root).status, 2);
  assert.equal(sh('tree-fingerprint.sh', [join(root, 'nowhere')], root).status, 2);
  assert.equal(sh('tree-fingerprint.sh', [root], root).status, 2);
});

test('the review artifact header carries the base, head and fingerprint it was built from', (t) => {
  const { work, base } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  writeFileSync(join(work, 'README.md'), 'changed by the developer\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'change');
  const head = git(work, 'rev-parse', 'HEAD');

  const fingerprint = sh('tree-fingerprint.sh', [work], work).stdout.trim();
  const out = join(work, '..', 'review.diff');
  const result = sh('review-artifact.sh', [base, 'HEAD', out], work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`base=${base} head=${head}`));

  const artifact = run('cat', [out], work).stdout;
  const header = artifact.split('\n').filter((line) => line.startsWith('#'));
  // The first line is what outside-review.mjs checks before anything else.
  assert.equal(header[0], '# Review artifact', artifact);
  assert.ok(header.includes(`# base: ${base} ${base}`), artifact);
  assert.ok(header.includes(`# head: HEAD ${head}`), artifact);
  assert.ok(header.includes(`# tree-fingerprint: ${fingerprint}`), artifact);
  assert.ok(
    header.some((line) => /^# generated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(line)),
  );
  assert.match(artifact, /\+changed by the developer/);
  assert.match(artifact, /-fixture/);
});

test('the review artifact refuses to run in a tree that is not at the head', (t) => {
  const { work, base } = fixture(t);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  writeFileSync(join(work, 'README.md'), 'changed by the developer\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'change');
  const head = git(work, 'rev-parse', 'HEAD');

  // The main checkout's situation: sitting on another commit, possibly with
  // unrelated local changes, being asked for a diff of the task branch.
  git(work, 'switch', '--quiet', 'main');
  const out = join(work, '..', 'review.diff');
  const result = sh('review-artifact.sh', [base, head, out], work);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`is at ${base}, not at ${head}`));
  assert.equal(existsSync(out), false, 'no artifact describing the wrong tree');
});

test('the review artifact refuses a ref that does not exist', (t) => {
  const { work, base } = fixture(t);
  const result = sh('review-artifact.sh', [base, 'refs/heads/absent', join(work, 'x.diff')], work);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ref not found: refs\/heads\/absent/);
  assert.equal(sh('review-artifact.sh', [base], work).status, 2);
});

// ---------------------------------------------------------------------------
// The export of origin's main branch for the scheduled grooming,
// `.claude/scripts/export-origin-main.sh` (D14). Its one allow rule grants the
// script and no `git archive` or `tar`, so the script's own checks are what
// keep a session to exporting into a scratchpad: one directory that resolves
// under /private/tmp/claude- (macOS) or /tmp/claude- (Linux). The directories
// it may write to are made under the one this system's temporary directory
// resolves to; where none can be, these tests are skipped, except in CI.

const exportScript = (args, cwd, env) => sh('export-origin-main.sh', args, cwd, env);
const TMP = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
const NOT_UNDER = 'not under /private/tmp/claude-\\* or /tmp/claude-\\*: ';

function scratchpad(t, prefix = 'claude-flow-export-test-') {
  try {
    const dir = mkdtempSync(`${TMP}/${prefix}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return realpathSync(dir);
  } catch (error) {
    if (process.env.CI) throw error;
    t.skip(`no directory under ${TMP}/claude-* can be made here: ${error.code}`);
    return null;
  }
}

// A command earlier on PATH that exits 3 when its first argument is `when`
// (or always, for `when` undefined), and runs the real one otherwise. The tar
// stand-in first leaves a half-written tree where the export goes.
function failingCommand(t, name, { when, partial = false } = {}) {
  const real = run('sh', ['-c', `command -v ${name}`], process.cwd()).stdout.trim();
  assert.ok(real, `no ${name} on PATH`);
  const dir = mkdtempSync(join(tmpdir(), `flow-${name}-shim-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const leave = partial ? 'mkdir -p "$5/origin-main" && echo half > "$5/origin-main/half"\n' : '';
  const body =
    when === undefined
      ? `${leave}exit 3\n`
      : `if [ "$1" = ${when} ]; then exit 3; fi\nexec ${real} "$@"\n`;
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH}` };
}

const oneLine = (result) => {
  assert.equal(result.stdout, '', 'a refusal or failure prints nothing on stdout');
  const lines = result.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, `not one line: ${result.stderr}`);
  assert.match(lines[0], /^export-origin-main: \S/);
  return lines[0];
};

test('the export refuses anything but one directory that resolves under /private/tmp/claude- or /tmp/claude-, writing nothing', (t) => {
  const inside = scratchpad(t);
  if (inside === null) return;
  const { root, work } = fixture(t);
  const outside = realpathSync(mkdtempSync(join(root, 'outside-')));
  assert.ok(
    !outside.startsWith('/private/tmp/claude-') && !outside.startsWith('/tmp/claude-'),
    `the outside directory is not: ${outside}`,
  );
  symlinkSync(outside, join(inside, 'link'));
  // Directly under the temporary directory, but not named `claude-…`: one
  // with no `claude` at all, one with `claude` and no hyphen after it.
  const strangers = ['flow-export-test-', 'claudeflow-export-test-'].map((prefix) =>
    scratchpad(t, prefix),
  );

  const refusals = [
    [[], /takes exactly one argument.*got 0$/],
    [[inside, inside], /takes exactly one argument.*got 2$/],
    [['relative/dir'], /not an absolute path: relative\/dir$/],
    [[join(inside, 'missing')], /no such directory: /],
    [[outside], new RegExp(NOT_UNDER)],
    // Starts with the prefix, climbs to the root and back down outside it.
    [[`${inside}/../../..${outside}`], new RegExp(`${NOT_UNDER}.* resolves to `)],
    [[join(inside, 'link')], new RegExp(`${NOT_UNDER}.* resolves to `)],
    [[`${inside}/..`], new RegExp(`${NOT_UNDER}.* resolves to ${TMP}$`)],
    ...strangers.map((dir) => [[dir], new RegExp(`${NOT_UNDER}.* resolves to ${dir}$`)]),
  ];
  for (const [args, reason] of refusals) {
    const result = exportScript(args, work);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(oneLine(result), reason, args.join(' '));
  }
  assert.deepEqual(readdirSync(outside), [], 'something was written outside');
  assert.deepEqual(readdirSync(inside), ['link'], 'something was written inside');
  for (const dir of strangers) {
    assert.deepEqual(readdirSync(dir), [], `something was written in ${dir}`);
  }
});

test('the export writes the tree of origin/main, not the checkout or HEAD, prints its SHA and never writes over one', (t) => {
  const inside = scratchpad(t);
  if (inside === null) return;
  const { work } = fixture(t);
  mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'docs', 'guide.md'), 'pushed\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'pushed');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'fetch', '--quiet', 'origin');
  const sha = git(work, 'rev-parse', 'origin/main');
  // HEAD moves past origin/main, and the checkout differs from both.
  writeFileSync(join(work, 'local-only.txt'), 'not pushed\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'local only');
  writeFileSync(join(work, 'README.md'), 'edited, not committed\n');

  // Run from a subdirectory: the whole tree is exported all the same.
  const result = exportScript([inside], join(work, 'docs'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${sha}\n`);
  assert.equal(result.stderr, '');
  const tree = join(inside, 'origin-main');
  assert.equal(readFileSync(join(tree, 'README.md'), 'utf8'), 'fixture\n');
  assert.equal(readFileSync(join(tree, 'docs', 'guide.md'), 'utf8'), 'pushed\n');
  assert.ok(existsSync(join(tree, '.claude', 'agents', 'tester.md')));
  assert.equal(existsSync(join(tree, 'local-only.txt')), false, 'HEAD was exported');
  assert.deepEqual(readdirSync(inside), ['origin-main'], 'the archive was left beside it');

  // Again, through a path that resolves to the same directory: refused.
  writeFileSync(join(work, 'docs', 'guide.md'), 'changed\n');
  const again = exportScript([`${inside}/origin-main/..`], work);
  assert.equal(again.status, 2);
  assert.match(oneLine(again), /already exists: .*\/origin-main$/);
  assert.equal(readFileSync(join(tree, 'docs', 'guide.md'), 'utf8'), 'pushed\n');
});

// A local branch named `origin/main`, refs/heads/origin/main, comes before the
// remote-tracking ref when a bare `origin/main` is resolved; the export names
// refs/remotes/origin/main in full.
test('the export takes the remote-tracking origin/main, not a local branch of that name', (t) => {
  const inside = scratchpad(t);
  if (inside === null) return;
  const { work, base } = fixture(t);
  writeFileSync(join(work, 'local-only.txt'), 'not pushed\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'local only');
  git(work, 'branch', 'origin/main', 'HEAD');
  assert.notEqual(git(work, 'rev-parse', 'origin/main'), base, 'the branch shadows nothing');

  const result = exportScript([inside], work);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${base}\n`);
  assert.equal(result.stderr, '');
  const tree = join(inside, 'origin-main');
  assert.equal(readFileSync(join(tree, 'README.md'), 'utf8'), 'fixture\n');
  assert.equal(existsSync(join(tree, 'local-only.txt')), false, 'the local branch was exported');
});

test('the export fails with exit 1 and leaves nothing when origin/main is missing or git archive or tar fails', (t) => {
  const inside = scratchpad(t);
  if (inside === null) return;
  const { root, work } = fixture(t);
  const target = (name) => {
    const dir = join(inside, name);
    mkdirSync(dir);
    return dir;
  };

  const lonely = join(root, 'lonely');
  mkdirSync(lonely);
  git(lonely, 'init', '--quiet', '--initial-branch=main');
  git(
    lonely,
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'user.name=T',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'x',
  );
  const cases = [
    ['no-origin', lonely, {}, /no origin\/main here; fetch it first$/],
    ['archive', work, failingCommand(t, 'git', { when: 'archive' }), /git archive failed$/],
    ['tar', work, failingCommand(t, 'tar', { partial: true }), /tar failed$/],
  ];
  for (const [name, cwd, env, reason] of cases) {
    const dir = target(name);
    const result = exportScript([dir], cwd, env);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(oneLine(result), reason, name);
    assert.deepEqual(readdirSync(dir), [], `${name} left something behind`);
  }
});

// ---------------------------------------------------------------------------
// The main branch, `project.mainBranch` in `.claude/flow.json` (D23)
// ---------------------------------------------------------------------------
//
// The preflight and the export read the main branch from the configuration,
// through flow-config.mjs; a file that cannot be read leaves them on `main`,
// and a value that is no branch name is refused before anything is fetched or
// written.

test('preflight takes the main branch and its default base from .claude/flow.json', (t) => {
  const { work, base } = fixture(t, { branch: 'trunk' });
  const env = { FLOW_CONFIG: flowConfig({ mainBranch: 'trunk' }) };
  const onTrunk = sh('delivery-preflight.sh', [], work, env);
  assert.equal(onTrunk.status, 0, onTrunk.stderr);
  assert.match(onTrunk.stdout, new RegExp(`BASE_SHA=${base} \\(origin/trunk; record this value`));
  assert.match(onTrunk.stdout, /on trunk: no task branch yet/);
  assert.match(onTrunk.stdout, new RegExp(`git worktree add -b <task-branch> \\S+ ${base}`));

  git(work, 'switch', '--quiet', '--create', 'chore/task');
  const onBranch = sh('delivery-preflight.sh', [], work, env);
  assert.equal(onBranch.status, 0, onBranch.stderr);
  assert.match(
    onBranch.stdout,
    new RegExp(`BASE_SHA=${base} \\(the commit chore/task was cut from`),
  );
  assert.match(onBranch.stdout, /Sequence: developer implements/);

  // With the default configuration the same repository has no origin/main.
  const byDefault = sh('delivery-preflight.sh', [], work);
  assert.equal(byDefault.status, 2, byDefault.stdout);
  assert.match(byDefault.stderr, /base ref not found: origin\/main\n$/);
});

test('preflight falls back to main when .claude/flow.json cannot be read, and refuses a main branch that is no branch name', (t) => {
  const { work, base } = fixture(t);
  for (const config of [join(flowDir, 'absent.json'), flowConfig({ mainBranch: '' })]) {
    const result = sh('delivery-preflight.sh', [], work, { FLOW_CONFIG: config });
    assert.equal(result.status, 0, `${config}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`BASE_SHA=${base} \\(origin/main; record this value`));
  }
  const notJson = join(flowDir, 'not-json.json');
  writeFileSync(notJson, '{');
  assert.equal(sh('delivery-preflight.sh', [], work, { FLOW_CONFIG: notJson }).status, 0);

  for (const name of ['two words', 'a..b', '-x', 'main\nother']) {
    const result = sh('delivery-preflight.sh', [], work, {
      FLOW_CONFIG: flowConfig({ mainBranch: name }),
    });
    assert.equal(result.status, 2, `${JSON.stringify(name)}: ${result.stdout}`);
    assert.match(result.stderr, /project\.mainBranch in \.claude\/flow\.json is not a branch name/);
    assert.equal(result.stdout, '', JSON.stringify(name));
  }
});

test('the export takes origin/<main branch> from .claude/flow.json', (t) => {
  const inside = scratchpad(t);
  if (inside === null) return;
  const { work, base } = fixture(t, { branch: 'trunk' });
  const env = { FLOW_CONFIG: flowConfig({ mainBranch: 'trunk' }) };
  const result = exportScript([inside], work, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${base}\n`);
  assert.equal(readFileSync(join(inside, 'origin-main', 'README.md'), 'utf8'), 'fixture\n');

  // With the default configuration there is no origin/main to export.
  const fresh = scratchpad(t);
  const missing = exportScript([fresh], work);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(oneLine(missing), /no origin\/main here; fetch it first$/);
  assert.deepEqual(readdirSync(fresh), [], 'something was left behind');

  const refused = exportScript([fresh], work, {
    FLOW_CONFIG: flowConfig({ mainBranch: 'a..b' }),
  });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(
    oneLine(refused),
    /project\.mainBranch in \.claude\/flow\.json is not a branch name: a\.\.b$/,
  );
  assert.deepEqual(readdirSync(fresh), [], 'something was written');
});
