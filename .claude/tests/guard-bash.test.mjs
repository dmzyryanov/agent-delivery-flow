// The Bash guard, `.claude/scripts/guard-bash.mjs`, exercised against
// throwaway repositories in a temporary directory. Nothing here touches this
// repository, a remote or GitHub: each fixture is a fresh `git init`. The
// guard is run as the hook runs it, with JSON on stdin; none of the commands
// it is given is ever executed — the only processes started are the guard
// and, by it, `git` asking a fixture for its branch.
//
//   node --test .claude/tests/guard-bash.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const scripts = join(process.cwd(), '.claude', 'scripts');

const run = (command, args, cwd, env = {}) =>
  spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env },
  });

const git = (cwd, ...args) => {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// A PreToolUse hook: Claude Code runs it before every Bash call, with the call
// as JSON on stdin, and exit 2 refuses the call with the one line on stderr.
// It is run here the same way.

const GUARD = join(scripts, 'guard-bash.mjs');

// The hook's own time limit, which `.claude/settings.json` gives in seconds. A
// hook that runs past it does not block, so the guard has to answer inside it.
// Without the file, or without the entry, the limit is the 10 s the guard is
// built for.
let hookTimeout;
try {
  hookTimeout = JSON.parse(readFileSync(join(process.cwd(), '.claude', 'settings.json'), 'utf8'))
    .hooks?.PreToolUse?.[0]?.hooks?.[0]?.timeout;
} catch {
  hookTimeout = undefined;
}
const HOOK_TIMEOUT_MS = (Number.isFinite(hookTimeout) ? hookTimeout : 10) * 1000;

// `project` is the directory Claude Code names to a hook as the project's, in
// `CLAUDE_PROJECT_DIR`; without one the variable is unset, whatever this test
// run inherited. `script` is the guard's file, a copy of it in some tests.
// `flow` is the flow configuration the guard reads its main branch from, in
// `FLOW_CONFIG`; without one the variable is unset and the guard reads the
// configuration beside its own file.
const runGuard = (stdin, project, script = GUARD, flow = null) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.FLOW_CONFIG;
  if (project) env.CLAUDE_PROJECT_DIR = project;
  if (flow) env.FLOW_CONFIG = flow;
  return spawnSync(process.execPath, [script], {
    // Neither a repository nor a fixture: the guard reads the directory from
    // its input, never from where it was started.
    cwd: tmpdir(),
    input: stdin,
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
    env,
  });
};

// One Bash call as the hook receives it, in a session whose project is
// `project`: in the main session, or inside the sub-agent `agent`, whose input
// carries `agent_id` and `agent_type`. An object for `agent` gives the fields
// as they are: `{ agent_type: 'developer' }` is a main session started with
// `claude --agent developer`, which carries no `agent_id`.
const guardFor = (project, script, flow) => (command, cwd, agent) =>
  runGuard(
    JSON.stringify({
      session_id: '00000000-0000-4000-8000-000000000000',
      hook_event_name: 'PreToolUse',
      permission_mode: 'auto',
      cwd,
      tool_name: 'Bash',
      tool_input: { command, description: 'a made-up call' },
      ...(typeof agent === 'object' && agent !== null
        ? agent
        : agent
          ? { agent_id: 'made-up', agent_type: agent }
          : {}),
    }),
    project,
    script,
    flow,
  );

// Where the project does not matter: every rule but those about a commit or
// a push.
const guard = guardFor(null);

const brief = (text) => (text.length > 160 ? `${text.slice(0, 160)}… (${text.length})` : text);

// Exit 2, nothing on stdout, and on stderr exactly one line: the guard's name,
// the rule, the alternative, and where the refusal comes from.
function refused(result, rule, label) {
  assert.equal(result.status, 2, `${brief(label)}: exit ${result.status}, ${brief(result.stderr)}`);
  assert.equal(result.stdout, '', brief(label));
  assert.match(
    result.stderr,
    /^guard-bash refused this command: [^\n]+ \[PreToolUse hook \.claude\/scripts\/guard-bash\.mjs, DK?\d+\]\n$/,
    `${brief(label)}: not the guard's one line`,
  );
  assert.match(result.stderr, rule, brief(label));
}

// Exit 0 and silence: the call goes on to the permission system.
function passed(result, label) {
  assert.equal(result.status, 0, `${brief(label)}: exit ${result.status}, ${brief(result.stderr)}`);
  assert.equal(result.stdout, '', brief(label));
  assert.equal(result.stderr, '', brief(label));
}

// Exit 0 with a note that reaches only the debug log: the guard could not
// read its input to the end and says why instead of guessing. The reason is
// asserted, so that a guard which fails on an error of its own — which also
// exits 0 with a note — does not pass for one that read the input and stopped.
const NOT_JSON = /its input is not JSON/;
const NOT_READ = new RegExp(
  [
    'a quote is never closed',
    'a quote or a parenthesis is never closed',
    'an arithmetic expansion is never closed',
    'a parameter expansion is never closed',
    'a here-document has no delimiter',
    'backticks are nested',
    'arithmetic the guard cannot tell from subshells',
  ].join('|'),
);
function unchecked(result, label, reason = NOT_READ) {
  assert.equal(result.status, 0, `${brief(label)}: exit ${result.status}, ${brief(result.stderr)}`);
  assert.equal(result.stdout, '', brief(label));
  assert.match(result.stderr, /^guard-bash did not check this command: [^\n]+\n$/, brief(label));
  assert.match(result.stderr, reason, `${brief(label)}: ${brief(result.stderr)}`);
}

const ON_MAIN = /`git commit` on `main` .*Commit on a task branch instead/;
const LINKED =
  /`git commit` while `[^`]+` is a symlink\. .*install `node_modules` in this worktree/;
const SWEEP = /`lsof` fed into `kill`, a sweep by port\. Stop what you started by its recorded PID/;
const PKILL = /`pkill`, a kill by pattern\. Stop what you started by its recorded PID .*`TaskStop`/;
const KILLALL =
  /`killall`, a kill by name\. Stop what you started by its recorded PID .*`TaskStop`/;
const lsofInside = (agent) =>
  new RegExp(`\`lsof\` inside the \`${agent}\` sub-agent\\. Stop what you started by its`);


// A repository with one commit on `main` and no remote. The path is resolved,
// because git reports the resolved one and the macOS temporary directory is
// reached through a symlink. The commit tests make it the project, as the
// preflight tests make theirs the repository the script runs in.
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'README.md'), 'fixture\n');
  writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');
  return { root, work };
}

test('the guard refuses git commit where the branch is main', (t) => {
  const { root, work } = repository(t);
  const guard = guardFor(work);

  for (const command of [
    // The form the acceptance check uses: refused on its leading words.
    'git commit --dry-run',
    'git commit -m "a change"',
    'git add -A && git commit -m "a change"',
    'git -c user.name=Someone commit --amend --no-edit',
    'GIT_AUTHOR_NAME=Someone git commit -m x',
    'npm test; git commit -qm x',
    'git status\ngit commit -m x',
    '/usr/bin/git commit -m x',
    'if git diff --cached --quiet; then echo nothing; else git commit -m x; fi',
    '(git add -A && git commit -m x)',
  ]) {
    refused(guard(command, work), ON_MAIN, command);
    refused(guard(command, work, 'developer'), ON_MAIN, `developer: ${command}`);
  }

  // The directory is the one a preceding `cd` or `git -C` names, absolute or
  // relative, and not the session's: here that is not a repository at all.
  for (const command of [
    `cd ${work} && git commit --dry-run`,
    `cd '${work}'; git commit -m x`,
    `cd -- "${work}" && git add -A && git commit -m x`,
    `git -C ${work} commit -m x`,
    `git -C "${work}" -c user.name=Someone commit -m x`,
    'cd work && git commit -m x',
    'cd work\ngit commit -m x',
    'git -C work commit -m x',
    'git -C . -C work commit -m x',
    `cd /; cd ${root}; git -C work commit -m x`,
  ]) {
    refused(guard(command, root), ON_MAIN, command);
  }

  assert.ok(
    guard('git commit -m x', work).stderr.includes(`\`main\` (${work})`),
    'the refusal names the directory',
  );

  // A first commit on `main` is a commit on `main`.
  const unborn = join(root, 'unborn');
  mkdirSync(unborn);
  git(unborn, 'init', '--quiet', '--initial-branch=main');
  refused(guardFor(unborn)('git commit -m first', unborn), ON_MAIN, 'a first commit on main');
});

test('the guard lets a commit through where the branch is not main or cannot be told', (t) => {
  const { root, work } = repository(t);
  const guard = guardFor(work);

  // On `main`, what is not `git commit`.
  for (const command of [
    'git status',
    'git add -A',
    'git log --oneline --grep commit',
    'git show commit',
    'git commit-tree HEAD^{tree} -m x',
    'git config alias.ci commit',
    'echo git commit',
    'git-commit -m x',
    '$GIT commit -m x',
  ]) {
    passed(guard(command, work), command);
  }

  // A directory the guard cannot know. It does not fall back on the session's,
  // which here is on `main`: the session sits in the main checkout while a
  // commit is made in a worktree whose path a variable holds.
  for (const command of [
    'cd "$WORKTREE" && git commit -m x',
    'W=/somewhere; cd $W && git commit -m x',
    'git -C "$WORKTREE" commit -m x',
    'cd "$(git rev-parse --show-toplevel)/../task" && git commit -m x',
    'cd - && git commit -m x',
    'cd ~nobody && git commit -m x',
    'popd; git commit -m x',
    `git --git-dir=${work}/.git --work-tree=${root} commit -m x`,
    `git --git-dir ${work}/.git commit -m x`,
  ]) {
    passed(guard(command, work), command);
  }

  // Where git has no answer.
  passed(guard('git commit -m x', root), 'not a repository');
  passed(guard('git commit -m x', join(root, 'absent')), 'a directory that does not exist');
  passed(guard(`cd ${root}/absent && git commit -m x`, work), 'a cd to a missing directory');
  passed(
    guard(`mkdir ${root}/new && cd ${root}/new && git init -q && git commit -m x`, work),
    'a repository the command itself creates',
  );

  git(work, 'switch', '--quiet', '--create', 'chore/task');
  for (const command of [
    'git commit --dry-run',
    'git commit -m "a change"',
    'git add -A && git commit -m x',
    `cd ${work} && git commit -m x`,
  ]) {
    passed(guard(command, work), command);
    passed(guard(command, work, 'developer'), `developer: ${command}`);
  }

  git(work, 'checkout', '--quiet', '--detach');
  passed(guard('git commit -m x', work), 'a detached HEAD');
});

// The delivery's own layout: the main checkout stays on `main` while every
// commit is made in a task worktree beside it.
test('a commit from a task worktree passes while the main checkout sits on main', (t) => {
  const { root, work } = repository(t);
  const worktree = join(root, 'work-worktrees', 'chore', 'task');
  git(work, 'worktree', 'add', '--quiet', '-b', 'chore/task', worktree);
  mkdirSync(join(worktree, 'docs'));
  // The project directory is the main checkout, for a sub-agent's calls too.
  const guard = guardFor(work);

  // Run in the worktree, or in a directory under it.
  passed(guard('git commit -m x', worktree), 'in the task worktree');
  passed(guard('git add -A && git commit -m x', join(worktree, 'docs')), 'under the worktree');

  // Run from the main checkout and aimed at the worktree.
  for (const command of [
    `git -C ${worktree} commit -m x`,
    `git -C ${worktree} add -A && git -C ${worktree} commit -m x`,
    `cd ${worktree} && git commit -m x`,
    `cd ${worktree}; git add -A; git commit -m x`,
    `cd ${worktree}\ngit commit -m x`,
    `cd ${root} && cd work-worktrees/chore/task && git commit -m x`,
    `(cd ${worktree} && git commit -m x)`,
    `cd ${worktree} || exit 1; git commit -m x`,
  ]) {
    passed(guard(command, work), command);
  }

  // And the other way round: a worktree session aiming at the main checkout.
  for (const command of [
    `git -C ${work} commit -m x`,
    `cd ${work} && git commit -m x`,
    `cd ${worktree} && git status && cd ${work} && git commit -m x`,
    `git -C ${worktree} status; git -C ${work} commit -m x`,
  ]) {
    refused(guard(command, worktree), ON_MAIN, command);
  }

  // A `cd` inside a subshell, a substitution or a pipeline moves nothing
  // outside it.
  for (const command of [
    `(cd ${worktree} && git status); git commit -m x`,
    `echo "$(cd ${worktree} && git status)"; git commit -m x`,
    `cd ${worktree} | cat; git commit -m x`,
    `cd ${worktree} & git commit -m x`,
  ]) {
    refused(guard(command, work), ON_MAIN, command);
  }
  passed(guard(`(cd ${work} && git status); git commit -m x`, worktree), 'a subshell cd to main');
});

// Sessions build throwaway repositories by hand, on `main` like the fixtures
// here, to try a delivery script out. Those are not the project's `main`, and
// refusing a commit there would stall the session for nothing (D9).
test("the commit rules hold in the project's repository, not in a throwaway one", (t) => {
  const { root, work } = repository(t);
  const other = repository(t).work;
  const worktree = join(root, 'work-worktrees', 'task');
  git(work, 'worktree', 'add', '--quiet', '-b', 'chore/task', worktree);
  const guard = guardFor(work);

  // The other repository is on `main` and has a linked node_modules.
  mkdirSync(join(other, 'shared-modules'));
  symlinkSync(join(other, 'shared-modules'), join(other, 'node_modules'));
  for (const [command, cwd] of [
    ['git commit --dry-run', other],
    ['git add -A && git commit -m x', other],
    [`git -C ${other} commit -m x`, work],
    [`cd ${other} && git commit -m x`, work],
    [`cd ${other} && git commit -m x`, worktree],
  ]) {
    for (const agent of [undefined, 'developer', 'tester']) {
      passed(guard(command, cwd, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // The project's own `main` is refused from anywhere, the other repository
  // included.
  refused(guard('git commit -m x', work), ON_MAIN, 'in the project');
  refused(guard(`cd ${work} && git commit -m x`, other), ON_MAIN, 'from the other repository');
  refused(guard(`git -C ${other} status; git -C ${work} commit`, other), ON_MAIN, 'after it');

  // The project is the repository, whichever of its worktrees names it.
  refused(guardFor(worktree)('git commit -m x', work), ON_MAIN, 'named by a worktree');
  passed(guardFor(worktree)('git commit -m x', other), 'named by a worktree: the other one');
  passed(guardFor(other)('git commit -m x', work), 'the other repository as the project');
  refused(guardFor(other)('git commit -m x', other), ON_MAIN, 'the other repository, its own');

  // Without `CLAUDE_PROJECT_DIR`, or with one that is no repository, the
  // project is the repository that holds the guard's own file: here a copy of
  // it inside the fixture, where the real one sits in this checkout.
  const copy = join(work, '.claude', 'scripts', 'guard-bash.mjs');
  mkdirSync(join(work, '.claude', 'scripts'), { recursive: true });
  copyFileSync(GUARD, copy);
  for (const project of [null, root, join(root, 'absent'), 'relative/path']) {
    refused(guardFor(project, copy)('git commit -m x', work), ON_MAIN, `a copy, ${project}`);
    passed(guardFor(project, copy)('git commit -m x', other), `a copy, ${project}: the other`);
  }
  // The real file's repository is this checkout, which neither fixture is.
  passed(guardFor(null)('git commit -m x', work), 'the real guard, no project named');
  passed(guardFor(null)('git commit -m x', other), 'the real guard, no project named: the other');

  // Where no project repository can be told at all, the rule holds in any
  // repository.
  const loose = join(root, 'guard-bash.mjs');
  copyFileSync(GUARD, loose);
  refused(guardFor(null, loose)('git commit -m x', work), ON_MAIN, 'a guard outside a repository');
  refused(guardFor(root, loose)('git commit -m x', other), ON_MAIN, 'and no project repository');
  passed(guardFor(null, loose)('git commit -m x', worktree), 'still not on a task branch');
});

test('the guard refuses git commit while a node_modules of the worktree is a symlink', (t) => {
  const { root, work } = repository(t);
  const guard = guardFor(work);
  git(work, 'switch', '--quiet', '--create', 'chore/task');
  for (const directory of ['apps/web/src', 'packages/shared', 'shared-modules']) {
    mkdirSync(join(work, directory), { recursive: true });
  }

  const link = (path) => symlinkSync(join(work, 'shared-modules'), join(work, path));
  const unlink = (path) => rmSync(join(work, path), { recursive: true, force: true });

  for (const path of ['node_modules', 'apps/web/node_modules', 'packages/shared/node_modules']) {
    link(path);
    for (const [command, cwd] of [
      ['git commit -m x', work],
      ['git add -A && git commit -m x', join(work, 'apps', 'web', 'src')],
      [`git -C ${work} commit --dry-run`, root],
      [`cd ${work} && git commit -m x`, root],
    ]) {
      const result = guard(command, cwd);
      refused(result, LINKED, `${path}: ${command}`);
      assert.ok(result.stderr.includes(`\`${path}\` is a symlink`), `names ${path}`);
      assert.match(result.stderr, /`npm ci`/, 'names the install');
    }
    // Only a commit is refused; the link itself is not the guard's business.
    passed(guard('git status --short', work), `${path}: git status`);
    passed(guard('git add -A', work), `${path}: git add`);
    unlink(path);
    passed(guard('git commit -m x', work), `${path} removed`);
  }

  // Real directories, as `npm ci` leaves them — with a link inside, which is
  // how npm installs a workspace package.
  for (const path of ['node_modules', 'apps/web/node_modules', 'packages/shared/node_modules']) {
    mkdirSync(join(work, path));
  }
  mkdirSync(join(work, 'node_modules', '@fixture'));
  symlinkSync(join(work, 'packages', 'shared'), join(work, 'node_modules', '@fixture', 'shared'));
  passed(guard('git commit -m x', work), 'real node_modules directories');
  // A link of that name anywhere else is outside the rule.
  symlinkSync(join(work, 'shared-modules'), join(work, 'apps', 'web', 'src', 'node_modules'));
  passed(guard('git commit -m x', work), 'a link deeper than apps/*');

  // On `main` the branch is what the refusal names.
  git(work, 'switch', '--quiet', 'main');
  unlink('node_modules');
  link('node_modules');
  refused(guard('git commit -m x', work), ON_MAIN, 'main and a linked node_modules');
});

test('the guard refuses lsof fed into kill, in every session', () => {
  const cwd = tmpdir();
  for (const command of [
    // The form the acceptance check uses.
    'lsof -ti:1 | xargs kill -0',
    // A sweep as a session once wrote it.
    'lsof -ti:3000 | xargs kill',
    'lsof -ti:3000 | xargs kill -9',
    'lsof -t -i:3000 | kill',
    'lsof -ti:3000 2>/dev/null | xargs -r kill -9',
    'lsof -ti:3000 | xargs -I{} kill -9 {}',
    'lsof -ti:3000 | xargs -n 1 kill',
    'lsof -ti:3000 | grep -v 4242 | xargs kill',
    'lsof -ti:3000 |\n  xargs kill',
    'lsof -ti:3000 |& xargs kill',
    'sudo lsof -ti:3000 | sudo xargs kill',
    '/usr/sbin/lsof -ti:3000 | /usr/bin/xargs /bin/kill',
    'echo before; { lsof -ti:3000 | xargs kill; } || true',
    'for port in 3000 5173; do lsof -ti:$port | xargs kill; done',
    // Filtering to listeners first does not make the sweep a kill by PID.
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs kill',
    // The same sweep through a command substitution.
    'kill $(lsof -ti:3000)',
    'kill -9 "$(lsof -t -i:3000)"',
    'kill `lsof -ti:3000`',
    'kill $(lsof -ti:3000 | head -1)',
    'echo 1 | xargs kill $(lsof -ti:3000)',
    // GNU xargs's long options, whose value is a word of its own.
    'lsof -ti:3000 | xargs --max-args 1 kill',
    'lsof -ti:3000 | xargs --max-procs 2 --delimiter , kill -9',
    // The same sweep through a loop, a variable or a file: the output of an
    // `lsof` that a later `kill` reads, in the same command line.
    'lsof -ti:3000 | while read p; do kill $p; done',
    'lsof -ti:3000 | while read -r pid; do\n  kill -9 "$pid"\ndone',
    'for p in $(lsof -ti:3000); do kill $p; done',
    'for p in `lsof -ti:3000`; do kill -9 $p; done',
    'pids=$(lsof -ti:3000); kill $pids',
    'PIDS="$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)"\n[ -n "$PIDS" ] && kill $PIDS',
    'lsof -ti:3000 > /tmp/pids; kill $(cat /tmp/pids)',
    'lsof -t -i:3000 >> pids.txt && xargs kill < pids.txt',
    'lsof -ti:3000 | head -1 > pid; kill -9 "$(cat pid)"',
    'read -r pid < <(lsof -ti:3000); kill "$pid"',
    'mapfile -t pids < <(lsof -ti:3000); kill "${pids[@]}"',
    'lsof -ti:3000 | tee pids.txt; kill $(cat pids.txt)',
    'lsof -ti:3000 | sort -u | while read -r p; do kill "$p"; done',
    'lsof -ti:3000 | { read p; kill $p; }',
    'lsof -ti:3000 | (read p; kill $p)',
    'lsof -ti:3000 > f; kill $(< f)',
    'while read p; do kill $p; done < <(lsof -ti:3000)',
    'pids=($(lsof -ti:3000)); kill "${pids[@]}"',
    'export P=$(lsof -ti:3000); kill $P',
    'a=$(lsof -ti:3000); b=$a; kill $b',
    'kill $(echo $(lsof -ti:3000))',
    // A command that reads the file `<(lsof …)` makes passes its output on.
    'kill -0 $(cat <(lsof -ti:1))',
    'kill -0 $(sort -u <(lsof -ti:1))',
    'cat <(lsof -ti:1) | xargs kill',
    // Order does not matter: the variable or the file is followed by name.
    'cat f | xargs kill; lsof -ti:3000 > f',
  ]) {
    refused(guard(command, cwd), SWEEP, command);
    refused(guard(command, cwd, 'architect'), SWEEP, `architect: ${command}`);
  }

  // `lsof` whose output goes nowhere near `kill` is not a sweep, and in the
  // main session the guard leaves it to the permission system — the read-only
  // LISTEN form above all.
  for (const command of [
    'lsof -nP -iTCP:1 -sTCP:LISTEN -t',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN | head -3',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t; kill 4242',
    'lsof -ti:3000 || kill 4242',
    'lsof -ti:3000 | xargs echo kill',
    'lsof -ti:3000 | xargs ps -o pid,ppid,command -p',
    'echo 4242 | xargs kill',
    // The LISTEN form alongside a later `kill` that writes its PID out, or
    // takes `$!`, the job the command itself just started: the PID a person
    // read and typed is a kill by PID, not a sweep.
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t | head -1; kill 4242',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN | grep node; kill -9 4242 4243',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN | grep node; npm run dev & sleep 1; kill $!',
    // …or whose own output reaches nothing but the terminal, through a
    // pipeline or not, whatever a later `kill` takes.
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t; kill $PID',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN | head -3; kill -9 "$PID"',
    'lsof -nP -iTCP:6443 -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk \'{print $2}\' | head -5; old=$(cat tunnel.pid); kill "$old"',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null; kill "$(cat server.pid)"',
    // A `kill` before the `lsof` reads nothing of it.
    'kill "$PID"; lsof -nP -iTCP:3000 -sTCP:LISTEN -t | head -1',
    // A LISTEN check whose output is captured, or written away, and a `kill`
    // of a PID that did not come from it: the PID decides, not the line.
    'if [ -n "$(lsof -nP -iTCP:5173 -sTCP:LISTEN -t)" ]; then kill "$SERVER_PID"; fi',
    'lsof -nP -iTCP:5173 -sTCP:LISTEN -t >/dev/null && kill $(cat server.pid)',
    'lsof -nP -iTCP:5173 -sTCP:LISTEN -t &>/dev/null; kill "$pid"',
    'npm run dev:frontend > dev.log 2>&1 & pid=$!; sleep 5; listener=$(lsof -nP -iTCP:5173 -sTCP:LISTEN -t); echo "$listener"; kill $pid',
    'lsof -nP -iTCP:5173 -sTCP:LISTEN -t | head -1 > f; kill -0 "$pid"',
    'lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null >> /dev/null; kill $(cat other.pid)',
    'pids=$(lsof -ti:3000); echo "$pids"; kill $(cat server.pid)',
    'lsof -ti:3000 | tee seen.txt; kill $(cat server.pid) 4242',
    'kill -0 $(cat <(echo 4242))',
    'diff <(lsof -nP -iTCP:3000 -sTCP:LISTEN -t) pids.txt; kill $(cat server.pid)',
  ]) {
    passed(guard(command, cwd), command);
    passed(guard(command, cwd, 'architect'), `architect: ${command}`);
  }
});

test('the guard refuses pkill and killall wherever a segment begins with them', () => {
  const cwd = tmpdir();
  for (const [name, rule] of [
    ['pkill', PKILL],
    ['killall', KILLALL],
  ]) {
    for (const command of [
      // The forms the acceptance check and the trial use.
      `${name} -0 flow-guard-canary`,
      `${name} node`,
      `${name} -9 -f "vite preview --port 4317"`,
      `npm test; ${name} node`,
      `sleep 1 && ${name} node`,
      `curl -sS http://localhost:5173/ || ${name} node`,
      `npm run dev:frontend & ${name} vite`,
      `echo done\n${name} node`,
      `ps -ax | ${name} node`,
      `echo node | xargs ${name}`,
      `echo node | xargs -n 1 ${name} -f`,
      `/usr/bin/${name} node`,
      `sudo ${name} node`,
      `sudo -u root ${name} node`,
      `env FOO=1 ${name} node`,
      `FOO=1 ${name} node`,
      `command ${name} node`,
      `nohup ${name} node`,
      `time ${name} node`,
      `"${name}" node`,
      `'${name}' node`,
      `${name[0]}\\${name.slice(1)} node`,
      `(${name} node)`,
      `{ ${name} node; }`,
      `if ${name} -0 node; then echo running; fi`,
      `! ${name} -0 node`,
      `while true; do ${name} node; done`,
      `(kill %1 2>/dev/null; ${name} -f scratchpad/probe.mjs 2>/dev/null; true)`,
      `2>/dev/null ${name} node`,
      `echo "stopped: $(${name} node)"`,
      `PIDS=$(${name} -l node)`,
      `diff <(${name} -l node) pids.txt`,
      // Runners that run the command named after them.
      `nice ${name} node`,
      `nice -n 5 ${name} node`,
      `timeout 5 ${name} node`,
      `timeout -s KILL 5 ${name} node`,
      `timeout --signal=KILL --kill-after 2 5 ${name} node`,
      `caffeinate -i ${name} node`,
      `caffeinate -t 60 ${name} node`,
      `arch -arm64 ${name} node`,
      `arch -arch x86_64 ${name} node`,
      `sudo --user root ${name} node`,
      `sudo --user=root ${name} node`,
      `env --unset FOO ${name} node`,
      `echo node | xargs --max-args 1 ${name}`,
      `nice timeout 5 sudo -u root ${name} node`,
      // zsh: the precommand modifiers, `- cmd`, `repeat`, `coproc` and the
      // `=cmd` word, which is the command's path.
      `noglob ${name} node`,
      `nocorrect ${name} node`,
      `- ${name} node`,
      `repeat 1 ${name} node`,
      `coproc ${name} node`,
      `=${name} node`,
      // A pattern is not a command, but what a `case` item or a `[[ … ]]`
      // test runs is.
      `case "$1" in (stop) ${name} node ;; esac`,
      `case "$1" in\n  stop|halt) ${name} node ;;\nesac`,
      `case "$1" in (${name}) echo match ;; esac; ${name} node`,
      `[[ $1 == (stop|halt) ]] && ${name} node`,
      // `]]` written against the operator that follows it ends the test.
      `[[ -n x ]]&& ${name} -0 flow-guard-canary`,
      `[[ -z x ]]||${name} -0 flow-guard-canary`,
      `[[ -n x ]];${name} node`,
      `[[ -n x ]]|${name} node`,
      `[[ -n x ]]\n${name} node`,
      `[[ -n x ]]>/dev/null && ${name} node`,
    ]) {
      for (const agent of [undefined, 'tester']) {
        refused(guard(command, cwd, agent), rule, `${agent ?? 'main'}: ${command}`);
      }
    }
  }

  // Unescaped backticks run their content even inside double quotes, so the
  // shell would run this too; the refusal says where it found the command.
  const inBackticks = guard('git commit -m "the guard refuses `pkill -0 x`"', cwd);
  refused(inBackticks, PKILL, 'pkill in unescaped backticks');
  assert.match(inBackticks.stderr, /It stands in a command substitution/);
  assert.doesNotMatch(guard('pkill node', cwd).stderr, /command substitution/);

  // The first rule broken, as written, is the one named.
  refused(guard('killall node; pkill node', cwd), KILLALL, 'killall before pkill');
  refused(guard('pkill node; killall node', cwd), PKILL, 'pkill before killall');

  // The refusal names the rule and never repeats the command.
  const result = guard('pkill -f "token=flow-guard-made-up-secret-0123456789"', cwd);
  refused(result, PKILL, 'a made-up secret');
  assert.ok(!result.stderr.includes('made-up-secret'), 'the refusal echoes the command');
});

test('inside the developer, tester and tester-process sub-agents the guard refuses any lsof', () => {
  const cwd = tmpdir();
  const commands = [
    // The form the acceptance check uses, which passes in the main session.
    'lsof -nP -iTCP:1 -sTCP:LISTEN -t',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN -t',
    'lsof -i :3000',
    'lsof -nP -iTCP:3000 -sTCP:LISTEN | head -3',
    'sudo lsof -i',
    '/usr/sbin/lsof -ti:3000',
    'echo ports; lsof -ti:3000 || echo free',
    'PIDS=$(lsof -ti:3000)',
    'echo "listening: $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)"',
    'for port in 3000 5173; do lsof -nP -iTCP:$port -sTCP:LISTEN; done',
    'echo 3000 | xargs -I{} lsof -ti:{}',
  ];
  // `tester-process` carries `tester`'s body on another model (D21).
  for (const agent of ['developer', 'tester', 'tester-process']) {
    for (const command of commands) {
      refused(guard(command, cwd, agent), lsofInside(agent), `${agent}: ${command}`);
    }
    // A sweep is refused there too, by whichever rule it breaks first.
    assert.equal(guard('lsof -ti:1 | xargs kill -0', cwd, agent).status, 2);
    assert.equal(guard('kill $(lsof -ti:3000)', cwd, agent).status, 2);

    // Naming `lsof` is not running it.
    for (const command of [
      'grep -rn lsof docs .claude',
      'git log --oneline --grep lsof',
      'echo lsof',
      'command -v lsof',
      'which lsof',
      'man lsof | head -5',
      'ps -o pid,ppid,command -ax | grep lsof',
      './lsof.sh',
      'npm run lsof',
      'echo "never lsof, never a sweep by port"',
      '# lsof -ti:3000\necho no',
    ]) {
      passed(guard(command, cwd, agent), `${agent}: ${command}`);
    }
  }

  // The main session, and a sub-agent whose definition does not forbid it.
  for (const agent of [undefined, 'architect', 'general-purpose', 'Tester', 'developer-2']) {
    for (const command of commands) {
      passed(guard(command, cwd, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
});

// D9's names in another letter case, which macOS's file system runs all
// the same (`/usr/bin/PKILL` resolves), and a glob that builds one —
// `/usr/bin/pk?ll` — each run through bash 3.2 and zsh 5.9 with stand-ins. The guard reads the names in any case,
// as the merge rule's already were, and a glob as every name it could match,
// a wrapper and `xargs` among them; a glob that can be none of them, or a
// bracket that is no glob, passes.
test('the guard reads a D9 name in any letter case, and a glob that could be one as each of them', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  const sweepInTester = new RegExp(`${SWEEP.source}|${lsofInside('tester').source}`);

  const forms = [
    [PKILL, '/usr/bin/pkil[l] -0 flow-guard-none'],
    [PKILL, '/usr/bin/pk?ll -0 flow-guard-none'],
    [PKILL, '/usr/bin/p*ll -0 flow-guard-none'],
    [PKILL, '/usr/bin/pk(i)ll -0 flow-guard-none'],
    [PKILL, 'pkil[l] -0 flow-guard-none'],
    [PKILL, 'PKILL -0 flow-guard-none'],
    [PKILL, 'Pkill -0 flow-guard-none'],
    [PKILL, 'PKIL? -0 flow-guard-none'],
    [PKILL, 'sudo -n PKILL -0 flow-guard-none'],
    [PKILL, '/usr/bin/en? pkill -0 flow-guard-none'],
    [PKILL, 'echo x | /usr/bin/xarg? PKILL -0'],
    [KILLALL, '/usr/bin/killal[l] -0 flow-guard-none'],
    [KILLALL, '/usr/bin/kil?all -0 flow-guard-none'],
    [KILLALL, 'KillAll -0 flow-guard-none'],
    [KILLALL, 'KILLALL -0 flow-guard-none'],
    [SWEEP, 'kill -0 $(/usr/sbin/lso[f] -ti:1)'],
    [SWEEP, '/usr/sbin/lso[f] -ti:1 | xargs kill -0'],
    [SWEEP, '/usr/sbin/ls?f -ti:1 | xargs kill -0'],
    [SWEEP, 'LSOF -ti:1 | xargs kill -0'],
    [SWEEP, 'kill -0 $(LSOF -ti:1)'],
    [SWEEP, 'Lsof -ti:1 | xargs kill -0'],
    [SWEEP, 'lsof -ti:1 | xargs KILL -0'],
    [SWEEP, 'lsof -ti:1 | XARGS kill -0'],
    [SWEEP, 'lsof -ti:1 | /usr/bin/xarg? kill -0'],
    [SWEEP, 'lsof -ti:1 | xargs /bin/ki?l -0'],
    [SWEEP, 'lsof -ti:1 | xargs /bin/KI[L]L -0'],
    [SWEEP, 'p=$(LSOF -ti:1); KILL -0 $p'],
    [SWEEP, 'Kill -0 $(lsof -ti:1)'],
    [ON_MAIN, '/usr/bin/gi[t] commit --dry-run'],
    [ON_MAIN, '/usr/bin/GI[T] commit --dry-run'],
    [ON_MAIN, 'gi? commit --dry-run'],
    [ON_MAIN, 'GIT commit --dry-run'],
    [ON_MAIN, 'Git commit --dry-run'],
    [ON_MAIN, 'git comm?t --dry-run'],
    [ON_MAIN, 'git c[o]mmit --dry-run'],
    [ON_MAIN, 'git comm(i)t --dry-run'],
  ];
  for (const [rule, command] of forms) {
    refused(guard(command, work), rule, `main: ${command}`);
    refused(
      guard(command, work, 'tester'),
      rule === SWEEP ? sweepInTester : rule,
      `tester: ${command}`,
    );
  }

  // Any `lsof` inside `developer`, `tester` and `tester-process` (D21), in
  // any case or a glob; the main session leaves the LISTEN form to the
  // permission system.
  for (const command of [
    '/usr/sbin/lso[f] -nP -iTCP:1 -sTCP:LISTEN -t',
    '/usr/sbin/ls?f -nP -iTCP:1 -sTCP:LISTEN -t',
    'LSOF -nP -iTCP:1 -sTCP:LISTEN -t',
    'Lsof -nP -iTCP:1 -sTCP:LISTEN -t',
    '/usr/sbin/LSOF -nP -iTCP:1 -sTCP:LISTEN -t',
    'echo 3000 | xargs -I{} LSOF -ti:{}',
  ]) {
    for (const agent of ['developer', 'tester', 'tester-process']) {
      refused(guard(command, work, agent), lsofInside(agent), `${agent}: ${command}`);
    }
    passed(guard(command, work), `main: ${command}`);
  }

  // What can be none of D9's names, or is no glob at all.
  for (const command of [
    '[ -n "$x" ] && echo yes',
    '[[ -n $x ]] && echo yes',
    '[ "$a" = "[" ] && echo yes',
    'echo [',
    '[ -f pkill ] || echo none',
    './scripts/*.sh',
    './pkil[l].sh',
    'ls /usr/bin/pk* /usr/sbin/lso?',
    'echo pkil? killal[l] lso[f] KILL',
    'for f in *; do echo "$f"; done',
    "grep -n '[p]kill' notes.txt",
    "ps -o pid,ppid,command -ax | grep '[l]sof'",
    'case "$1" in pkil?|LSOF) echo match ;; esac',
    'kill 4242',
    'KILL -0 4242',
    'git status; git log --oneline -1',
    'GIT status',
    'git COMMIT --dry-run',
    'f() { echo hi; }',
  ]) {
    for (const agent of [undefined, 'tester', 'developer']) {
      passed(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
});

// What a wrong refusal would cost: a night run stalled on a command that only
// talks about the forbidden ones. Each of these names them without a segment
// beginning with one.
test('a command that only names a refused command passes', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  git(work, 'switch', '--quiet', '--create', 'chore/task');

  for (const command of [
    'git commit -m "docs: never lsof | xargs kill, never pkill, never killall"',
    "git commit -m 'pkill; killall && lsof -ti:1 | xargs kill'",
    'git commit -m "refuse \\`pkill -0 x\\` and \\$(killall node)"',
    'git commit -m pkill',
    // The form Claude Code writes a commit message in: a quoted here-document
    // inside a substitution inside double quotes, here with lines that begin
    // with the refused commands and an apostrophe that closes nothing.
    "git commit -m \"$(cat <<'EOF'\nchore: a guard for Bash\n\npkill and killall are refused;\nlsof -ti:1 | xargs kill is refused, and it's a sweep.\nkillall -0 node\n\nCo-Authored-By: Someone <someone@example.invalid>\nEOF\n)\"",
    "git commit -F - <<'EOF'\npkill node\nkillall node\nlsof -ti:1 | xargs kill\nEOF",
    'git commit -F - <<-EOF\n\tpkill node\n\tEOF',
    "git add -A && git commit -q -F - <<'MSG' && git log --oneline -1\npkill node; it's refused\nMSG",
    'gh issue comment 83 --body "the guard refuses pkill, killall and lsof | xargs kill"',
    "gh pr create --title 'A guard' --body \"$(cat <<'EOF'\n## What\n\npkill -0 x\nEOF\n)\"",
    'grep -rn "pkill\\|killall" docs | wc -l',
    'grep -c pkill notes.txt; grep -c killall notes.txt',
    'git log --oneline --grep=pkill | head -5',
    'echo pkill killall',
    'echo "a kill by pattern (pkill)" # pkill node; killall node',
    "printf '%s\\n' pkill killall lsof",
    '# pkill node; killall node\n# lsof -ti:1 | xargs kill\necho done',
    'node -e \'console.log("pkill node; killall node")\'',
    'cat <<EOF | grep -c kill\npkill node\nkillall node\nlsof -ti:1 | xargs kill\nEOF',
    "python3 - <<'PY'\nimport os\nos.system('pkill node')\nPY",
    'ps -o pid,ppid,command -ax | grep -v grep | grep -E "pkill|killall"',
    'command -v pkill; command -V killall; command -pv lsof',
    'which pkill killall',
    'man pkill | head -5',
    'case "$1" in\n  pkill) echo no ;;\n  killall|lsof) echo no ;;\nesac',
    '[[ "$1" =~ ^(pkill|killall|lsof)$ ]] && echo no',
    '[[ "$1" =~ (pkill|killall|lsof) ]] && echo no',
    // The POSIX pattern with its leading parenthesis, and zsh's groups.
    'case "$1" in (pkill) echo match ;; esac',
    'case "$1" in (pkill|killall) echo match ;; esac',
    'case "$1" in\n  (pkill) echo match ;;\n  (killall|lsof) echo match ;&\n  (*) echo other ;;\nesac',
    'case $1 in pkill|killall) echo a;; lsof) echo b;;& *) echo c;; esac',
    'case "$1" in ((pkill|killall)) echo match ;; esac',
    '[[ $1 == (pkill|killall) ]] && echo match',
    'if [[ $a == x && $b == (pkill|lsof) || $c < d ]]; then echo yes; fi',
    'nice -n 10 echo pkill; timeout 5 echo killall; command -v nice timeout',
    'for name in pkill killall lsof; do echo "$name"; done',
    'names=(pkill killall); echo "${names[@]}"',
    './pkill.sh; ./scripts/killall.mjs',
    'npm run pkill',
    'xargs echo pkill < names.txt',
    'echo done > pkill; cat < killall',
    'echo ${x:-pkill} ${y:-;killall}',
    'echo $(( 2 << 3 )) pkill',
    "awk '/pkill|killall/ { print $1 }' notes.txt",
    'curl -sS "http://localhost:3000/?q=pkill&r=killall"',
  ]) {
    for (const agent of [undefined, 'developer', 'tester']) {
      passed(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
});

// The night run's own way to stop what it started (D5): by the recorded
// PID. The guard has no opinion on it; the permission system decides.
test('a plain kill by PID passes', () => {
  const cwd = tmpdir();
  for (const command of [
    'kill 12345',
    'kill -9 12345',
    'kill -TERM 12345 12346',
    'kill -0 12345 && echo alive',
    'kill $!',
    'kill %1',
    'kill "$PID"',
    'kill $(cat server.pid)',
    'kill -9 `cat server.pid`',
    'npm run dev:frontend > dev.log 2>&1 &\necho $!',
    'kill 4242; sleep 10; kill -9 4242',
    'ps -o pid,ppid,command -ax | grep vite; kill -9 4242 4243',
  ]) {
    for (const agent of [undefined, 'developer', 'tester']) {
      passed(guard(command, cwd, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
});

// Merges go through the delivery queue (D16): the guard refuses every command
// that merges a pull request itself — with a token in front of it or without,
// the delivery lock's current one included — and lets the queue's own merge
// command through, which checks the lock's current token and runs the merge
// where no Bash call is made. That the queue refuses a stale token, and runs
// gh only under the current one, is tested with the queue. The guard reads no
// token, so the one here has the queue's shape and nothing more.
const QUEUE = join(scripts, 'delivery-queue.mjs');
const MERGE_OUTSIDE =
  /, a merge outside the delivery queue\. Merge with `node \.claude\/scripts\/delivery-queue\.mjs merge <task> --token <token> --sha <sha>`, which checks the delivery lock's current token and runs the merge itself; take the lock first with `node \.claude\/scripts\/delivery-queue\.mjs lock <task> --session <id>`\./;
const UNREAD_GH =
  /a command that names `gh` together with a merge and that the guard cannot read to its end \([^)]+\), in which a merge cannot be told apart\. Write it so that it reads to its end/;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = randomUUID().replaceAll('-', '');

// The guard's line for a merge cites D16, not D9.
function refusedMerge(result, label, rule = MERGE_OUTSIDE) {
  refused(result, rule, label);
  assert.match(
    result.stderr,
    /\[PreToolUse hook \.claude\/scripts\/guard-bash\.mjs, D16\]\n$/,
    brief(label),
  );
}

// Every way of merging the guard knows, as a session would write it.
const MERGES = [
  'gh pr merge 151 --repo owner/repo --merge --match-head-commit 0123abcd --delete-branch',
  'gh pr merge',
  'gh pr merge 151 --auto --squash',
  'gh pr merge 151 --admin --rebase',
  'gh pr merge -R owner/repo 151',
  'gh pr --repo owner/repo merge 151',
  'gh api --method PUT repos/owner/repo/pulls/151/merge',
  'gh api -X PUT "repos/owner/repo/pulls/151/merge?sha=0123abcd"',
  'gh api --method PUT repos/owner%2Frepo/pulls/151/merge/',
  'gh api --method PUT "repos/{owner}/{repo}/pulls/$PR/merge"',
  'gh api -X PUT repos/{owner}/{repo}/pulls/151/merge -f merge_method=merge',
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kw\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_kw\"}) { clientMutationId } }'",
  '/opt/homebrew/bin/gh pr merge 151',
  'env gh pr merge 151',
  'git fetch origin && gh pr merge 151',
  'cd /tmp && gh pr merge 151',
  '(gh pr merge 151)',
  'echo "$(gh pr merge 151)"',
  'gh pr view 151; gh pr merge 151',
];

test("the guard refuses every merge outside the queue, the delivery lock's current token in front or not, and lets the queue's merge through", (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);

  for (const command of MERGES) {
    for (const agent of [undefined, 'developer']) {
      refusedMerge(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
      // The token the lock gave is no pass for a merge outside the queue.
      refusedMerge(
        guard(`DELIVERY_LOCK=${TOKEN} ${command}`, work, agent),
        `${agent ?? 'main'}, with the current token: ${command}`,
      );
    }
  }

  // The queue's own merge, with the current token: the one way through.
  for (const command of [
    `node .claude/scripts/delivery-queue.mjs merge day-merge --token ${TOKEN} --sha ${SHA}`,
    `cd ${work} && node .claude/scripts/delivery-queue.mjs merge 127 --token ${TOKEN} --sha ${SHA}`,
    `node "${QUEUE}" merge day-merge --token ${TOKEN} --sha ${SHA}`,
  ]) {
    for (const agent of [undefined, 'developer', 'tester']) {
      passed(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // What does not merge passes.
  for (const command of [
    'gh pr view 151',
    'gh pr view 151 --repo owner/repo --json number,state,isDraft,headRefName,headRefOid,mergeable,mergeStateStatus',
    'gh pr create --title "merge the queue" --body "gh pr merge 151"',
    'gh pr create --repo owner/repo --draft --base main --head chore/m --title x --body-file /tmp/b.md',
    'gh pr create --title x --auto-merge=false',
    'gh pr comment 151 --body "DELIVERY_LOCK=x gh pr merge 151"',
    'gh pr list --state merged',
    'gh pr ready 151',
    'gh pr checks 151',
    'gh pr diff 151',
    'gh pr edit 151 --body-file /tmp/body.md',
    'gh run list --repo owner/repo --commit 0123abcd --json databaseId,workflowName,status,conclusion',
    'gh api repos/owner/repo/pulls/151',
    'gh api repos/owner/repo/issues/151/comments --field body=merge',
    'gh api repos/owner/repo/pulls/151/merge_ref',
    'gh api repos/owner/repo/pulls/151/merge/x',
    'gh api repos/owner/repo/merge',
    'gh api "repos/owner/repo/pulls/151/merge%3Fx"',
    'gh issue comment 151 --body "mergePullRequest is the GraphQL name"',
    'git merge origin/main',
    'git push origin chore/m',
    'git push --set-upstream origin chore/m',
    'echo gh pr merge 151',
    'grep -n "gh pr merge" docs/DELIVERY.md',
    "echo ${x:-$'\\''}",
    '$GH pr merge 151',
  ]) {
    passed(guard(command, work), command);
  }
});

// Each way past the merge rule that a hostile check would try, refused; the
// sanctioned form, the queue's merge with the current token, still passes.
test('the merge rule reads a path as GitHub routes it, a quote as the shell does, a name in any case, and fails closed on what it cannot read', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  passed(
    guard(
      `node .claude/scripts/delivery-queue.mjs merge day-m --token ${TOKEN} --sha ${SHA}`,
      work,
    ),
    'the sanctioned form',
  );

  const bypasses = [
    // The path as the server reads it: no fragment or query, escapes decoded,
    // `//`, `.` and `..` folded, a format suffix, any case, any prefix.
    'gh api -X PUT "repos/o/r/pulls/5/merge#x"',
    'gh api -X PUT "repos/o/r/pulls/5/merge#"',
    'gh api -X PUT "repos/o/r/pulls/5/merge?a=1#x"',
    'gh api -X PUT repos/o/r/pulls/5/merge.json',
    'gh api -X PUT repos/o/r/pulls/5/merge.json?sha=1',
    'gh api -X PUT repos/o/r//pulls//5//merge',
    'gh api -X PUT repos/o/r/./pulls/./5/./merge/.',
    'gh api -X PUT repos/o/r/pulls/5/x/../merge',
    'gh api -X PUT repos/o/r/pulls/5/merge/x/..',
    'gh api -X PUT repos/o/r/pu%6Cls/5/%6Derge',
    'gh api -X PUT repos/o/r/pulls%2F5%2Fmerge',
    'gh api -X PUT repos/o/r/pulls/5/%6d%65%72%67%65',
    'gh api -X PUT repos/o/r/pul%256Cs/5/merge',
    'gh api -X PUT repos/o/r/PULLS/5/Merge',
    'gh api -X PUT https://api.github.com/repos/o/r/pulls/5/merge',
    'gh api -X PUT repositories/123/pulls/5/merge',
    "gh api -X PUT 'repos/o/r/pulls/5/merge;x'",
    'gh api -X PUT "repos/o/r/pulls;a/5/merge;b=c"',
    // GraphQL, at any endpoint and in any case.
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kw\", mergeMethod: MERGE}) { clientMutationId } }'",
    'gh api graphql --raw-field query="mutation{mergePullRequest(input:{pullRequestId:\\"PR_kw\\"}){clientMutationId}}"',
    "gh api graphql -F query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"PR_kw\"}){clientMutationId}}'",
    'gh api /graphql -f query=mutation{MergePullRequest}',
    'gh api https://api.github.com/graphql --field=query=ENABLEPULLREQUESTAUTOMERGE',
    // A parameter expansion holding a quote the splitter misread.
    "gh pr merge 5; echo ${x:-$'\\''}",
    "echo ${x:-$'\\''}; gh pr merge 5",
    'echo ${x:-"}"}; gh pr merge 5',
    "echo ${x:-'}'}; gh pr merge 5",
    // ANSI-C and locale quoting, decoded before matching.
    "gh pr $'\\x6derge' 5",
    "gh pr $'\\x6Derge' 5",
    "gh pr $'\\155erge' 5",
    "gh pr $'\\u006derge' 5",
    "gh pr $'\\U0000006derge' 5",
    "gh pr $'\\x6d'erge 5",
    "gh $'\\x70r' merge 5",
    "$'\\x67h' pr merge 5",
    'gh pr $"merge" 5',
    'gh pr $"mer"ge 5',
    '$"gh" pr merge 5',
    // A subcommand only known when it runs.
    'gh pr "$sub" 5',
    'gh pr $(echo merge) 5',
    'gh "$group" merge 5',
    // A name in another case, which macOS runs all the same.
    'GH pr merge 5',
    'Gh pr MERGE 5',
    'ENV gh pr merge 5',
    'COMMAND gh pr merge 5',
    'Nohup gh pr merge 5',
    'XARGS gh pr merge < ids',
    // A pull request set to merge itself.
    'gh pr merge 5 --auto',
    'gh pr create --title x --auto-merge',
    'gh pr create --title x --auto-merge=true',
    'gh pr create --title x --auto',
    'gh pr edit 5 --auto-merge=1',
    'gh pr edit 5 --auto',
  ];
  for (const command of bypasses) {
    refusedMerge(guard(command, work), command);
    refusedMerge(guard(`DELIVERY_LOCK=${TOKEN} ${command}`, work), `with the token: ${command}`);
  }

  // A command the splitter cannot read to its end: the merge rule fails
  // closed when it names gh together with a merge, however it is spelled; the
  // other rules still pass what they cannot read.
  for (const command of [
    "gh pr merge 5 'never closed",
    "echo 'x; gh pr merge 5",
    'gh pr view 5 "is it merged',
    'g\\h pr merge 5 $(never closed',
    "g''h pr merge 5 `echo $(echo `x`)`",
    '/usr/local/bin/GH api repos/o/r/pulls/5/merge ${never',
    'gh api graphql -f query="mutation { mergePullRequest',
    'gh api -X PUT repos/o/r/pulls/5/%6derge "x',
    "g? pr merg? 5 'x",
    `DELIVERY_LOCK=${TOKEN} gh pr merge 5 'never closed`,
  ]) {
    refusedMerge(guard(command, work), command, UNREAD_GH);
  }
  for (const command of [
    "echo 'never closed",
    'pkill node "never closed',
    "echo ghost 'x",
    "gh pr view 5 'never closed",
    "echo merge 'x",
    "git merge origin/main 'x",
  ]) {
    unchecked(guard(command, work), command);
  }
});

// The readings a hostile check of the source guard found: a `gh api` endpoint
// built by a substitution, whose text the guard read as empty; `$'\c'`, whose
// `\c` took the closing quote, so that everything after it read as quoted —
// the D9 rules too; and `((…) )`, which the shells run as two subshells
// where the guard skipped it as arithmetic. And the readings beside them: a
// substitution inside arithmetic or inside `${…}` runs, and zsh decodes `$'…'`
// differently from bash — an escape it does not know loses its backslash, so
// `$'\merge'` is `merge`, and a NUL ends the argument, so `$'merge\0x'` is
// `merge`.
test("the guard reads an API endpoint, $'…', arithmetic and ${…} as bash and zsh run them", (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);

  // What makes a merge: refused as one, in the main session and in a
  // sub-agent.
  const merges = [
    // An endpoint a substitution, arithmetic or an expansion gives.
    'gh api --method PUT repos/o/r/pulls/$(echo 5)/merge -f sha=abc',
    'gh api --method PUT repos/o/r/pulls/`echo 5`/merge -f sha=abc',
    'gh api --method PUT repos/o/r/pulls/$((2+3))/merge',
    'gh api --method PUT "repos/o/r/pulls/$(echo 5)/merge"',
    'gh api --method PUT "repos/o/r/pulls/$(( 5 ))/merge"',
    'gh api --method PUT repos/o/r/$(echo pulls)/5/merge',
    'gh api --method PUT repos/o/r/pulls/5/$(echo merge)',
    'gh api --method PUT repos/o/r/pulls/5/`echo merge`',
    'gh api --method PUT repos/o/r/pulls/5/"$(echo merge)"',
    'gh api --method PUT repos/o/r/pulls/5/merg$(echo e)',
    'gh api --method PUT repos/o/r/pulls/5/${x:-merge}',
    'gh api --method PUT repos/o/r/pulls/${x:-5}/merge',
    'gh api --method PUT repos/o/r/pulls/${#x}/merge',
    'gh api --method PUT repos/o/r/pulls/<(echo 5)/merge',
    // The endpoint among body and output options, after them or after `--`.
    'gh api -f a=1 --method PUT repos/o/r/pulls/5/merge',
    'gh api --field=a=1 -X PUT repos/o/r/pulls/5/merge',
    'gh api -fa=1 -X PUT repos/o/r/pulls/5/merge',
    'gh api -X PUT -- repos/o/r/pulls/5/merge',
    'gh api repos/o/r/pulls/151/merge --field body=x',
    'gh api repos/o/r/pulls/151/merge --jq .merged',
    'gh api -q .merged -t "{{.merged}}" repos/o/r/pulls/151/merge',
    // `$'\c'`: the closing quote ends the string.
    "echo $'\\c'; gh pr merge 5 # '",
    "echo $'\\c\\''; gh pr merge 5 # '",
    "echo $'\\\\'; gh pr merge 5 # '",
    // `((…) )` and `$((…) )`: subshells, not arithmetic.
    '((gh pr merge 5) )',
    'echo $((gh pr merge 5) )',
    '((gh pr merge 5); true)',
    'echo "$((gh pr merge 5) )"',
    '(((gh pr merge 5) ) )',
    'echo $(((gh pr merge 5) ) )',
    '((gh pr merge 5)&& true)',
    '((gh pr merge 5)|cat)',
    "((echo '))'; gh pr merge 5) )",
    // A substitution inside arithmetic or `${…}` runs.
    'echo $(( $(gh pr merge 5; echo 1) ))',
    'echo $(( `gh pr merge 5; echo 1` ))',
    'echo $(( x[$(gh pr merge 5)] ))',
    'echo $(( ${x:-$(gh pr merge 5)} + 1 ))',
    'for ((i=$(gh pr merge 5; echo 0); i<1; i++)); do :; done',
    'echo ${x:-$(gh pr merge 5)}',
    'echo "${x:-$(gh pr merge 5)}"',
    'echo ${x:-"$(gh pr merge 5)"}',
    'echo ${x:-`gh pr merge 5`}',
    'echo ${x/$(gh pr merge 5)/y}',
    `echo "\${x:-'$(gh pr merge 5)'}"`,
    // zsh's reading of `$'…'`, and a NUL, which ends the argument in both.
    "gh pr $'\\merge' 5",
    "gh pr $'mer\\ge' 5",
    "gh $'\\pr' merge 5",
    "gh pr $'merge\\0junk' 5",
    "gh pr $'merge\\x00junk' 5",
    "gh pr $'merge\\xjunk' 5",
    "gh pr $'merge\\ujunk' 5",
    "gh pr $'merge\\u0000junk' 5",
    "gh pr merge$'\\0'junk 5",
    "gh pr $'mer\\0x'ge 5",
    "gh pr $'merge\\c@junk' 5",
    "gh pr $'merge\\C-@junk' 5",
    "gh pr $'merge\\C@junk' 5",
    "gh pr $'merge\\C-\\x40junk' 5",
    "gh pr $'merge\\C' 5",
    "gh pr $'merge\\M-' 5",
    "$'gh\\0x' pr merge 5",
    "gh api -X PUT $'repos/o/r/pu\\lls/5/merge'",
    "gh api -X PUT repos/o/r/pulls/5/$'merge\\0'x",
  ];
  for (const command of merges) {
    for (const agent of [undefined, 'developer']) {
      refusedMerge(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // The D9 rules behind the same readings: the shells run every one of
  // these. Inside `tester` a sweep may be refused for its `lsof`, which comes
  // first.
  const sweepInTester = new RegExp(`${SWEEP.source}|${lsofInside('tester').source}`);
  const d189 = [
    [PKILL, "echo $'\\c'; pkill -0 flow-guard-none # '"],
    [KILLALL, "echo $'\\c'; killall -0 flow-guard-none # '"],
    [SWEEP, "echo $'\\c'; lsof -ti:1 | xargs kill -0 # '"],
    [PKILL, '((pkill -0 flow-guard-none) )'],
    [KILLALL, '((killall -0 flow-guard-none) )'],
    [SWEEP, '((lsof -ti:1 | xargs kill -0) )'],
    [PKILL, 'echo $((pkill -0 flow-guard-none) )'],
    [PKILL, "((echo '))'; pkill -0 flow-guard-none) )"],
    [PKILL, '(( $(pkill -0 flow-guard-none; echo 1) ))'],
    [PKILL, 'echo ${x:-${y:-$(pkill -0 flow-guard-none)}}'],
    [SWEEP, 'kill -0 ${x:-$(lsof -ti:1)}'],
    [PKILL, "$'pk\\ill' -0 flow-guard-none"],
    [PKILL, "$'pkill\\0x' -0 flow-guard-none"],
    [KILLALL, "$'kil\\lall' -0 flow-guard-none"],
    [SWEEP, "$'\\lsof' -ti:1 | xargs kill -0"],
  ];
  for (const [rule, command] of d189) {
    refused(guard(command, work), rule, `main: ${command}`);
    refused(
      guard(command, work, 'tester'),
      rule === SWEEP ? sweepInTester : rule,
      `tester: ${command}`,
    );
  }
  for (const command of [
    "echo $'\\c'; lsof -nP -iTCP:1 -sTCP:LISTEN -t # '",
    '((lsof -nP -iTCP:1 -sTCP:LISTEN -t) )',
    "$'\\lsof' -nP -iTCP:1 -sTCP:LISTEN -t",
  ]) {
    for (const agent of ['developer', 'tester', 'tester-process']) {
      refused(guard(command, work, agent), lsofInside(agent), `${agent}: ${command}`);
    }
    passed(guard(command, work), `main: ${command}`);
  }

  // What runs nothing refused passes: a comment whose body quotes a merge
  // path, as the procedure's result comments may, a filter that names one,
  // arithmetic that is arithmetic, and a quote the shells read as one.
  for (const command of [
    'gh api repos/o/r/issues/151/comments --field body="see repos/o/r/pulls/151/merge"',
    'gh api repos/o/r/issues/127/comments -f body=repos/o/r/pulls/151/merge',
    'gh api repos/o/r/issues/127/comments --raw-field=body=pulls/5/merge',
    'gh api repos/o/r/issues/127/comments -F body=@notes.md -H "X-Note: pulls/5/merge"',
    'gh api repos/o/r/issues/127/comments --input body.json -q pulls/5/merge',
    'gh api repos/o/r/pulls/5 --jq "select(.url | test(\\"pulls/5/merge\\"))"',
    'gh api repos/o/r/pulls/5 -tpulls/5/merge',
    'gh api --method PATCH repos/o/r/issues/127 -F body=@/tmp/d.md',
    'gh api "repos/o/r/issues/$N/comments"',
    'echo $(( 1 + 2 ))',
    '(( i = 1 + 2 ))',
    'for ((i=0;i<2;i++)); do echo $i; done',
    'x=$(( 1<<2 )); echo $x',
    'echo $(( (1)+(2) ))',
    '((((gh pr merge 5) )) )',
    'echo ${x:-default} ${#x} ${x%%.*} ${x:-$(git rev-parse HEAD)}',
    "echo ${x:-'$(gh pr merge 5)'}",
    "echo $'a\\c'b'; gh pr merge 5 # '",
    "echo $'line\\none'",
  ]) {
    passed(guard(command, work), command);
  }

  // `$(( '))'` nested in itself: the quote hides the parentheses that make
  // each level two subshells, so the guard reads each level as arithmetic
  // first and then again as subshells. A few levels are read to the end; a
  // command built to make it read the same text again past its allowance —
  // a million characters and four times the command — is one it cannot read,
  // and passes inside the hook's time, as every such command does.
  const selfNested = (depth) =>
    `${"echo $(( '))' ".repeat(depth)}; pkill node${') ) '.repeat(depth)}`;
  refused(guard(selfNested(3), work), PKILL, 'three levels');
  refused(guard(selfNested(40), work), PKILL, 'forty levels');
  for (const depth of [1_000, 10_000]) {
    unchecked(
      guard(selfNested(depth), work),
      `${depth} levels`,
      /arithmetic the guard cannot tell from subshells/,
    );
  }
});

// A variable holding one segment of the merge path: a segment holding a
// parameter expansion, alone or with text of its own, stands for any one
// segment — `pulls`, the number, `merge`, an empty one, `.`, `..` — whose
// value may also end the path with a `?`; a value holding several segments
// stays out of reach, so the procedure's forms with a variable in them pass.
// And two readings beside it: zsh counts the parentheses after `((` without
// regard to quotes, so `((pkill -0 x ')' ))` runs pkill in a subshell there,
// where bash reads arithmetic; and a body or output option joined to its
// value, `-fa=1`, `-Hx` or `-q.x`, takes no word after it, so the endpoint
// that follows is read.
test('a segment of an API path that a parameter expansion gives may stand for any one segment of a merge path', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);

  for (const command of [
    'M=merge; gh api -X PUT repos/o/r/pulls/5/$M',
    'M=merge; gh api -X PUT "repos/o/r/pulls/5/$M"',
    'M=merge; gh api -X PUT repos/o/r/pulls/5/${M}',
    'A=pulls; gh api -X PUT repos/o/r/$A/5/merge',
    'M=merge; gh api -X PUT repos/o/r/pulls/5/$M.json',
    'echo merge >/dev/null; gh api -X PUT repos/o/r/pulls/5/$_',
    'M=mer; gh api -X PUT repos/o/r/pulls/5/${M}ge',
    'set -- merge; gh api -X PUT repos/o/r/pulls/5/$1',
    // The rest of the parameter expansions, the number, and two at once.
    'set -- merge; gh api -X PUT repos/o/r/pulls/5/$@',
    'set -- merge; gh api -X PUT "repos/o/r/pulls/5/$*"',
    'I=5; gh api -X PUT repos/o/r/pulls/$I/merge',
    'A=pulls M=merge; gh api --method PUT repos/o/r/$A/5/$M',
    'M=merge; gh api -X PUT "repos/o/r/pulls/5/${M};x"',
    // A value that is empty, `..` or ends the path with a `?`.
    'E=; gh api -X PUT repos/o/r/pulls/5/merge/$E',
    'D=..; gh api -X PUT repos/o/r/pulls/5/merge/x/$D',
    "Q='?'; gh api -X PUT repos/o/r/pulls/5/merge/$Q/comments",
    // A body or output option joined to its value takes no word after it.
    'gh api -fa=1 repos/o/r/pulls/5/merge',
    'gh api -Hx repos/o/r/pulls/5/merge',
    'gh api -q.x repos/o/r/pulls/5/merge',
    // zsh's `((`, which counts no quote.
    "((gh pr merge 5 ')' ))",
  ]) {
    for (const agent of [undefined, 'developer']) {
      refusedMerge(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
  for (const agent of [undefined, 'tester']) {
    refused(
      guard("((pkill -0 flow-guard-none ')' ))", work, agent),
      PKILL,
      `${agent ?? 'main'}: zsh's ((`,
    );
  }

  // The procedure's forms with a variable in them, and others like them: the
  // path ends in a segment of its own that no merge's does, or holds too few
  // segments around the variable to be one.
  for (const command of [
    'gh api "repos/o/r/issues/$N/comments"',
    'gh api --method PATCH repos/o/r/issues/$N -F body=@$FILE',
    'gh api --method POST repos/o/r/issues/$N/comments --field body=@$FILE',
    'gh api --method GET "repos/o/r/issues/$N/comments?sort=created&per_page=100"',
    'gh api --method GET repos/o/r/actions/runs/$ID',
    'gh api --method GET repos/o/r/git/ref/tags/v$VERSION',
    'gh api repos/o/r/pulls/$PR',
    'gh api repos/o/r/pulls/$PR/comments --field body=x',
    'gh api repos/o/r/pulls/${PR}/reviews',
    'gh api $ENDPOINT',
  ]) {
    passed(guard(command, work), command);
  }
});

// The forms a hostile check would find past the merge rule: a glob that builds
// a command name, gh's group word, its `pr` subcommand or a segment of an
// endpoint, which the shells expand to `gh`, `merge` or `pulls` when a file
// matches it, and zsh also a group in the middle of a name, `g(h)`; a variable
// or a substitution that gives a merge mutation in a GraphQL query or an
// auto-merge option to `gh pr create`; a percent-escape split across a
// variable; and gh's own placeholders, which gh fills in from the repository,
// `{branch}` on a branch named `merge`. A glob is matched against the fixed
// names the rules read, never refused as such, so `[ … ]`, a `[` never closed,
// a quoted `?` and `./scripts/*.sh` still pass.
test('a glob, a variable or a substitution that may build a merge, a split percent-escape and a gh placeholder are refused', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  // The file a glob in the endpoint matches.
  mkdirSync(join(work, 'repos', 'o', 'r', 'pulls', '5'), { recursive: true });
  writeFileSync(join(work, 'repos', 'o', 'r', 'pulls', '5', 'merge'), '');

  const merges = [
    // A glob in a command name, read as every name it could match.
    '/opt/homebrew/bin/g[h] pr merge 5',
    '/opt/homebrew/bin/g? pr merge 5',
    'g[h] pr merge 5',
    'G[H] pr merge 5',
    '/opt/homebrew/bin/g* pr merge 5',
    '/opt/homebrew/bin/g[!x] pr merge 5',
    '/opt/homebrew/bin/g[[:alpha:]] pr merge 5',
    '/usr/bin/en? gh pr merge 5',
    '/usr/bin/xarg? gh pr merge < ids',
    'g(h) pr merge 5',
    // …in gh's group word and its `pr` subcommand.
    'gh pr merg? 5',
    'gh pr merg[e] 5',
    'gh pr m*e 5',
    'gh p? merge 5',
    'gh pr mer(g)e 5',
    // …and in an endpoint that is no provable GET: a segment a glob may make
    // `merge` or `pulls`, or a glob that may make any path — zsh's `**`, and
    // bash 3.2's `.*`, which matches `..`.
    'gh api -X PUT repos/o/r/pulls/5/merg[e]',
    'gh api -X PUT repos/o/r/pulls/5/MERG[E].json',
    'gh api -X PUT repos/o/r/pull[s]/5/merge',
    'gh api -X PUT repos/o/r/pulls/5/merge/x/[.][.]',
    'gh api -X PUT repos/o/r/pulls/5/merg[e];x',
    'gh api -X PUT repos/o/r/**/merge',
    'gh api -X PUT repos/o/r/pulls/5/merge/x/.*',
    'gh api -X PUT repos/o/r/pulls/5/merg?',
    'gh api --method POST repos/o/r/pulls/5/m*',
    'gh api -X PUT repos/o/r/pulls/5/%6[d]erge',
    'gh api -X PUT repos/o/r/pulls/5/merg[%e]',
    // A variable or a substitution in a GraphQL query, or in a field's key.
    'Q=mergePullRequest; gh api graphql -f query="mutation { $Q(input: {pullRequestId: \\"PR_kw\\"}) { clientMutationId } }"',
    'gh api graphql -f query="mutation { $(echo mergePullRequest)(input: {pullRequestId: \\"PR_kw\\"}) { clientMutationId } }"',
    'gh api graphql --raw-field query=$Q',
    'gh api graphql --field=query=$Q',
    'gh api graphql -fquery=$Q',
    'gh api graphql -F "query=@$FILE"',
    'gh api graphql -f "$K=$V"',
    'gh api graphql -f ${K}=mutation',
    'gh api graphql -q .data -f query=$Q',
    // …as an auto-merge option among the words of `gh pr create`.
    'A=--auto-merge; gh pr create --title x $A',
    'gh pr create --title x $(echo --auto-merge)',
    'gh pr create --title x "$A"',
    'gh pr create --title x --auto-merge$E',
    'gh pr create --draft -$A',
    // A percent-escape split across a variable, in any decoding round.
    'P=%; gh api -X PUT repos/o/r/pulls${P}2F5${P}2Fmerge',
    'P=2F; gh api -X PUT repos/o/r/pulls%${P}5%${P}merge',
    'P=F; gh api -X PUT repos/o/r/pulls%2${P}5%2${P}merge',
    'P=2F; gh api -X PUT repos/o/r/pulls%25${P}5%25${P}merge',
    // An expansion that a `..` after it takes away leaves a merge's path
    // written out, refused for every method.
    'X=a; gh api -X PUT repos/o/r/pulls/$X/../5/merge',
    'X=a; gh api repos/o/r/pulls/$X/../5/merge',
    'X=a; gh api --method GET repos/o/r/pulls/$X/../5/merge',
  ];
  // gh's placeholders, each of the six, with `-X PUT` and `--method POST`.
  for (const name of ['{owner}', '{repo}', '{branch}', ':owner', ':repo', ':branch']) {
    merges.push(`gh api -X PUT repos/o/r/pulls/5/${name}`);
    merges.push(`gh api --method POST repos/o/r/pulls/5/${name}`);
    merges.push(`gh api -X PUT repos/o/r/${name}/5/merge`);
  }
  merges.push('gh api -X PUT "repos/{owner}/{repo}/pulls/5/x{branch}"');
  merges.push('gh api -X PUT repos/o/r/pulls/5/{BRANCH}');
  for (const command of merges) {
    for (const agent of [undefined, 'developer']) {
      refusedMerge(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // A glob that can be no guarded name, a bracket that is no glob, a quoted
  // `?`, a value that cannot be an auto-merge option, a GraphQL query
  // without a merge mutation, a placeholder in a provable GET, and the forms
  // the procedures write with variables.
  for (const command of [
    '[ -n "$PR" ] && gh pr view "$PR"',
    '[[ -n $PR ]] && echo yes',
    '[ "$a" = "[" ] && echo yes',
    'echo [',
    './scripts/*.sh',
    './scripts/gh-*.sh pr merge 5',
    'g[h pr merge 5',
    'gh issue list --repo owner/repo --state open --label state:ready --json number,title,labels,body,updatedAt --limit 200',
    'gh issue view 57 --json body --jq \'(.body // "") | length\'',
    'gh api --method GET "repos/o/r/issues/$N/comments?sort=created"',
    'gh api --method GET "repos/o/r/pulls/5/comments?per_page=100"',
    'gh pr view [5]',
    'gh pr li?t',
    'gh pr create --title "$T" --body "$(cat <<\'EOF\'\n## What\n\ngh pr merge 5\nEOF\n)"',
    'gh pr create --title=$T --head "$B"',
    'gh pr create -t"$T" -b "$D" -B main -H "$B" -l "$L" --reviewer "$R" --repo "$REPO" --draft',
    'gh pr create --repo "$REPO" --draft --base main --head "$BRANCH" --title "$TITLE" --body-file "$FILE"',
    'gh pr edit "$PR" --repo "$REPO" --body-file "$FILE"',
    'gh pr edit "$PR" --title "$T"',
    'gh pr view "$PR" --repo "$REPO" --json number,state,isDraft,headRefOid',
    'gh pr comment "$PR" --repo "$REPO" --body-file "$FILE"',
    'gh pr ready "$PR" --repo "$REPO"',
    'gh pr checks "$PR" --repo "$REPO"',
    'git push origin "$BRANCH"',
    'git push --set-upstream origin "$BRANCH"',
    'gh api graphql -f query=\'query($o: String!) { repository(owner: $o, name: "r") { id } }\' -f o="$O"',
    'gh api graphql -f query="query { viewer { login } }" -F first=$N',
    'gh api repos/{owner}/{repo}/pulls/5/{branch}',
    'gh api --method GET "repos/{owner}/{repo}/pulls?head={owner}:{branch}"',
    'gh api -X PUT repos/o/r/issues/5/x:branches',
    'gh api -X PUT repos/o/r/issues/5/{branches}',
    'gh api -X PUT repos/o/r/pulls/5/[n]otes',
    'P=%; gh api -X PUT repos/o/r/issues/$P/comments',
  ]) {
    for (const agent of [undefined, 'developer']) {
      passed(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
});

// A GET merges nothing, so an endpoint that provably sends one reads an
// expansion, a glob and a placeholder in it as an id — paths the procedures
// may write with two variables would otherwise be refused as a merge — while
// a merge's path written out, and an endpoint a substitution gives, stay
// refused for every method. A provable GET has, as its last `-X`/`--method`,
// a written-out `GET`, or no method and no body option, and only
// `--paginate`, `--slurp`, `-i`/`--include`, `--silent`, `--cache`,
// `--hostname`, `-H`/`--header`, `-q`/`--jq` and `-t`/`--template` besides,
// each written out; anything else keeps the reading of every other method,
// where an expansion may be any segment.
test('a provable GET reads an expansion, a glob and a placeholder in its endpoint as an id; every other request keeps the merge rule', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  const paths = [
    'repos/$REPO/issues/$N/comments',
    'repos/$REPO/pulls/$PR/comments',
    'repos/$OWNER/$NAME/issues/$N',
    'repos/$REPO/commits/$SHA/check-runs',
  ];
  for (const path of paths) {
    for (const command of [
      `gh api ${path}`,
      `gh api "${path}"`,
      `gh api --method GET ${path}`,
      `gh api --paginate --slurp ${path}`,
      `gh api --method GET ${path} --paginate --jq '.[].id'`,
      `gh api -X GET ${path}`,
      `gh api -XGET ${path}`,
      `gh api -X=GET ${path}`,
      `gh api --method=GET ${path}`,
      `gh api -X PUT -X GET ${path}`,
      `gh api -i --include --silent --hostname github.com -H 'Accept: application/vnd.github+json' ${path}`,
      `gh api -iH 'Accept: application/json' --header='X-A: b' ${path}`,
      `gh api -q '.[] | .id' -t '{{.id}}' --cache 1h ${path}`,
      `gh api -iq.id ${path}`,
      `gh api --paginate -- ${path}`,
    ]) {
      for (const agent of [undefined, 'developer']) {
        passed(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
      }
    }
    for (const command of [
      `gh api --method PUT ${path}`,
      `gh api --method POST ${path}`,
      `gh api --method DELETE ${path}`,
      `gh api -XPUT ${path}`,
      `gh api -X=PUT ${path}`,
      `gh api --method=PUT ${path}`,
      `gh api -X GET -X PUT ${path}`,
      `gh api -iXPUT ${path}`,
      `gh api --method "$M" ${path}`,
      `gh api -X$M ${path}`,
      `gh api --method=$M ${path}`,
      // A method in lower case is not read as GET.
      `gh api -X get ${path}`,
      // An option outside the allow-list, or one whose value or name a
      // variable gives, which may be `--method=PUT`.
      `gh api --verbose ${path}`,
      `gh api -h ${path}`,
      `gh api -p corsair ${path}`,
      `gh api --jq "$Q" ${path}`,
      `gh api -H "$HEADER" ${path}`,
      `gh api --paginate=$P ${path}`,
      `gh api --met$H=GET ${path}`,
      `gh api "$OPTION" ${path}`,
      `gh api ${path} "$OPTION"`,
      // A body option, which makes POST the default.
      `gh api -f x=1 ${path}`,
      `gh api -F x=1 ${path}`,
      `gh api --raw-field x=1 ${path}`,
      `gh api --field x=1 ${path}`,
      `gh api --input body.json ${path}`,
      `gh api -fx=1 ${path}`,
      `gh api -if x=1 ${path}`,
    ]) {
      for (const agent of [undefined, 'developer']) {
        refusedMerge(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
      }
    }
  }

  // A merge's path written out, with a number an expansion, a glob or a
  // placeholder gives, and an endpoint a substitution gives: refused for
  // every method, a GET's among them.
  for (const command of [
    'gh api "repos/o/r/pulls/$PR/merge"',
    'gh api --method GET "repos/o/r/pulls/$PR/merge"',
    'gh api --paginate repos/o/r/pulls/${PR}/merge.json',
    'gh api repos/o/r/pulls/$((PR))/merge',
    'gh api repos/o/r/pulls/${PR:-5}/merge',
    'gh api repos/{owner}/{repo}/pulls/{branch}/merge',
    'gh api repos/:owner/:repo/pulls/:branch/merge',
    'gh api repos/o/r/pulls/[5]/merge',
    'gh api repos/o/r/pulls/5/merge?',
    'gh api repos/o/r/pulls/5/merge????',
    'gh api repos/o/r/pulls/$X/x/../merge',
    'gh api "repos/o/r/issues/$(echo 5)/comments"',
    'gh api --method GET repos/o/r/issues/`echo 5`/comments',
    'gh api repos/o/r/issues/${x:-$(echo 5)}/comments',
  ]) {
    for (const agent of [undefined, 'developer']) {
      refusedMerge(guard(command, work, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // In a GET, a glob is the text gh gets when it matches nothing, and an id
  // otherwise; a placeholder and a value next to `%` are ids.
  for (const command of [
    'gh api repos/o/r/pulls/5/merg[e]',
    'gh api repos/o/r/pulls/5/{branch}',
    'gh api repos/o/r/pulls/{branch}/comments',
    'gh api --method GET repos/o/r/pulls${P}2F5${P}2Fmerge',
    'gh api repos/o/r/pulls/$X/../5/comments',
  ]) {
    passed(guard(command, work), command);
  }
});

// The merge rule reads every word of a gh command, and the push rule every
// word of a git push, so they are given made-up input built to break them, at
// growing sizes, inside the hook's time limit, with one line on stderr. The
// fixture is the project, on `main`, so a push reaches the push rule.
test('the merge rule answers made-up commands at any size, within the hook timeout', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  const run = (unit, size) => unit.repeat(Math.max(1, Math.floor(size / unit.length)));

  const shapes = [
    [
      'a token of one letter repeated',
      (size) => `DELIVERY_LOCK=${run('a', size)} gh pr merge 1`,
      2,
    ],
    ['many assignments before a merge', (size) => `${run('A=1 ', size)}gh pr merge 1`, 2],
    ['many views, then a merge', (size) => `${run('gh pr view 1; ', size)}gh pr merge 1`, 2],
    ['many views', (size) => run('gh pr view 1; ', size), 0],
    ['an API path of many segments', (size) => `gh api ${run('a/', size)}pulls/1/merge`, 2],
    [
      'an API path ending in slashes',
      (size) => `gh api repos/o/r/pulls/1/merge${run('/', size)}`,
      2,
    ],
    ['an API path of slashes', (size) => `gh api ${run('/', size)}x`, 0],
    ['an API path of merge segments', (size) => `gh api ${run('merge/', size)}x`, 0],
    [
      'an API path of ./ segments',
      (size) => `gh api repos/o/r/pulls/1/${run('./', size)}merge`,
      2,
    ],
    [
      'an API path of x/.. pairs',
      (size) => `gh api repos/o/r/pulls/1/${run('x/../', size)}merge`,
      2,
    ],
    ['an API path of .. alone', (size) => `gh api ${run('../', size)}merge`, 0],
    ['an API path of escaped slashes', (size) => `gh api ${run('%2F', size)}pulls/1/merge`, 2],
    [
      'an API path of escaped percents',
      (size) => `gh api repos/o/r/pulls/1/${run('%25', size)}`,
      0,
    ],
    ['an API path of escapes that never end', (size) => `gh api ${run('%', size)}merge`, 0],
    ['a fragment of hashes', (size) => `gh api repos/o/r/pulls/1/merge${run('#', size)}`, 2],
    ['a query of question marks', (size) => `gh api x/pulls/1/merge?${run('?', size)}`, 2],
    [
      'a GraphQL query, the mutation last',
      (size) => `gh api graphql -f query='${run('a ', size)}mergePullRequest'`,
      2,
    ],
    [
      'a GraphQL query, the auto-merge mutation last',
      (size) => `gh api graphql -f query='${run('a ', size)}enablePullRequestAutoMerge'`,
      2,
    ],
    [
      'a GraphQL query without it',
      (size) => `gh api graphql -f query='${run('merge Pull Request ', size)}'`,
      0,
    ],
    ['a pull request number of one digit repeated', (size) => `gh pr merge ${run('1', size)}`, 2],
    ["$'…' of hex escapes", (size) => `gh pr $'${run('\\x41', size)}' 1`, 0],
    ["$'…' of escapes that end it in merge", (size) => `gh pr $'${run('\\x', size)}merge' 1`, 0],
    ["$'…' of backslashes", (size) => `gh pr $'${run('\\\\', size)}' 1`, 0],
    ["$'…' of \\c", (size) => `gh pr $'${run('\\c', size)}' 1`, 0],
    ["$'…' of \\u escapes", (size) => `gh pr $'${run('\\u0041', size)}' 1`, 0],
    ["$'…' never closed after a merge", (size) => `gh pr merge 1 $'${run('\\x41', size)}`, 2],
    ["$'…' never closed after a view", (size) => `gh pr view 1 $'${run('\\x41', size)}`, 0],
    ['$"…" of words', (size) => `gh pr $"${run('a ', size)}" 1`, 0],
    [
      'a ${…} of quoted braces, then a merge',
      (size) => `echo \${x:-${run('"}"', size)}}; gh pr merge 1`,
      2,
    ],
    [
      "a ${…} of $'\\'', then a merge",
      (size) => `echo \${x:-${run("$'\\''", size)}}; gh pr merge 1`,
      2,
    ],
    ['a quote never closed after a merge', (size) => `gh pr merge 1 '${run('a', size)}`, 2],
    [
      'a quote never closed, gh and merge only named far in',
      (size) => `echo '${run('a ', size)} gh pr merge`,
      2,
    ],
    ['a quote never closed, gh only named far in', (size) => `echo '${run('a ', size)} gh`, 0],
    [
      'an API path of many segments, the last a substitution',
      (size) => `gh api ${run('a/', size)}$(echo merge)`,
      2,
    ],
    [
      'many comment bodies quoting a merge path',
      (size) =>
        `gh api repos/o/r/issues/1/comments ${run('-f body=x/pulls/1/merge ', size)}`,
      0,
    ],
    [
      "$'\\c' many times, then a merge",
      (size) => `echo ${run("$'\\c' ", size)}; gh pr merge 1`,
      2,
    ],
    ["$'…' of escapes zsh drops", (size) => `gh pr $'${run('\\q', size)}' 1`, 0],
    [
      "$'…' that zsh reads as merge, then NULs",
      (size) => `gh pr $'\\merge${run('\\0', size)}' 1`,
      2,
    ],
    [
      '((…) ) nested, every level two subshells',
      (size) => {
        const depth = Math.max(1, Math.floor(size / 6));
        return `${'(('.repeat(depth)}gh pr merge 1${') ) '.repeat(depth)}`;
      },
      2,
    ],
    [
      'arithmetic that turns out to be subshells, many times, then a merge',
      (size) => `${run("((echo '))'; true) ); ", size)}gh pr merge 1`,
      2,
    ],
    [
      'arithmetic of many substitutions, then a merge',
      (size) => `echo $(( ${run('$(echo 1) + ', size)}1 )); gh pr merge 1`,
      2,
    ],
    [
      'a merge inside nested ${…}',
      (size) => {
        const depth = Math.max(1, Math.floor(size / 6));
        return `echo ${'${x:-'.repeat(depth)}$(gh pr merge 1)${'}'.repeat(depth)}`;
      },
      2,
    ],
    // Segments a parameter expansion gives, with a method that can merge;
    // an endpoint with no method and no body option is a provable GET, where
    // an expansion is an id, and these shapes with no method are its twins
    // below.
    ['an API path of expansions', (size) => `gh api -X PUT ${run('$x/', size)}`, 2],
    [
      // Any of them may end the path with a `?` its value holds.
      'an API path of expansions, then a segment no merge ends in',
      (size) => `gh api -X PUT ${run('$x/', size)}comments`,
      2,
    ],
    [
      'an API path of expansions and .., then a segment no merge ends in',
      (size) => `gh api ${run('$x/../', size)}comments`,
      0,
    ],
    [
      'pulls many times, then an expansion',
      (size) => `gh api -X PUT ${run('pulls/', size)}$M`,
      2,
    ],
    [
      'a merge path, then pairs a variable holding .. may fold',
      (size) => `gh api -X PUT repos/o/r/pulls/1/merge/${run('x/$D/', size)}`,
      2,
    ],
    [
      'an issue path whose number is many expansions',
      (size) => `gh api repos/o/r/issues/${run('${x}', size)}/comments`,
      0,
    ],
    ['many --auto-merge=false', (size) => `gh pr create ${run('--auto-merge=false ', size)}`, 0],
    // A glob in a command name, in gh's words or in an endpoint; a variable
    // or a substitution in a GraphQL query or a `gh pr create` word; a split
    // percent-escape; a placeholder; and a provable GET.
    [
      'a command name of stars before gh',
      (size) => `/opt/homebrew/bin/${run('*', size)}gh pr merge 1`,
      2,
    ],
    ['a command name of question marks', (size) => `${run('?', size)} pr merge 1`, 0],
    ['a command name of stars and question marks', (size) => `${run('*?', size)} pr merge 1`, 0],
    ['a command name with a long bracket', (size) => `g[${run('a', size)}h] pr merge 1`, 2],
    ['a command name with a bracket never closed', (size) => `g[${run('h', size)} pr merge 1`, 0],
    ['a command name of brackets', (size) => `${run('[g]', size)} pr merge 1`, 0],
    [
      'a command name with a long negated bracket',
      (size) => `/opt/homebrew/bin/g[!${run('x', size)}] pr merge 1`,
      2,
    ],
    ['a command name of zsh groups', (size) => `g${run('(h)', size)} pr merge 1`, 2],
    [
      'many wrappers a glob may be, then gh',
      (size) => `${run('/usr/bin/en? ', size)}gh pr merge 1`,
      2,
    ],
    ['a gh subcommand of stars', (size) => `gh pr ${run('*', size)} 1`, 2],
    ['a gh subcommand of question marks', (size) => `gh pr ${run('?', size)} 1`, 0],
    [
      'an endpoint segment with a long bracket that may be merge',
      (size) => `gh api -X PUT repos/o/r/pulls/1/merg[${run('e', size)}]`,
      2,
    ],
    [
      'an endpoint of bracket segments that can be no merge segment',
      (size) => `gh api -X PUT ${run('[n]otes/', size)}x`,
      0,
    ],
    ['an endpoint of brackets never closed', (size) => `gh api -X PUT x/${run('[[', size)}`, 0],
    ['an endpoint of zsh **', (size) => `gh api -X PUT ${run('**/', size)}merge`, 2],
    ['an endpoint of placeholders', (size) => `gh api -X PUT ${run('{owner}/', size)}x`, 2],
    ['an endpoint of old placeholders', (size) => `gh api -X PUT ${run(':repo/', size)}x`, 2],
    ['a GET endpoint of placeholders', (size) => `gh api ${run('{branch}/', size)}x`, 0],
    ['an endpoint of near placeholders', (size) => `gh api -X PUT ${run(':repos/', size)}x`, 0],
    [
      'an endpoint of escaped percents, then a variable',
      (size) => `gh api -X PUT repos/o/r/${run('%25', size)}$P`,
      2,
    ],
    [
      'an endpoint of escaped slashes and variables a .. folds',
      (size) => `gh api -X PUT ${run('%2F$P/../', size)}comments`,
      0,
    ],
    [
      'a GraphQL query long, then a variable',
      (size) => `gh api graphql -f query="${run('a ', size)}$Q"`,
      2,
    ],
    [
      'a GraphQL query with many variables of its own',
      (size) => `gh api graphql -f query='query { a }' ${run('-f p="$P" ', size)}`,
      0,
    ],
    ['gh pr create with many titles', (size) => `gh pr create ${run('--title "$T" ', size)}`, 0],
    [
      'gh pr create with many words, then a variable',
      (size) => `gh pr create ${run('-t x ', size)}$A`,
      2,
    ],
    ['a GET endpoint of expansions', (size) => `gh api ${run('$x/', size)}`, 0],
    ['a GET endpoint of expansions, then comments', (size) => `gh api ${run('$x/', size)}comments`, 0],
    [
      'a GET endpoint of pulls many times, then an expansion',
      (size) => `gh api ${run('pulls/', size)}$M`,
      0,
    ],
    [
      'a GET endpoint of a merge path, then pairs a variable holding .. may fold',
      (size) => `gh api repos/o/r/pulls/1/merge/${run('x/$D/', size)}`,
      0,
    ],
    [
      'a GET endpoint of expansions a .. takes away, then a merge path',
      (size) => `gh api ${run('$x/../', size)}pulls/$X/merge`,
      2,
    ],
    [
      'a GET with many allowed options',
      (size) => `gh api ${run('--paginate -H a:b ', size)}repos/o/r/issues/$I/comments/$N`,
      0,
    ],
    [
      'many GET methods, then a PUT',
      (size) => `gh api ${run('-X GET ', size)}-X PUT repos/o/r/issues/$I/comments/$N`,
      2,
    ],
    [
      'bundled flags, then a PUT',
      (size) => `gh api -${run('i', size)}XPUT repos/o/r/issues/$I/comments/$N`,
      2,
    ],
    // The push rule (D26), in the project's repository on `main`.
    ['many refspecs, the last to main', (size) => `git push origin ${run('chore/a ', size)}main`, 2],
    ['many refspecs to task branches', (size) => `git push origin ${run('chore/a ', size)}`, 0],
    [
      'many push options, then a force',
      (size) => `git push ${run('-o ci.skip ', size)}--force origin chore/a`,
      2,
    ],
    [
      'many push options, then a task branch',
      (size) => `git push ${run('-o ci.skip ', size)}origin chore/a`,
      0,
    ],
    [
      'many push options, then HEAD on main',
      (size) => `git push ${run('-o ci.skip ', size)}origin HEAD`,
      2,
    ],
    [
      'git with many -C, then a push a glob may be, to main',
      (size) => `git ${run('-C a ', size)}pu?h origin main`,
      2,
    ],
    [
      'git with many -C, then a push of HEAD',
      (size) => `git ${run('-C a ', size)}push origin HEAD`,
      0,
    ],
    ['a long pattern refspec', (size) => `git push origin 'refs/heads/${run('*', size)}'`, 2],
    ['a long pattern refspec of tags', (size) => `git push origin 'refs/tags/${run('*', size)}'`, 0],
    ['a refspec with a long bracket', (size) => `git push origin mai[${run('n', size)}]`, 2],
    ['a long refspec near main', (size) => `git push origin ${run('main', size)}`, 0],
    ['a refspec of many +', (size) => `git push origin ${run('+', size)}chore/a`, 2],
    ['a long group of short options', (size) => `git push -${run('uv', size)} origin chore/a`, 0],
    [
      'a long group of short options with a force',
      (size) => `git push -${run('uv', size)}f origin chore/a`,
      2,
    ],
    [
      'many variables as refspecs',
      (size) => `git push origin ${run('"$B" ', size)}`,
      0,
    ],
  ];
  for (const [what, build, exit] of shapes) {
    for (const size of [1_000, 10_000, 100_000]) {
      const result = guard(build(size), work);
      const label = `${what}, ${size} characters`;
      assert.equal(result.status, exit, `${label}: exit ${result.status}, ${brief(result.stderr)}`);
      assert.equal(result.stdout, '', label);
      assert.ok(result.stderr.length < 1000, `${label}: ${result.stderr.length} characters`);
      assert.ok(result.stderr.split('\n').length <= 2, `${label}: more than one line`);
      assert.doesNotMatch(result.stderr, /an error of its own/, label);
    }
  }
});


// A guard that cannot read its input must not stall an unattended run: it
// exits 0, whatever the input holds.
// The guard run with its input written only after `delay` milliseconds, or
// never when `delay` is null: what it printed, how it exited and how long it
// took. A guard still running after 20 s is killed, so a hang fails the test
// instead of holding it.
const runLate = (stdin, delay, env) =>
  new Promise((done) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [GUARD], { cwd: tmpdir(), env });
    // Writing to a guard that has already ended is not this test's failure.
    child.stdin.on('error', () => {});
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const write = delay === null ? null : setTimeout(() => child.stdin.end(stdin), delay);
    const stop = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (status) => {
      clearTimeout(write);
      clearTimeout(stop);
      done({ status, stderr, elapsed: Date.now() - startedAt });
    });
  });

// A hook that runs past its limit does not block, and holds the Bash call
// until then; the guard must end well inside it whatever happens around it.
// Here its input arrives just before the guard stops waiting for it, and the
// `git` on PATH never answers, for a command with commits and pushes in many
// directories: the wait for stdin counts against the time left for git.
test('the guard ends inside the hook timeout when its input is late and git never answers', async (t) => {
  const { work } = repository(t);
  const shim = mkdtempSync(join(tmpdir(), 'flow-guard-git-'));
  t.after(() => rmSync(shim, { recursive: true, force: true }));
  // `exec`, so the process the guard's time limit stops is `sleep` itself.
  writeFileSync(join(shim, 'git'), '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 });
  const directories = Array.from({ length: 12 }, (_, k) => join(work, `d${k}`));
  for (const directory of directories) mkdirSync(directory);
  const env = {
    ...process.env,
    PATH: `${shim}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    CLAUDE_PROJECT_DIR: work,
  };
  delete env.FLOW_CONFIG;
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: work,
    tool_input: {
      command: directories
        .map((d) => `git -C ${d} commit -m x; git -C ${d} push origin main`)
        .join('; '),
    },
  });

  // Both at once: they are separate processes, and the test takes the longer.
  const [late, never] = await Promise.all([runLate(input, 2_800, env), runLate(input, null, env)]);
  assert.equal(late.status, 0, late.stderr);
  assert.equal(late.stderr, '', 'git had no answer, so there was nothing to refuse');
  assert.ok(
    late.elapsed < HOOK_TIMEOUT_MS - 1_500,
    `the guard took ${late.elapsed} ms of the hook's ${HOOK_TIMEOUT_MS}`,
  );

  assert.equal(never.status, 0);
  assert.match(never.stderr, /^guard-bash did not check this command: its input did not arrive\n$/);
  assert.ok(never.elapsed < HOOK_TIMEOUT_MS / 2, `the guard waited ${never.elapsed} ms`);
});

test('input the guard cannot parse passes with exit 0', () => {
  const cwd = tmpdir();

  // Not a hook input at all.
  for (const stdin of ['', ' ', 'pkill node', '{', '{"tool_input":{"command":"pkill node"}']) {
    unchecked(runGuard(stdin), `stdin ${JSON.stringify(stdin)}`, NOT_JSON);
  }

  // JSON without a Bash command in it.
  for (const input of [
    null,
    42,
    'pkill node',
    [],
    ['pkill node'],
    {},
    { tool_name: 'Bash' },
    { tool_name: 'Bash', tool_input: null },
    { tool_name: 'Bash', tool_input: 'pkill node' },
    { tool_name: 'Bash', tool_input: {} },
    { tool_name: 'Bash', tool_input: { command: 42 } },
    { tool_name: 'Bash', tool_input: { command: ['pkill', 'node'] } },
    { tool_name: 'Bash', tool_input: { command: { text: 'pkill node' } } },
    { tool_name: 'Write', tool_input: { command: 'pkill node' } },
  ]) {
    passed(runGuard(JSON.stringify(input)), `input ${JSON.stringify(input)}`);
  }

  // A command the shell itself would not read to its end.
  for (const command of [
    "pkill 'node",
    'pkill "node',
    'pkill $(node',
    'pkill `node',
    'pkill "$(node)',
    "pkill $'node",
    'pkill ${node',
    'pkill $((1 + ',
    '(pkill node',
    'pkill node <<',
    "pkill node; echo 'never closed",
    'echo "`pkill node` and `"',
    'echo `echo $(echo `pkill node`)`',
  ]) {
    for (const agent of [undefined, 'tester']) {
      unchecked(guard(command, cwd, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // Fields the guard does not need may be missing or of any type.
  refused(runGuard(JSON.stringify({ tool_input: { command: 'pkill node' } })), PKILL, 'bare input');
  refused(
    runGuard(
      JSON.stringify({
        tool_name: 'Bash',
        cwd: 42,
        agent_type: ['tester'],
        permission_mode: null,
        tool_input: { command: 'killall node', timeout: 'x', run_in_background: 'yes' },
      }),
    ),
    KILLALL,
    'fields of the wrong type',
  );
  passed(
    runGuard(JSON.stringify({ tool_name: 'Bash', cwd: 42, tool_input: { command: 'git commit' } })),
    'a commit with no usable cwd',
  );
});

// The splitter reads text a model wrote, so it is given commands made up to
// break it — nesting never closed, one separator repeated, one enormous word —
// at three growing sizes. It must give the same answer at each, inside the
// hook's time limit (`runGuard` ends a run that passes it, which fails the
// exit check here), and say no more on stderr than its one line. The sizes are
// 1,000, 10,000 and 100,000 characters; the directory chains, whose cost grew
// with the square of their length before the guard bounded them, also run at
// 1,000,000, where that growth passes the hook's limit. The rest would prove
// at 1,000,000 what they prove at 100,000, and every run costs CI minutes.
test('the guard answers made-up commands built to break it, at any size, within the hook timeout', (t) => {
  const nowhere = join(tmpdir(), 'flow-guard-no-such-directory');
  // A repository on `main` that is the project, for the shapes that commit.
  const { work } = repository(t);
  const inProject = guardFor(work);
  // `unit` repeated to about `size` characters.
  const run = (unit, size) => unit.repeat(Math.max(1, Math.floor(size / unit.length)));
  // `inner` wrapped in `open` … `close`, to about `size` characters in all.
  const nested = (open, inner, close, size) => {
    const depth = Math.max(1, Math.floor(size / (open.length + close.length)));
    return `${open.repeat(depth)}${inner}${close.repeat(depth)}`;
  };

  const SIZES = [1_000, 10_000, 100_000];
  const LONG = [10_000, 100_000, 1_000_000];

  // What is built, the command at a size, the exit it must get at every size —
  // 2 where a segment does begin with a refused command, 0 where the command
  // only names one or is never closed — and, for some, their sizes.
  const shapes = [
    ['$( opened and never closed', (size) => `pkill node ${run('$(', size)}`, 0],
    ['( opened and never closed', (size) => `pkill node; ${run('( ', size)}`, 0],
    ['a single quote never closed', (size) => `pkill node '${run('a', size)}`, 0],
    ['a double quote never closed', (size) => `pkill node "${run('a ', size)}`, 0],
    ['arithmetic never closed', (size) => `pkill node $((${run('(', size)}`, 0],
    ['a ${ never closed', (size) => `pkill node \${x:-${run('{', size)}`, 0],
    ['pkill inside nested $( )', (size) => nested('$(', 'pkill node', ')', size), 2],
    ['pkill inside nested "$( )"', (size) => nested('"$(', 'pkill node', ')"', size), 2],
    ['pkill inside nested subshells', (size) => nested('( ', 'pkill node', ' )', size), 2],
    // `((` is arithmetic only where the shells read it so; a substitution in
    // arithmetic or in `${…}` runs; `$'\c'` ends at its quote.
    ['pkill inside nested ((…) )', (size) => nested('((', 'pkill node', ') ) ', size), 2],
    ['arithmetic nested deep', (size) => `echo $((${nested('(', '1', ')', size)}))`, 0],
    [
      'pkill inside nested $(( $( … ) ))',
      (size) => nested('$(( $(', 'pkill node', ') ))', size),
      2,
    ],
    ['pkill inside nested ${x:-$( … )}', (size) => nested('${x:-$(', 'pkill node', ')}', size), 2],
    ["$'\\c' many times, then pkill", (size) => `echo ${run("$'\\c' ", size)}; pkill node`, 2],
    [
      'arithmetic that turns out to be subshells, many times, then pkill',
      (size) => `${run("((echo '))'; true) ); ", size)}pkill node`,
      2,
    ],
    ['lsof inside nested kill $( )', (size) => nested('kill $(', 'lsof -ti:1', ')', size), 2],
    ['a name inside nested $( )', (size) => nested('$(', 'echo pkill', ')', size), 0],
    ['a run of ; before pkill', (size) => `${run(';', size)} pkill node`, 2],
    ['a run of && before pkill', (size) => `true ${run('&&', size)} pkill node`, 2],
    ['a run of line breaks before pkill', (size) => `${run('\n', size)}pkill node`, 2],
    ['a run of spaces before pkill', (size) => `${run(' ', size)}pkill node`, 2],
    ['a run of backslashes before pkill', (size) => `${run('\\\\', size)}; pkill node`, 2],
    ['a run of || between lsof and kill', (size) => `lsof -t ${run('||', size)} kill 1`, 0],
    ['one long word before pkill', (size) => `${run('a', size)}; pkill node`, 2],
    ['one long word made of pkill', (size) => `echo ${run('pkill', size)}`, 0],
    ['one long quoted word naming pkill', (size) => `echo "${run('pkill; ', size)}"`, 0],
    ['a long pipeline from lsof to kill', (size) => `${run('lsof -t | ', size)}kill`, 2],
    ['a long pipeline of kills after lsof', (size) => `lsof -t${run(' | kill', size)}`, 2],
    ['a long pipeline from lsof to cat', (size) => `lsof -t${run(' | cat', size)}`, 0],
    ['many segments that only name pkill', (size) => run('echo pkill; ', size), 0],
    [
      'many here-documents before pkill',
      (size) => `cat ${run('<<a ', size / 2)}\n${run('a\n', size / 4)}pkill node`,
      2,
    ],
    ['a here-document never ended', (size) => `cat <<EOF\n${run('pkill node\n', size)}`, 0],
    ['a long comment', (size) => `echo done #${run('; pkill node', size)}`, 0],
    ['many case patterns', (size) => run('pkill) ', size), 0],
    ['many redirections before pkill', (size) => `echo ${run('2>&1 ', size)}; pkill node`, 2],
    ['many assignments before pkill', (size) => `${run('A=1 ', size)}pkill node`, 2],
    ['many wrappers before pkill', (size) => `${run('sudo -n ', size)}pkill node`, 2],
    ['many runners before pkill', (size) => `${run('timeout 5 nice -n 1 ', size)}pkill node`, 2],
    // Each relative `cd`, `pushd` or `git -C` lengthens the directory the
    // guard tracks; without its bounds these grew with the square of the size.
    [
      'a chain of cd a; before a commit',
      (size) => `${run('cd a; ', size)}git commit -m x`,
      0,
      LONG,
    ],
    ['git with a run of -C a', (size) => `git ${run('-C a ', size)}commit -m x`, 0, LONG],
    [
      'a chain of pushd b && before a commit',
      (size) => `${run('pushd b && ', size)}git commit -m x`,
      0,
      LONG,
    ],
    [
      'cd a and cd .. in turn before a commit',
      (size) => `${run('cd a; cd ..; ', size)}git commit`,
      0,
      LONG,
    ],
    [
      'cd a and cd .. in turn under a path near the longest',
      (size) => `cd ${'d/'.repeat(1990)}d; ${run('cd a; cd ..; ', size)}git commit`,
      0,
      LONG,
    ],
    ['a chain of cd a; before pkill', (size) => `${run('cd a; ', size)}pkill node`, 2, LONG],
    // One `read` filling a great many variables: their list must not be
    // spread into a call, whose arguments V8 limits.
    ['pkill, then a read of many names', (size) => `pkill node; read ${run('a ', size)}`, 2, LONG],
    [
      'pkill, then a while read of many names',
      (size) => `pkill node; while read ${run('a ', size)}; do :; done`,
      2,
      LONG,
    ],
    ['case statements never closed', (size) => `${run('case x in ', size)}pkill node`, 0],
    [
      'case items naming pkill',
      (size) => `case x in ${run('(pkill|killall) echo;; ', size)}esac`,
      0,
    ],
    ['[[ never closed', (size) => `${run('[[ ', size)}pkill node`, 0],
    ['[[ ]] with many groups', (size) => `[[ x == ${run('(pkill|a) ', size)}]] && echo`, 0],
    // The sweep rule follows variables and files across the command line.
    ['many lsof variables, then a kill', (size) => `${run('p=$(lsof -t); ', size)}kill $p`, 2],
    ['an lsof file, then many kills', (size) => `lsof -t > f; ${run('kill $(cat f); ', size)}`, 2],
    [
      'a chain of variables from lsof to kill',
      (size) => {
        const count = Math.max(1, Math.floor(size / 16));
        const chain = Array.from({ length: count }, (_, k) => `v${k + 1}=$v${k}`).join('; ');
        return `v0=$(lsof -t); ${chain}; kill $v${count}`;
      },
      2,
    ],
    [
      'the same chain written backwards, past the rounds the guard follows',
      (size) => {
        const count = Math.max(9, Math.floor(size / 16));
        const chain = Array.from({ length: count }, (_, k) => `v${k}=$v${k + 1}`).join('; ');
        return `kill $v0; ${chain}; v${count}=$(lsof -t)`;
      },
      0,
    ],
    [
      'many kills of other PIDs after lsof',
      (size) => `lsof -t > f; ${run('kill $(cat g); ', size)}`,
      0,
    ],
    [
      'a long ${ } before pkill',
      (size) => `echo \${x:-${nested('{', 'pkill', '}', size)}}; pkill node`,
      2,
    ],
    [
      'many commits in one directory that does not exist',
      (size) => run(`git -C ${nowhere} commit -m x; cd ${nowhere} && git commit; `, size),
      0,
    ],
    [
      'commits in many directories that do not exist',
      (size) =>
        Array.from({ length: Math.ceil(size / 50) }, (_, k) => `git -C ${nowhere}/${k} commit`)
          .join('; ')
          .slice(0, size),
      0,
    ],
    [
      'a long commit message naming every rule',
      (size) => `git -C ${nowhere} commit -m "${run('pkill; killall; lsof | xargs kill\n', size)}"`,
      0,
    ],
    // D9's names in any letter case, and a glob or a zsh group
    // that builds one, at size; the commits run in the project's `main`.
    ['stars before pkill', (size) => `/usr/bin/${run('*', size)}pkill -0 x`, 2],
    ['pkill with a long bracket', (size) => `/usr/bin/pkil[${run('a', size)}l] -0 x`, 2],
    ['pkill with a long negated bracket', (size) => `/usr/bin/pkil[!${run('a', size)}] -0 x`, 2],
    ['a name of question marks', (size) => `${run('?', size)} -0 x`, 0],
    ['a name of brackets', (size) => `/usr/bin/pk${run('[i]', size)}ll -0 x`, 0],
    ['a name of zsh groups', (size) => `/usr/bin/pk${run('(i)', size)}ll -0 x`, 2],
    ['many assignments before PKILL', (size) => `${run('A=1 ', size)}PKILL -0 x`, 2],
    [
      'many wrappers a glob may be before KillAll',
      (size) => `${run('/usr/bin/en? ', size)}KillAll -0 x`,
      2,
    ],
    [
      'a long pipeline from LSOF to xargs KILL',
      (size) => `LSOF -ti:1 | ${run('cat | ', size)}xargs KILL -0`,
      2,
    ],
    [
      'stars in lsof inside kill $( )',
      (size) => `kill -0 $(/usr/sbin/lso${run('*', size)}f -ti:1)`,
      2,
    ],
    [
      'lsof with a long bracket, then xargs kill',
      (size) => `/usr/sbin/lso[${run('f', size)}] -ti:1 | xargs kill -0`,
      2,
    ],
    [
      'lsof, then stars in xargs',
      (size) => `lsof -ti:1 | /usr/bin/xarg${run('*', size)} kill -0`,
      2,
    ],
    ['many names a glob can be no D9 name', (size) => run('./scripts/*.sh; ', size), 0],
    ['many [ ] tests', (size) => run('[ -n "$x" ] && ', size) + 'echo', 0],
    [
      'many assignments before GI[T] commit on main',
      (size) => `${run('A=1 ', size)}GI[T] commit --dry-run`,
      2,
      SIZES,
      true,
    ],
    [
      'git with many -c before comm?t on main',
      (size) => `git ${run('-c a.b=c ', size)}comm?t --dry-run`,
      2,
      SIZES,
      true,
    ],
    [
      'GIT with a commit message naming every rule, on main',
      (size) => `GIT commit --dry-run -m "${run('PKILL; KillAll; LSOF | xargs KILL\n', size)}"`,
      2,
      SIZES,
      true,
    ],
  ];

  for (const [what, build, exit, sizes = SIZES, project = false] of shapes) {
    for (const size of sizes) {
      const result = project ? inProject(build(size), work) : guard(build(size), nowhere);
      const label = `${what}, ${size} characters`;
      assert.equal(
        result.status,
        exit,
        `${label}: exit ${result.status}${result.error ? `, ${result.error.code}` : ''}, ${brief(result.stderr)}`,
      );
      assert.equal(result.stdout, '', label);
      assert.ok(
        result.stderr.length < 500,
        `${label}: ${result.stderr.length} characters on stderr`,
      );
      assert.ok(result.stderr.split('\n').length <= 2, `${label}: more than one line on stderr`);
      assert.doesNotMatch(result.stderr, /an error of its own/, label);
    }
  }
});

// The outside review is the main session's (D12), so inside a
// sub-agent the guard refuses the script, its helper and `codex` itself, in
// the spellings it reads. A sub-agent is told by `agent_id`, which only a
// sub-agent's hook input carries; a main session started with `claude --agent`
// carries `agent_type` alone and is not refused. The commands are text handed
// to the guard; none of them is run, the outside review least of all.
const REVIEW_SH = '.claude/scripts/outside-review.sh';
const REVIEW_MJS = '.claude/scripts/outside-review.mjs';
const OUTSIDE_INSIDE =
  /inside a sub-agent\. The outside review is the main session's to run, and Codex's allowance and login are the owner's: run neither here, and say in your report that the outside review is due\./;
const UNREAD_OUTSIDE =
  /a command that names `outside-review` or `codex` and that the guard cannot read to its end \([^)]+\), inside a sub-agent, where the outside review cannot be told apart\./;
const SUB_AGENTS = [
  'developer',
  'tester',
  'tester-process',
  'general-purpose',
  'Explore',
  'made-up',
];
// The main session: no agent at all, or started with `--agent`.
const MAIN_SESSIONS = [
  undefined,
  { agent_type: 'developer' },
  { agent_type: 'tester' },
  { agent_type: 'general-purpose' },
  { agent_type: 'tester', agent_id: null },
];
const sessionName = (agent) =>
  agent === undefined ? 'main' : typeof agent === 'string' ? agent : JSON.stringify(agent);

// The line cites D12, whose rule it holds.
function refusedOutside(result, label, rule = OUTSIDE_INSIDE) {
  refused(result, rule, label);
  assert.match(result.stderr, /, D12\]\n$/, `${brief(label)}: the line does not cite D12`);
}

// Every spelling of a run of the review, of its helper or of Codex that the
// guard reads: by the script's name in any letter case — and with `ſ`, which
// macOS's file system folds into `s` — through each shell after its options,
// sourced, run by its path, fed on standard input, after a directory a
// variable or a substitution gives, behind the wrappers, and inside
// substitutions, subshells and pipelines.
const OUTSIDE_RUNS = [
  `sh ${REVIEW_SH} /tmp/artifact.txt /tmp/issue.md /tmp/review.md`,
  `cd /tmp/wt && sh ${REVIEW_SH} /tmp/artifact.txt /tmp/issue.md /tmp/review.md`,
  `sh ${REVIEW_SH} --reported install`,
  `sh ${REVIEW_SH} --reported`,
  `bash ${REVIEW_SH} --reported signIn`,
  `zsh ${REVIEW_SH} --reported credits`,
  `dash ${REVIEW_SH} --reported chatgpt`,
  `ksh ${REVIEW_SH}`,
  `/bin/sh ${REVIEW_SH} --reported install`,
  `/bin/bash -e ${REVIEW_SH}`,
  `SH ${REVIEW_SH}`,
  `Bash ${REVIEW_SH}`,
  `sh -x ${REVIEW_SH}`,
  `sh -eu ${REVIEW_SH}`,
  `bash -o pipefail ${REVIEW_SH}`,
  `bash -eo pipefail ${REVIEW_SH}`,
  `bash -oe pipefail ${REVIEW_SH}`,
  `zsh -onoglob ${REVIEW_SH}`,
  `ksh -o noglob ${REVIEW_SH}`,
  // ksh 93u+ takes `-T`'s mask from the rest of the group or the next word and
  // runs the script after it; bash and zsh read `-T` as a flag and the script
  // as their operand.
  `ksh -T 0 ${REVIEW_SH}`,
  `ksh -xT 0 ${REVIEW_SH} --reported install`,
  `ksh -T0 ${REVIEW_SH}`,
  `ksh +T 0 ${REVIEW_SH}`,
  `bash -T ${REVIEW_SH}`,
  `zsh -T ${REVIEW_SH}`,
  `bash +o posix ${REVIEW_SH}`,
  `bash -O extglob ${REVIEW_SH}`,
  `bash +O extglob ${REVIEW_SH}`,
  `bash --norc --noprofile ${REVIEW_SH}`,
  `bash --rcfile /dev/null ${REVIEW_SH}`,
  `bash --init-file /dev/null ${REVIEW_SH}`,
  `bash --rcfile ${REVIEW_SH} -i`,
  `zsh --emulate sh ${REVIEW_SH}`,
  `sh -- ${REVIEW_SH}`,
  `sh - ${REVIEW_SH}`,
  `sh -n +n ${REVIEW_SH}`,
  `bash -i ${REVIEW_SH}`,
  `bash -l ${REVIEW_SH} --reported install`,
  `. ${REVIEW_SH}`,
  `source ${REVIEW_SH}`,
  `. ./${REVIEW_SH}`,
  `source -- ${REVIEW_SH}`,
  `./${REVIEW_SH} --reported install`,
  `${REVIEW_SH} --reported install`,
  `/Users/someone/project/${REVIEW_SH} /tmp/a /tmp/i /tmp/o`,
  `~/project/${REVIEW_SH}`,
  '.claude/scripts/OUTSIDE-REVIEW.SH --reported install',
  'sh .claude/scripts/Outside-Review.sh',
  'sh .claude/scripts/outſide-review.sh',
  `sh < ${REVIEW_SH}`,
  `bash -s < ${REVIEW_SH}`,
  `bash -s -- --reported install < ${REVIEW_SH}`,
  `sh 0< ${REVIEW_SH}`,
  `sh /dev/stdin < ${REVIEW_SH}`,
  `. /dev/stdin < ${REVIEW_SH}`,
  `sh /dev/fd/0 < ${REVIEW_SH}`,
  `bash -x /dev/fd/0 --reported install < ${REVIEW_SH}`,
  `source /dev/fd/0 < ${REVIEW_SH}`,
  `sh "$CLAUDE_PROJECT_DIR"/${REVIEW_SH} --reported install`,
  `sh "$CLAUDE_PROJECT_DIR/${REVIEW_SH}"`,
  `sh "\${ROOT}/${REVIEW_SH}"`,
  `sh $(git rev-parse --show-toplevel)/${REVIEW_SH}`,
  `"$(git rev-parse --show-toplevel)/${REVIEW_SH}" --reported install`,
  `$ROOT/${REVIEW_SH}`,
  `\`pwd\`/${REVIEW_SH}`,
  `sh ~/x/../${REVIEW_SH}`,
  'sh .claude/*/outside-review.sh',
  `env sh ${REVIEW_SH}`,
  `env -i PATH=/bin:/usr/bin sh ${REVIEW_SH}`,
  `exec sh ${REVIEW_SH}`,
  `exec -a review sh ${REVIEW_SH}`,
  `nohup sh ${REVIEW_SH} /tmp/a /tmp/i /tmp/o > /tmp/review.log 2>&1 &`,
  `timeout 60 sh ${REVIEW_SH}`,
  `timeout -s KILL 60 bash ${REVIEW_SH}`,
  `nice -n 5 sh ${REVIEW_SH}`,
  `time sh ${REVIEW_SH}`,
  `command sh ${REVIEW_SH}`,
  `sudo -u nobody sh ${REVIEW_SH}`,
  `caffeinate -i sh ${REVIEW_SH}`,
  `noglob sh ${REVIEW_SH}`,
  `builtin source ${REVIEW_SH}`,
  `ENV sh ${REVIEW_SH}`,
  `/usr/bin/en? sh ${REVIEW_SH}`,
  `echo install | xargs sh ${REVIEW_SH} --reported`,
  `xargs -n 1 sh ${REVIEW_SH} --reported < keys.txt`,
  `A=1 B=2 sh ${REVIEW_SH}`,
  `if sh ${REVIEW_SH} --reported install; then echo ok; fi`,
  `! sh ${REVIEW_SH}`,
  `{ sh ${REVIEW_SH}; }`,
  `(sh ${REVIEW_SH})`,
  `echo "$(sh ${REVIEW_SH} --reported install)"`,
  `echo \`sh ${REVIEW_SH}\``,
  `line=$(sh ${REVIEW_SH} --reported install)`,
  `sh ${REVIEW_SH} | tee /tmp/review.log`,
  `true && sh ${REVIEW_SH}`,
  `false || sh ${REVIEW_SH}`,
  `echo first; sh ${REVIEW_SH}`,
  `echo first\nsh ${REVIEW_SH}`,
  `cat <(sh ${REVIEW_SH})`,
  `echo \${x:-$(sh ${REVIEW_SH})}`,
  `sh '${REVIEW_SH}'`,
  `sh "${REVIEW_SH}"`,
  `sh $'${REVIEW_SH}'`,
  `sh .claude/scripts/outside\\-review.sh`,
  // The helper, run by `node` or loaded by it.
  `node ${REVIEW_MJS} /tmp/a /tmp/i /tmp/o`,
  `node ${REVIEW_MJS} --reported install`,
  `nodejs ${REVIEW_MJS}`,
  `/opt/homebrew/bin/node ${REVIEW_MJS}`,
  'NODE .claude/scripts/OUTSIDE-REVIEW.MJS',
  `node --no-warnings ${REVIEW_MJS}`,
  `node --title review ${REVIEW_MJS}`,
  `node -r ./pre.cjs ${REVIEW_MJS}`,
  `node --require ./pre.cjs ${REVIEW_MJS}`,
  `node --env-file .env ${REVIEW_MJS}`,
  `node --import ./${REVIEW_MJS} x.mjs`,
  `node --import=./${REVIEW_MJS} x.mjs`,
  `node -r ./${REVIEW_MJS} x.mjs`,
  // Each loader takes the next word as its value and loads it: the script
  // after a loader, the helper as one, and the helper after `=`.
  `node --import ./pre.mjs ${REVIEW_MJS}`,
  `node --loader ./pre.mjs ${REVIEW_MJS}`,
  `node --loader ./${REVIEW_MJS} x.mjs`,
  `node --loader=./${REVIEW_MJS} x.mjs`,
  `node --experimental-loader ./pre.mjs ${REVIEW_MJS}`,
  `node --experimental-loader ./${REVIEW_MJS} x.mjs`,
  `node --experimental-loader=./${REVIEW_MJS} x.mjs`,
  `node --require=./${REVIEW_MJS} x.mjs`,
  `node --test ${REVIEW_MJS}`,
  `node --test .claude/tests/a.test.mjs ${REVIEW_MJS}`,
  `node -- ${REVIEW_MJS}`,
  `node < ${REVIEW_MJS}`,
  `node - < ${REVIEW_MJS}`,
  `node /dev/fd/0 < ${REVIEW_MJS}`,
  `node "$(dirname "$0")/outside-review.mjs" --reported install`,
  `exec node "$ROOT/${REVIEW_MJS}"`,
  `./${REVIEW_MJS} --reported install`,
  `env node ${REVIEW_MJS}`,
  // Codex itself, any subcommand, any path.
  'codex',
  'codex exec --ephemeral --sandbox read-only -m gpt-6-astra -',
  'codex login status',
  'codex logout',
  'codex login',
  'codex app-server',
  'codex --version',
  '/opt/homebrew/bin/codex exec -',
  '/Applications/Codex.app/Contents/Resources/codex login status',
  'CODEX logout',
  'Codex login status',
  '=codex logout',
  "'codex' logout",
  '"codex" logout',
  "c''odex logout",
  'cod\\ex logout',
  "$'codex' logout",
  "$'\\x63odex' logout",
  // A directory a substitution gives is read by its written-out tail, which
  // Scope left as a limit for `codex` and the guard reads all the same.
  '"$(brew --prefix)/bin/codex" logout',
  'env -u OPENAI_API_KEY codex exec -',
  'OPENAI_API_KEY= codex exec -',
  'nohup codex exec - < /tmp/prompt.md > /tmp/codex.log 2>&1 &',
  'timeout 5 codex login status',
  'exec codex',
  'command codex logout',
  'echo y | codex login',
  'echo "$(codex login status)"',
  'echo `codex login status`',
  '(codex logout)',
  'status=$(codex app-server < /dev/null)',
  'xargs codex < /dev/null',
  'sudo codex logout',
  'codex exec - <<EOF\nreview this\nEOF',
  'git status; codex logout',
];

// What a sub-agent does with the script and its names that runs neither:
// reading it, quoting it, testing it from Node — which spawns the script where
// the hook does not see it — formatting it, looking `codex` up, the other
// scripts beside it, and names that are not the script's.
const OUTSIDE_PASSES = [
  `grep -n outside-review ${REVIEW_SH}`,
  'grep -rn "codex" docs .claude | head -20',
  `cat ${REVIEW_SH}`,
  `sed -n '1,40p' ${REVIEW_SH}`,
  `head -20 ${REVIEW_MJS}`,
  `wc -l ${REVIEW_SH} ${REVIEW_MJS}`,
  `git diff -- ${REVIEW_SH}`,
  `git diff origin/main -- ${REVIEW_SH} ${REVIEW_MJS}`,
  `git log -p -- ${REVIEW_SH}`,
  `git add ${REVIEW_SH} ${REVIEW_MJS}`,
  `git show HEAD:${REVIEW_SH}`,
  `git commit -m "docs: the main session runs sh ${REVIEW_SH}; codex logout is the owner's"`,
  `git commit -F - <<'EOF'\nsh ${REVIEW_SH} --reported install\ncodex logout\nEOF`,
  `gh pr comment 202 --body "the main session runs sh ${REVIEW_SH} --reported install; codex login status is its own"`,
  `echo sh ${REVIEW_SH} --reported install`,
  "printf '%s\\n' 'codex logout'",
  'echo "never codex, never sh .claude/scripts/outside-review.sh"',
  '# codex logout\necho no',
  `cat <<'EOF'\nsh ${REVIEW_SH}\ncodex logout\nEOF`,
  'node --test .claude/tests/guard-bash.test.mjs',
  'node --test .claude/tests/guard-bash.test.mjs .claude/tests/delivery-queue.test.mjs',
  `npx prettier --check ${REVIEW_SH} ${REVIEW_MJS}`,
  `node node_modules/prettier/bin/prettier.cjs --check ${REVIEW_MJS}`,
  `npx eslint ${REVIEW_MJS}`,
  'command -v codex',
  'command -V codex',
  'which codex',
  'type codex',
  'ls -la "$(dirname "$(command -v codex)")"',
  'test -x /opt/homebrew/bin/codex && echo present',
  'ps -o pid,ppid,command -ax | grep codex',
  'case "$1" in codex) echo no ;; esac',
  '[[ $name == codex ]] && echo no',
  'cat docs/tooling/codex.md',
  'git log --oneline --grep codex',
  'sh .claude/scripts/review-artifact.sh origin/main HEAD /tmp/artifact.txt',
  'sh .claude/scripts/tree-fingerprint.sh .',
  'sh .claude/scripts/delivery-preflight.sh',
  'node .claude/scripts/delivery-queue.mjs status',
  'node .claude/scripts/guard-bash.mjs < /tmp/input.json',
  `sh ${REVIEW_SH}.bak`,
  'sh .claude/scripts/outside-review-x.sh',
  'sh .claude/scripts/outside-review.shx',
  `./${REVIEW_SH}.bak --reported install`,
  `node ${REVIEW_MJS}.orig`,
  './codex.sh',
  'codexx logout',
  './codex-notes.md',
  `sh -n ${REVIEW_SH}`,
  `bash -n ${REVIEW_SH}`,
  `node --check ${REVIEW_MJS}`,
  `node -c ${REVIEW_MJS}`,
  `node -e 'console.log(1)' ${REVIEW_MJS}`,
  `sh -c 'echo hi' ${REVIEW_SH}`,
  // A shell's `-c` string is the indirection class's, a documented limit: the
  // name as the string passes, alone or in a group of options, as it would
  // were it the first operand of a shell read without `-c`.
  `sh -c ${REVIEW_SH}`,
  `bash -xc ${REVIEW_SH} --reported install`,
  `ksh -T 0 -c ${REVIEW_SH}`,
  // node runs no script file after a string to evaluate or print, a package's
  // script, its version or its help, the helper's name given as any of them.
  `node -e ${REVIEW_MJS}`,
  `node --eval ${REVIEW_MJS}`,
  `node --eval=${REVIEW_MJS}`,
  `node -p ${REVIEW_MJS}`,
  `node --print ${REVIEW_MJS}`,
  `node --run ${REVIEW_MJS}`,
  `node -v ${REVIEW_MJS}`,
  `node --version ${REVIEW_MJS}`,
  `node -h ${REVIEW_MJS}`,
  `node --help ${REVIEW_MJS}`,
  `node --v8-options ${REVIEW_MJS}`,
  `sh ./other.sh < ${REVIEW_SH}`,
  `xargs sh < ${REVIEW_SH}`,
  `node scripts/a.mjs < ${REVIEW_MJS}`,
  'npm test',
];

test('inside any sub-agent the guard refuses the outside review, its helper and codex, in every spelling it reads', (t) => {
  const { root, work } = repository(t);
  const worktree = join(root, 'work-worktrees', 'chore', 'task');
  git(work, 'worktree', 'add', '--quiet', '-b', 'chore/task', worktree);
  const guard = guardFor(work);

  // The rule reads no agent's name and no directory, so each spelling runs
  // inside `tester` and one other sub-agent in turn — `agent_id` alone among
  // them — and in the main session with no agent fields from the main
  // checkout and as one started with `--agent`, in turn, from a worktree,
  // where the permission system decides, as before. A few run in every one.
  const inside = [...SUB_AGENTS.filter((agent) => agent !== 'tester'), { agent_id: 'a1b2c3' }];
  const started = MAIN_SESSIONS.filter((agent) => agent !== undefined);
  OUTSIDE_RUNS.forEach((command, n) => {
    for (const agent of ['tester', inside[n % inside.length]]) {
      refusedOutside(guard(command, worktree, agent), `${sessionName(agent)}: ${command}`);
    }
    passed(guard(command, work, undefined), `main in the main checkout: ${command}`);
    const main = started[n % started.length];
    passed(guard(command, worktree, main), `${sessionName(main)} in a worktree: ${command}`);
  });
  for (const command of [
    `sh ${REVIEW_SH} /tmp/artifact.txt /tmp/issue.md /tmp/review.md`,
    `sh ${REVIEW_SH} --reported install`,
    `"$CLAUDE_PROJECT_DIR"/${REVIEW_SH} --reported install`,
    `bash -s < ${REVIEW_SH}`,
    `node ${REVIEW_MJS}`,
    'codex logout',
    'echo "$(codex login status)"',
  ]) {
    for (const agent of [...SUB_AGENTS, { agent_id: 'a1b2c3' }]) {
      refusedOutside(guard(command, worktree, agent), `${sessionName(agent)}: ${command}`);
    }
    for (const agent of MAIN_SESSIONS) {
      for (const cwd of [work, worktree]) {
        passed(guard(command, cwd, agent), `${sessionName(agent)} in ${cwd}: ${command}`);
      }
    }
  }

  // The rule names what it found by a fixed word, never by the command.
  refusedOutside(
    guard('codex logout', worktree, 'tester'),
    'codex',
    /`codex` inside a sub-agent\./,
  );
  refusedOutside(
    guard(`sh ${REVIEW_SH} --reported install`, worktree, 'tester'),
    'the script',
    /the outside review script, `outside-review\.sh`, inside a sub-agent\./,
  );
  refusedOutside(
    guard(`node ${REVIEW_MJS}`, worktree, 'tester'),
    'the helper',
    /the outside review's helper, `outside-review\.mjs`, inside a sub-agent\./,
  );
  // A substitution says so, as the other rules' lines do.
  refusedOutside(
    guard(`echo "$(sh ${REVIEW_SH})"`, worktree, 'developer'),
    'in a substitution',
    /It stands in a command substitution/,
  );

  // Each pass inside every sub-agent name in turn, and in the main session.
  OUTSIDE_PASSES.forEach((command, n) => {
    for (const agent of ['tester', inside[n % inside.length], undefined]) {
      passed(guard(command, worktree, agent), `${sessionName(agent)}: ${command}`);
    }
  });
});

// A command the guard cannot read to its end that names the review or Codex
// is refused inside a sub-agent, as the merge rule refuses one that names
// `gh` together with a merge; the main session leaves it to the permission system, with the
// debug note the guard gives anything it cannot read.
test('inside a sub-agent a command the guard cannot read that names the outside review or codex is refused', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  const unread = [
    `sh ${REVIEW_SH} 'never closed`,
    `cat ${REVIEW_SH} "never closed`,
    'codex logout "never closed',
    'echo $(codex login status',
    'echo `codex login status',
    `sh "\${ROOT/${REVIEW_SH}`,
    '(codex logout',
    `node ${REVIEW_MJS} $((1 + `,
    'codex exec - <<',
    "CODEX 'logout",
    "c'o'dex logout 'x",
    "outſide-review.sh 'x",
  ];
  for (const command of unread) {
    for (const agent of SUB_AGENTS) {
      refusedOutside(guard(command, work, agent), `${agent}: ${command}`, UNREAD_OUTSIDE);
    }
    for (const agent of MAIN_SESSIONS) {
      unchecked(guard(command, work, agent), `${sessionName(agent)}: ${command}`);
    }
  }
  // One that names neither passes there too, with its note; one that names
  // `gh` together with a merge is the merge rule's in every session.
  for (const command of ["echo 'never closed", 'cat docs/tooling/codex.md "x', "codexx 'x"]) {
    for (const agent of [...SUB_AGENTS, ...MAIN_SESSIONS]) {
      unchecked(guard(command, work, agent), `${sessionName(agent)}: ${command}`);
    }
  }
  for (const agent of [...SUB_AGENTS, ...MAIN_SESSIONS]) {
    refusedMerge(guard("gh pr merge 1; codex 'x", work, agent), sessionName(agent), UNREAD_GH);
  }
});

// What the command carries never reaches the line, and neither
// does what the input says the agent is, at any size and with a line break.
test('the outside review refusal never repeats the command or the agent, whatever their size', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  const secret = 'sk-made-up-0123456789abcdefSECRET';
  for (const command of [
    `sh ${REVIEW_SH} --reported ${secret}`,
    `codex login --api-key ${secret}`,
    `OPENAI_API_KEY=${secret} codex exec -`,
    `node ${REVIEW_MJS} ${secret}`,
    `codex login '${secret}`,
  ]) {
    const result = guard(command, work, 'tester');
    assert.equal(result.status, 2, command);
    assert.ok(!result.stderr.includes(secret), `the line repeats the secret: ${command}`);
    assert.ok(!result.stderr.includes('--reported'), `the line repeats the command: ${command}`);
  }

  for (const size of [1_000, 10_000, 100_000, 1_000_000]) {
    for (const [what, fields] of [
      ['a long agent_type', { agent_id: 'made-up', agent_type: 'x'.repeat(size) }],
      ['a long agent_id', { agent_id: 'y'.repeat(size), agent_type: 'tester' }],
      [
        'agent fields holding line breaks',
        {
          agent_id: `a\n${'z'.repeat(size)}`,
          agent_type: `tester\nguard-bash refused\n${'w'.repeat(size)}`,
        },
      ],
      ['a long agent_type alone', { agent_type: `tester\n${'v'.repeat(size)}` }],
    ]) {
      const label = `${what}, ${size} characters`;
      const result = guard(`sh ${REVIEW_SH} --reported install`, work, fields);
      if (fields.agent_id === undefined) {
        passed(result, label);
        continue;
      }
      refusedOutside(result, label);
      assert.ok(result.stderr.length < 500, `${label}: ${result.stderr.length} characters`);
      for (const letter of ['xxxx', 'yyyy', 'zzzz', 'wwww']) {
        assert.ok(!result.stderr.includes(letter), `${label}: the line repeats the agent`);
      }
    }
  }
});

// The shapes of this rule made up to break the guard, at the
// sizes of the guard's other hostile test — 1,000, 10,000 and 100,000, and
// 1,000,000 for those whose cost grows with a path's or an option run's length
// — each with the same exit at every size inside the hook's time limit, one
// line on stderr at most and never an error of the guard's own.
test('the outside review rule answers made-up commands at any size, within the hook timeout', (t) => {
  const { work } = repository(t);
  const guard = guardFor(work);
  const nowhere = join(tmpdir(), 'flow-guard-no-such-directory');
  const run = (unit, size) => unit.repeat(Math.max(1, Math.floor(size / unit.length)));
  const nested = (open, inner, close, size) => {
    const depth = Math.max(1, Math.floor(size / (open.length + close.length)));
    return `${open.repeat(depth)}${inner}${close.repeat(depth)}`;
  };
  const SIZES = [1_000, 10_000, 100_000];
  const LONG = [10_000, 100_000, 1_000_000];

  const shapes = [
    ['repeated shell options', (size) => `sh ${run('-x ', size)}${REVIEW_SH}`, 2, LONG],
    ['repeated value options', (size) => `bash ${run('-o pipefail ', size)}${REVIEW_SH}`, 2, LONG],
    ['one long group of options', (size) => `bash -${run('ex', size)} ${REVIEW_SH}`, 2, LONG],
    ['repeated ksh masks', (size) => `ksh ${run('-T 0 ', size)}${REVIEW_SH}`, 2, LONG],
    [
      'repeated node options',
      (size) => `node ${run('--no-warnings ', size)}${REVIEW_MJS}`,
      2,
      LONG,
    ],
    ['repeated node loaders', (size) => `node ${run('-r ./a.cjs ', size)}x.mjs`, 0, LONG],
    ['a long path', (size) => `sh ${run('a/', size)}outside-review.sh`, 2, LONG],
    ['a run of ../', (size) => `sh ${run('../', size)}${REVIEW_SH}`, 2, LONG],
    ['a long path to codex', (size) => `${run('/b', size)}/codex logout`, 2, LONG],
    ['a long path to a near miss', (size) => `sh ${run('a/', size)}outside-review.sh.bak`, 0, LONG],
    ['a long dynamic directory', (size) => `sh ${run('$A/', size)}outside-review.sh`, 2, LONG],
    ['a name a variable ends', (size) => `sh /x/outside-review${run('$A', size)}`, 0, LONG],
    ['many leading segments', (size) => `${run('true; ', size)}codex logout`, 2, LONG],
    ['many leading pipelines', (size) => `${run('echo a | ', size)}sh ${REVIEW_SH}`, 2],
    ['many segments naming codex', (size) => run('echo codex; ', size), 0],
    ['nested $( )', (size) => nested('$(', 'codex logout', ')', size), 2],
    ['nested "$( )"', (size) => nested('"$(', `sh ${REVIEW_SH}`, ')"', size), 2],
    ['nested subshells', (size) => nested('( ', `node ${REVIEW_MJS}`, ' )', size), 2],
    ['nested ${x:-$( )}', (size) => nested('${x:-$(', 'codex', ')}', size), 2],
    ['a name inside nested $( )', (size) => nested('$(', 'echo codex', ')', size), 0],
    ['many wrappers', (size) => `${run('env ', size)}codex logout`, 2, LONG],
    ['many runners', (size) => `${run('nohup timeout 5 ', size)}sh ${REVIEW_SH}`, 2],
    ['many assignments', (size) => `${run('A=1 ', size)}sh ${REVIEW_SH}`, 2, LONG],
    ['many input redirections', (size) => `sh ${run('< a ', size)}< ${REVIEW_SH}`, 2],
    // `t*` could be `time`, which runs the next word, or `timeout`, which
    // runs the one after: a shell at every other place.
    ['globs and shells in turn', (size) => `${run('t* sh ', size)}< ${REVIEW_SH}`, 2],
    ['one long word made of codex', (size) => `echo ${run('codex', size)}`, 0],
    [
      'a long commit message naming the review',
      (size) => `git -C ${nowhere} commit -m "${run(`sh ${REVIEW_SH}; codex logout\n`, size)}"`,
      0,
    ],
    ['an unread command naming codex', (size) => `codex logout '${run('a', size)}`, 2],
    ['an unread command naming the script', (size) => `cat ${REVIEW_SH} "${run('a ', size)}`, 2],
    ['an unread command naming neither', (size) => `echo '${run('a', size)}`, 0],
  ];

  for (const [what, build, exit, sizes = SIZES] of shapes) {
    for (const size of sizes) {
      const command = build(size);
      const label = `${what}, ${size} characters`;
      const result = guard(command, nowhere, 'tester');
      assert.equal(
        result.status,
        exit,
        `${label}: exit ${result.status}${result.error ? `, ${result.error.code}` : ''}, ${brief(result.stderr)}`,
      );
      assert.equal(result.stdout, '', label);
      assert.ok(
        result.stderr.length < 500,
        `${label}: ${result.stderr.length} characters on stderr`,
      );
      assert.ok(result.stderr.split('\n').length <= 2, `${label}: more than one line on stderr`);
      assert.doesNotMatch(result.stderr, /an error of its own/, label);
      if (exit === 2) assert.match(result.stderr, /, D12\]\n$/, label);
      // The main session reads the same command and lets it through.
      if (size === sizes[0]) {
        const main = guard(command, nowhere, { agent_type: 'tester' });
        assert.equal(main.status, 0, `main: ${label}: ${brief(main.stderr)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The push rule (D26)
// ---------------------------------------------------------------------------
//
// A private repository on GitHub Free has no branch protection, so the guard
// is what keeps a session from moving `main` by a push or rewriting history
// by force. It holds in the project's repository and its worktrees; `HEAD`,
// `@` and a push with no refspec are judged by the target directory's branch,
// as a commit is.

const PUSH_TAIL =
  /\. Push a task branch, by its name or as `HEAD` from its worktree, and without force: bring `origin\/main` in by a merge, or push rewritten history as a new branch; `main` moves only by the delivery queue's merge, `node \.claude\/scripts\/delivery-queue\.mjs merge <task> --token <token> --sha <sha>`\./;
const TO_MAIN = /^guard-bash refused this command: `git push` to `main`\. /;
const DELETE_MAIN = /^guard-bash refused this command: `git push --delete` of `main`\. /;
const FORCE = /^guard-bash refused this command: a force push\. /;
const MIRROR = /^guard-bash refused this command: `git push --mirror`, which pushes `main` with the rest\. /;
const ALL = /^guard-bash refused this command: `git push --all`, which pushes `main` with the rest\. /;
const MATCHING =
  /^guard-bash refused this command: `git push` of the matching refspec `:`, which pushes `main` with the rest\. /;
const headOnMain = (dir) =>
  new RegExp(
    `^guard-bash refused this command: \`git push\` of \`HEAD\` where the branch is \`main\` \\(${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\. `,
  );

// The line cites D26 and ends in what to do instead.
function refusedPush(result, rule, label) {
  refused(result, rule, label);
  assert.match(result.stderr, PUSH_TAIL, `${brief(label)}: not the push rule's tail`);
  assert.match(
    result.stderr,
    /\[PreToolUse hook \.claude\/scripts\/guard-bash\.mjs, D26\]\n$/,
    `${brief(label)}: the line does not cite D26`,
  );
}

test("the push rule refuses a push to main, a forced one and one of every branch in the project's repository", (t) => {
  const { root, work } = repository(t);
  const worktree = join(root, 'work-worktrees', 'chore', 'task');
  git(work, 'worktree', 'add', '--quiet', '-b', 'chore/task', worktree);
  const guard = guardFor(work);

  // From the task worktree, whose branch is not `main`: what the written-out
  // words make a push to `main`, a forced push or a push of every branch.
  const pushes = [
    [TO_MAIN, 'git push origin main'],
    [TO_MAIN, 'git push origin HEAD:main'],
    [TO_MAIN, 'git push origin chore/task:main'],
    [TO_MAIN, 'git push origin @:main'],
    [TO_MAIN, 'git push origin HEAD:refs/heads/main'],
    [TO_MAIN, 'git push origin refs/heads/main'],
    [TO_MAIN, 'git push origin heads/main'],
    [TO_MAIN, 'git push origin HEAD:heads/main'],
    [TO_MAIN, 'git push origin MAIN'],
    [TO_MAIN, 'git push origin "$SHA":main'],
    [TO_MAIN, 'git push origin HEAD:"main"'],
    [TO_MAIN, 'git push origin -- main'],
    [TO_MAIN, 'git push -o ci.skip origin main'],
    [TO_MAIN, 'git push --set-upstream origin main'],
    [TO_MAIN, 'git push --repo=origin main'],
    [TO_MAIN, "git push origin 'refs/heads/*'"],
    [TO_MAIN, "git push origin 'refs/heads/*:refs/heads/*'"],
    [TO_MAIN, 'git push origin "*"'],
    [TO_MAIN, 'git push origin mai[n]'],
    [TO_MAIN, 'git push origin ma?n'],
    [TO_MAIN, 'git push origin m(a)in'],
    [TO_MAIN, 'git push origin HEAD:refs/heads/ma*'],
    [TO_MAIN, "git push origin $'\\x6dain'"],
    // zsh drops the backslash of an escape it does not know.
    [TO_MAIN, "git push origin $'ma\\in'"],
    [TO_MAIN, 'GIT push origin main'],
    [TO_MAIN, 'git PUSH origin main'],
    [TO_MAIN, 'git pu?h origin main'],
    [TO_MAIN, '/usr/bin/git push origin main'],
    [TO_MAIN, 'env git push origin main'],
    [TO_MAIN, 'git -c push.default=current push origin main'],
    [TO_MAIN, 'git fetch origin && git push origin main'],
    [TO_MAIN, `git -C ${worktree} push origin main`],
    [TO_MAIN, `cd ${worktree} && git push origin main`],
    [DELETE_MAIN, 'git push origin :main'],
    [DELETE_MAIN, 'git push origin --delete main'],
    [DELETE_MAIN, 'git push --delete origin main'],
    [DELETE_MAIN, 'git push -d origin refs/heads/main'],
    [DELETE_MAIN, 'git push --del origin main'],
    [MATCHING, 'git push origin :'],
    [MATCHING, 'git push origin +:'],
    [FORCE, 'git push -f origin chore/task'],
    [FORCE, 'git push --force origin chore/task'],
    [FORCE, 'git push --force-with-lease origin chore/task'],
    [FORCE, 'git push --force-with-lease=chore/task:0123abc origin chore/task'],
    [FORCE, 'git push --force-if-includes --force-with-lease origin HEAD'],
    [FORCE, 'git push --force-w origin chore/task'],
    [FORCE, 'git push --forc origin chore/task'],
    [FORCE, 'git push -uf origin chore/task'],
    [FORCE, 'git push -fu origin HEAD'],
    [FORCE, 'git push -vfo ci.skip origin HEAD'],
    [FORCE, 'git push origin +chore/task'],
    [FORCE, 'git push origin +HEAD'],
    [FORCE, 'git push origin +HEAD:chore/task'],
    [FORCE, 'git push --push-option=ci.skip origin +chore/task'],
    [FORCE, 'git push --force$X origin chore/task'],
    [FORCE, 'git push origin +"$BRANCH"'],
    [FORCE, 'git push -f'],
    [MIRROR, 'git push --mirror origin'],
    [MIRROR, 'git push --mirror'],
    [MIRROR, 'git push --mir origin'],
    [ALL, 'git push --all origin'],
    [ALL, 'git push --branches origin'],
    [ALL, 'git push --al origin'],
  ];
  for (const [rule, command] of pushes) {
    for (const agent of [undefined, 'developer']) {
      refusedPush(guard(command, worktree, agent), rule, `${agent ?? 'main'}: ${command}`);
    }
  }
  // The same from the main checkout, and inside a substitution, which says so.
  refusedPush(guard('git push origin main', work), TO_MAIN, 'from the main checkout');
  const inSubstitution = guard('echo "$(git push origin main)"', worktree);
  refusedPush(inSubstitution, TO_MAIN, 'in a substitution');
  assert.match(inSubstitution.stderr, /It stands in a command substitution/);

  // A task branch by its name or as `HEAD`, a tag, and what only names a push.
  for (const command of [
    'git push origin HEAD',
    'git push --set-upstream origin HEAD',
    'git push -u origin HEAD',
    'git push origin @',
    'git push origin head',
    'git push',
    'git push origin',
    'git push origin chore/task',
    'git push --set-upstream origin chore/task',
    'git push origin chore/task:chore/task',
    'git push origin HEAD:refs/heads/chore/task',
    'git push origin refs/tags/v1.2.3',
    'git push origin v1.2.3',
    'git push --tags origin',
    'git push --follow-tags origin HEAD',
    "git push origin 'refs/tags/*'",
    'git push origin --delete chore/old',
    'git push origin :chore/old',
    'git push origin "$BRANCH"',
    'git push -u origin "$BRANCH"',
    'git push origin HEAD:"$BRANCH"',
    'git push origin "refs/tags/v$VERSION"',
    'git push --no-force-with-lease origin HEAD',
    'git push --no-force-if-includes origin HEAD',
    'git push --follow-tags --atomic origin chore/task',
    'git push -o ci.skip origin chore/task',
    'git push -o main origin chore/task',
    'git push --push-option main origin chore/task',
    'git push --dry-run origin chore/task',
    'git push origin mainline',
    'git push origin main-fix',
    'git push origin feature/main',
    'git push origin refs/heads/chore/main',
    `git -C ${worktree} push origin HEAD`,
    `cd ${worktree} && git push -u origin HEAD`,
    'git log origin/main..HEAD',
    'git pull origin main',
    'git fetch origin main',
    'git merge origin/main',
    'git rebase origin/main',
    'git show main',
    'echo git push origin main',
    'echo "never git push --force origin main"',
    'git commit -m "never git push origin main, never git push --force"',
    'grep -n "git push --force" docs/DELIVERY.md',
    "git commit -F - <<'EOF'\ngit push origin main\ngit push --force\nEOF",
  ]) {
    for (const agent of [undefined, 'developer']) {
      passed(guard(command, worktree, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
});

test("HEAD, @ and a push without a refspec are judged by the target directory's branch", (t) => {
  const { root, work } = repository(t);
  const worktree = join(root, 'work-worktrees', 'chore', 'task');
  git(work, 'worktree', 'add', '--quiet', '-b', 'chore/task', worktree);
  const guard = guardFor(work);

  // From the main checkout, which sits on `main`, or aimed at it.
  for (const [command, cwd] of [
    ['git push origin HEAD', work],
    ['git push --set-upstream origin HEAD', work],
    ['git push -u origin HEAD', work],
    ['git push origin @', work],
    ['git push origin head', work],
    ['git push', work],
    ['git push origin', work],
    ['git push -u origin', work],
    ['git push --follow-tags origin', work],
    ['GIT push origin HEAD', work],
    [`git -C ${work} push origin HEAD`, worktree],
    [`cd ${work} && git push`, worktree],
    [`cd ${worktree} && git status && cd ${work} && git push origin HEAD`, worktree],
    [`cd ${root} && cd work && git push origin HEAD`, worktree],
  ]) {
    for (const agent of [undefined, 'developer', 'tester']) {
      refusedPush(guard(command, cwd, agent), headOnMain(work), `${agent ?? 'main'}: ${command}`);
    }
  }

  // From the task worktree, or aimed at it; with an explicit refspec or tags
  // alone, the current branch does not matter.
  for (const [command, cwd] of [
    ['git push origin HEAD', worktree],
    ['git push --set-upstream origin HEAD', worktree],
    ['git push', worktree],
    ['git push origin', worktree],
    [`git -C ${worktree} push origin HEAD`, work],
    [`git -C ${worktree} push --set-upstream origin HEAD`, work],
    [`cd ${worktree} && git push -u origin HEAD`, work],
    [`(cd ${work} && git status); git push origin HEAD`, worktree],
    ['git push origin chore/task', work],
    ['git push origin refs/tags/v1.2.3', work],
    ['git push --tags origin', work],
    ['git push origin --delete chore/old', work],
    ['git push origin "$BRANCH"', work],
  ]) {
    for (const agent of [undefined, 'developer']) {
      passed(guard(command, cwd, agent), `${agent ?? 'main'}: ${command}`);
    }
  }

  // A directory the guard cannot know: its branch cannot be told, so `HEAD`
  // passes; the written-out forms are refused all the same.
  for (const command of [
    'cd "$WORKTREE" && git push origin HEAD',
    'cd "$WORKTREE" && git push',
    'git -C "$WORKTREE" push -u origin HEAD',
    `git --git-dir=${work}/.git push origin HEAD`,
  ]) {
    passed(guard(command, work), command);
  }
  for (const [rule, command] of [
    [TO_MAIN, 'cd "$WORKTREE" && git push origin main'],
    [TO_MAIN, 'git -C "$WORKTREE" push origin HEAD:main'],
    [FORCE, 'cd "$WORKTREE" && git push --force origin chore/task'],
    [MIRROR, `git --git-dir=${work}/.git push --mirror origin`],
  ]) {
    refusedPush(guard(command, worktree), rule, command);
  }

  // A detached HEAD is no branch, and pushes no `main`.
  git(work, 'checkout', '--quiet', '--detach');
  passed(guard('git push origin HEAD', work), 'a detached HEAD');
  passed(guard('git push', work), 'a detached HEAD, no refspec');
  refusedPush(guard('git push origin main', work), TO_MAIN, 'a detached HEAD, to main');
});

// Sessions build throwaway repositories, on `main`, to try a script out, and
// push into a bare one beside them: not the project's `main`.
test("the push rule holds in the project's repository, not in a throwaway one", (t) => {
  const { root, work } = repository(t);
  const other = repository(t).work;
  const guard = guardFor(work);

  for (const [command, cwd] of [
    ['git push origin main', other],
    ['git push --force origin main', other],
    ['git push --mirror origin', other],
    ['git push origin HEAD', other],
    ['git push', other],
    ['git push origin :main', other],
    [`git -C ${other} push origin main`, work],
    [`cd ${other} && git push -f origin HEAD`, work],
  ]) {
    for (const agent of [undefined, 'developer', 'tester']) {
      passed(guard(command, cwd, agent), `${agent ?? 'main'}: ${command}`);
    }
  }
  refusedPush(guard(`git -C ${work} push origin main`, other), TO_MAIN, 'the project, from the other');
  refusedPush(guard(`cd ${work} && git push`, other), headOnMain(work), 'HEAD in the project');
  // A directory that is no repository, or none at all: git answers nothing.
  passed(guard('git push origin main', root), 'not a repository');
  passed(guard('git push --force origin main', join(root, 'absent')), 'no such directory');

  // A copy of the guard with no `flow-config.mjs` beside it reads `main`;
  // without a project directory its own repository is the project.
  const copy = join(work, '.claude', 'scripts', 'guard-bash.mjs');
  mkdirSync(join(work, '.claude', 'scripts'), { recursive: true });
  copyFileSync(GUARD, copy);
  refusedPush(guardFor(null, copy)('git push origin main', work), TO_MAIN, 'a copy');
  passed(guardFor(null, copy)('git push origin main', other), 'a copy: the other');
  // The real guard's repository is this checkout, which neither fixture is.
  passed(guardFor(null)('git push origin main', work), 'the real guard, no project named');
});

// The main branch is the flow configuration's `project.mainBranch` (D23): the
// commit rule and the push rule read it, and fall back on `main` when the
// file is missing or names none git would take.
test('the commit and push rules take the main branch from the flow configuration', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-guard-trunk-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '--quiet', '--initial-branch=trunk');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'README.md'), 'fixture\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');
  const flow = (mainBranch) => {
    const path = join(root, `flow-${randomUUID()}.json`);
    writeFileSync(
      path,
      JSON.stringify({ project: { name: 'fixture', repo: 'owner/fixture', mainBranch } }),
    );
    return path;
  };

  const trunk = guardFor(work, GUARD, flow('trunk'));
  const ON_TRUNK = /`git commit` on `trunk` .*in a worktree cut from `origin\/trunk`/;
  refused(trunk('git commit -m x', work), ON_TRUNK, 'a commit on trunk');
  for (const command of [
    'git push origin trunk',
    'git push origin HEAD:refs/heads/trunk',
    'git push origin HEAD',
    'git push',
  ]) {
    const result = trunk(command, work);
    refused(result, /`trunk`/, command);
    assert.match(result.stderr, /, D26\]\n$/, command);
    assert.match(result.stderr, /`trunk` moves only by the delivery queue's merge/, command);
  }
  for (const command of ['git push origin main', 'git push origin HEAD:main']) {
    passed(trunk(command, work), `trunk is the main branch: ${command}`);
  }

  // `main` where the configuration cannot be read or names no branch.
  git(work, 'branch', '--quiet', '-m', 'trunk', 'main');
  for (const path of [join(root, 'absent.json'), flow(''), flow('two words'), flow('a\nb')]) {
    const guard = guardFor(work, GUARD, path);
    refused(guard('git commit -m x', work), ON_MAIN, `${path}: a commit`);
    refusedPush(guard('git push origin main', work), TO_MAIN, `${path}: a push`);
    passed(guard('git push origin trunk', work), `${path}: trunk`);
  }
  writeFileSync(join(root, 'not.json'), '{ not json');
  refusedPush(
    guardFor(work, GUARD, join(root, 'not.json'))('git push origin main', work),
    TO_MAIN,
    'a file that is not JSON',
  );
});
