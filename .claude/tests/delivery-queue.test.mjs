// The delivery queue, `.claude/scripts/delivery-queue.mjs` (D16), run as the
// delivery cycle runs it, against throwaway state: each fixture is a fresh
// `git init` with a bare repository standing in for origin, so the state lands
// under that fixture's git directory and never under this checkout's. The
// script runs from a copy beside a made-up area vocabulary, with a made-up
// `.claude/flow.json` named by FLOW_CONFIG. GitHub is a stand-in `gh` first on
// PATH that answers from a file, and the sessions' transcripts live under a
// temporary HOME, in the folder Claude Code names after the fixture's
// checkout. Nothing here reaches GitHub, the desktop app or a session's real
// transcript.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import {
  areasOfFile,
  conflict,
  declaredAreas,
  dependencies,
  globMatches,
  highestDecision,
  labelFault,
  liveness,
  MAX_WAIT_MINUTES,
  oneLine,
  parseState,
  pickOrder,
  priority,
  projectNames,
  readMutex,
  readVocabulary,
  takeOver,
  USAGE,
} from '../scripts/delivery-queue.mjs';
import { resumable } from '../scripts/fire-check.mjs';

const QUEUE_SOURCE = fileURLToPath(new URL('../scripts/delivery-queue.mjs', import.meta.url));
const CONFIG_SOURCE = fileURLToPath(new URL('../scripts/flow-config.mjs', import.meta.url));
const REPO = 'acme/widgets';

// A made-up project's areas: five hard ones, the rest ordinary.
const VOCABULARY = {
  bookkeeping: ['VERSION', 'CHANGELOG.md', 'docs/DECISIONS.md'],
  areas: [
    { name: 'migrations', hard: true, paths: ['server/migrations/**'] },
    { name: 'api-contract', hard: true, paths: ['shared/**', 'docs/API.md'] },
    {
      name: 'dependencies',
      hard: true,
      paths: ['package.json', 'package-lock.json', '*/package.json'],
    },
    { name: 'ci-deploy', hard: true, paths: ['.github/workflows/**', 'deploy/**', '*/Dockerfile'] },
    {
      name: 'delivery-process',
      hard: true,
      critical: false,
      paths: ['.claude/**', 'CLAUDE.md', 'docs/DELIVERY.md', '.github/ISSUE_TEMPLATE/**'],
    },
    { name: 'auth', hard: false, paths: ['server/src/auth/**', 'e2e/auth.spec.ts'] },
    {
      name: 'notifications',
      hard: false,
      paths: ['server/src/notifications/**', 'web/src/api/notifications*'],
    },
    { name: 'search', hard: false, paths: ['server/src/search/**'] },
    { name: 'billing', hard: false, paths: ['server/src/billing/**', 'shared/src/billing.ts'] },
    { name: 'server', hard: false, critical: true, about: 'the rest', paths: ['server/**'] },
    { name: 'web-account', hard: false, paths: ['web/src/pages/Account*', 'web/src/lib/account-*'] },
    { name: 'web', hard: false, paths: ['web/**'] },
    { name: 'docs', hard: false, paths: ['docs/**', 'README.md'] },
    { name: 'tooling', hard: false, paths: ['eslint.config.mjs', 'tools/**'] },
    { name: 'e2e', hard: false, paths: ['e2e/**'] },
    { name: 'operations', hard: false, paths: ['scripts/**'] },
  ],
};

const vocabularyDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'flow-areas-')));
after(() => rmSync(vocabularyDirectory, { recursive: true, force: true }));
const vocabularyFile = join(vocabularyDirectory, 'delivery-areas.json');
writeFileSync(vocabularyFile, JSON.stringify(VOCABULARY));
const vocabulary = readVocabulary(vocabularyFile);

// The folder Claude Code keeps a session's transcript in, named after the
// path the session started in.
const projectName = (path) => path.replace(/[^A-Za-z0-9]/g, '-');

const gitRun = (cwd, ...args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// A stand-in for gh: `issue list` answers the open issues of the file it is
// given that carry the `--label`, as gh does, up to `--limit`; `issue view
// <n>` one issue, or gh's failure for none; and `pr merge` what the file's
// `merge` says — its exit status and what it prints — after recording the
// call, as every call is recorded.
const GH = `
const fs = require('node:fs');
const file = process.env.GH_STANDIN;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(file + '.calls', JSON.stringify(args) + '\\n');
const out = (value) => process.stdout.write(JSON.stringify(value));
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const shape = (i) => ({
  number: i.number,
  title: 'issue ' + i.number,
  state: i.state,
  labels: i.labels.map((name) => ({ id: 'LA_' + name, name, color: 'ededed', description: '' })),
  body: i.body,
  updatedAt: '2026-10-19T00:00:00Z',
});
if (args[0] === 'pr' && args[1] === 'merge') {
  const merge = data.merge ?? { status: 0, stderr: '✓ Merged pull request acme/widgets#' + args[2] + ' (Widgets)\\n' };
  process.stdout.write(merge.stdout ?? '');
  process.stderr.write(merge.stderr ?? '');
  process.exit(merge.status);
} else if (args[0] === 'issue' && args[1] === 'list') {
  const label = option('--label');
  const limit = Number(option('--limit') ?? 30);
  out(data.issues
    .filter((i) => option('--state') !== 'open' || i.state === 'OPEN')
    .filter((i) => label === undefined || i.labels.includes(label))
    .slice(0, limit)
    .map(shape));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const found = data.issues.find((i) => String(i.number) === args[2]);
  if (!found) {
    process.stderr.write('GraphQL: Could not resolve to an issue or pull request with the number of ' + args[2] + '. (repository.issue)\\n');
    process.exit(1);
  }
  out(shape(found));
} else {
  process.stderr.write('stand-in gh: not ' + args.join(' ') + '\\n');
  process.exit(2);
}
`;

// An issue as the stand-in keeps it; gh answers its labels as objects.
const issue = (number, { labels = [], body = '', state = 'OPEN', ready = true } = {}) => ({
  number,
  state,
  labels: state === 'OPEN' && ready ? ['state:ready', ...labels] : labels,
  body,
});
const touches = (...areas) => `## Problem\n\nx\n\n## Touches\n\n${areas.join(', ')}\n`;

// A repository with `origin` at a bare clone whose main branch carries the
// decision log up to D216, the script copied beside the made-up vocabulary, a
// flow.json, a HOME for the sessions' transcripts, and the stand-in gh.
function fixture(t, { issues = [], merge, main = 'main', flow } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-queue-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  const origin = join(root, 'origin.git');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const kit = join(root, 'kit');
  const projects = join(home, '.claude', 'projects', projectName(work));
  mkdirSync(join(work, 'docs'), { recursive: true });
  mkdirSync(projects, { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(kit, '.claude', 'scripts'), { recursive: true });
  copyFileSync(QUEUE_SOURCE, join(kit, '.claude', 'scripts', 'delivery-queue.mjs'));
  copyFileSync(CONFIG_SOURCE, join(kit, '.claude', 'scripts', 'flow-config.mjs'));
  writeFileSync(join(kit, '.claude', 'delivery-areas.json'), JSON.stringify(VOCABULARY));
  const script = join(kit, '.claude', 'scripts', 'delivery-queue.mjs');
  const flowFile = join(root, 'flow.json');
  writeFileSync(
    flowFile,
    JSON.stringify(flow ?? { project: { name: 'Widgets', repo: REPO, mainBranch: main } }),
  );

  gitRun(root, 'init', '--quiet', `--initial-branch=${main}`, work);
  gitRun(work, 'config', 'user.email', 'test@example.invalid');
  gitRun(work, 'config', 'user.name', 'Test');
  writeFileSync(
    join(work, 'docs', 'DECISIONS.md'),
    '# Decisions\n\n## D215 — a\n\n## D216 — b\n\n## DK5 — the kit\n',
  );
  writeFileSync(join(work, 'README.md'), 'fixture\n');
  gitRun(work, 'add', '-A');
  gitRun(work, 'commit', '--quiet', '-m', 'base');
  gitRun(root, 'init', '--bare', '--quiet', `--initial-branch=${main}`, origin);
  gitRun(work, 'remote', 'add', 'origin', origin);
  gitRun(work, 'push', '--quiet', 'origin', main);
  gitRun(work, 'fetch', '--quiet', 'origin');

  const standin = join(root, 'gh.json');
  writeFileSync(standin, JSON.stringify({ issues, merge }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n${GH}`, { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GH_STANDIN: standin,
    FLOW_CONFIG: flowFile,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const f = {
    root,
    work,
    home,
    projects,
    flowFile,
    stateFile: join(work, '.git', 'delivery-queue', 'state.json'),
    setIssues: (list) => {
      const data = JSON.parse(readFileSync(standin, 'utf8'));
      writeFileSync(standin, JSON.stringify({ ...data, issues: list }));
    },
    setMerge: (answer) => {
      const data = JSON.parse(readFileSync(standin, 'utf8'));
      writeFileSync(standin, JSON.stringify({ ...data, merge: answer }));
    },
    ghCalls: () => {
      try {
        return readFileSync(`${standin}.calls`, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    // A session with a transcript written now; `subagent` adds one of its
    // sub-agents' transcripts.
    session: (directory = projects) => {
      const id = randomUUID();
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${id}.jsonl`), '{}\n');
      return id;
    },
    subagent: (id) => {
      const directory = join(projects, id, 'subagents');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `agent-${randomUUID().slice(0, 8)}.jsonl`);
      writeFileSync(path, '{}\n');
      return path;
    },
    age: (path, minutes) => {
      const when = new Date(Date.now() - minutes * 60_000);
      utimesSync(path, when, when);
    },
    q: (...args) =>
      spawnSync(process.execPath, [script, ...args], { cwd: work, env, encoding: 'utf8' }),
    qAt: (cwd, ...args) =>
      spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' }),
    // The script in a process of its own; `kill(signal)` on what it returns
    // stops that process, and `pid` names it.
    qAsync: (...args) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: work, env });
      const done = new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
        child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
      return Object.assign(done, { pid: child.pid, kill: (signal) => child.kill(signal) });
    },
    state: () =>
      JSON.parse(readFileSync(join(work, '.git', 'delivery-queue', 'state.json'), 'utf8')),
    writeState: (state) =>
      writeFileSync(join(work, '.git', 'delivery-queue', 'state.json'), JSON.stringify(state)),
    directory: join(work, '.git', 'delivery-queue'),
  };
  return f;
}

const ok = (result, label) => {
  assert.equal(result.status, 0, `${label}: exit ${result.status}, ${result.stderr}`);
  return result.stdout;
};
const refused = (result, pattern, label) => {
  assert.equal(
    result.status,
    3,
    `${label}: exit ${result.status}, ${result.stdout}${result.stderr}`,
  );
  assert.match(result.stderr, /^refused: [^\n]+\n$/, `${label}: not one refusal line`);
  assert.match(result.stderr, pattern, label);
};
const tokenOf = (stdout) => /^token ([0-9a-f]{32})$/m.exec(stdout)?.[1];

// A fire's task: the issue must be an open ready one in the stand-in's list.
function fireTask(f, number, session = f.session()) {
  ok(
    f.q(
      'start',
      String(number),
      '--session',
      session,
      '--branch',
      `fix/t${number}`,
      '--worktree',
      `/tmp/t${number}`,
    ),
    `start ${number}`,
  );
  return session;
}

// A day task, which needs no issue and is never refused for a slot.
function dayTask(f, key, areas = 'docs', session = f.session()) {
  ok(
    f.q(
      'start',
      key,
      '--day',
      '--session',
      session,
      '--branch',
      `chore/${key}`,
      '--worktree',
      `/tmp/${key}`,
      '--areas',
      areas,
    ),
    `start ${key}`,
  );
  return session;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test('the usage names every command, and --pr where GitLab had --mr', (t) => {
  const f = fixture(t);
  for (const args of [[], ['nonsense'], ['--help']]) {
    const result = f.q(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${USAGE}\n`);
  }
  assert.ok(USAGE.startsWith('usage: node .claude/scripts/delivery-queue.mjs <command> …\n'));
  for (const command of [
    'status [--json]',
    'pick [--json]',
    'start <task>',
    'update <task>',
    '[--pr <n>]',
    'adopt <task>',
    'lock <task>',
    'merge <task> --token <token> --sha <sha>',
    'finish <task> delivered|blocked|recovered|stopped',
    'reserve <task> [count]',
    'set slots <n>',
  ]) {
    assert.ok(USAGE.includes(command), command);
  }
  assert.doesNotMatch(USAGE, /--mr|glab|GitLab/);
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

test('of several processes taking the lock at once exactly one holds it, and a stale token is refused for a check and a release', async (t) => {
  const f = fixture(t);
  const keys = ['day-a', 'day-b', 'day-c', 'day-d', 'day-e', 'day-f', 'day-g', 'day-h'];
  const sessions = new Map(keys.map((key) => [key, dayTask(f, key)]));

  let previous = null;
  for (let round = 0; round < 3; round += 1) {
    const results = await Promise.all(
      keys.map((key) => f.qAsync('lock', key, '--session', sessions.get(key))),
    );
    const winners = results.filter((result) => result.status === 0);
    assert.equal(winners.length, 1, `round ${round}: ${winners.length} processes hold the lock`);
    for (const loser of results.filter((result) => result.status !== 0)) {
      assert.equal(loser.status, 3, loser.stderr);
      assert.match(loser.stderr, /refused: (the lock is held by|day-[a-h] has waited longer)/);
    }
    const token = tokenOf(winners[0].stdout);
    assert.ok(token, 'the winner is given a token');
    assert.notEqual(token, previous, 'each acquisition gets a new token');
    const holder = f.state().lock.key;
    assert.equal(f.state().tasks[holder].token, token, 'the token is recorded with the task');

    ok(f.q('check', holder, token), 'check with the current token');
    refused(f.q('check', holder, 'f'.repeat(32)), /stale token/, 'check with another token');
    refused(f.q('check', holder, ''), /stale token/, 'check with no token');
    const other = keys.find((key) => key !== holder);
    refused(
      f.q('check', other, token),
      /stale token/,
      "check of the holder's token by another task",
    );
    refused(
      f.q('unlock', holder, '0'.repeat(32), '--next', 'x'),
      /stale token: .* nothing was released/,
      'release with another token',
    );
    assert.equal(f.state().lock.key, holder, 'a refused release changes nothing');
    assert.equal(f.q('unlock', holder, token).status, 2, 'a release without its next step');
    assert.equal(f.q('unlock', holder, token, '--next', ' \n ').status, 2, 'an empty next step');
    assert.equal(f.state().lock.key, holder, 'a release refused for its usage changes nothing');
    ok(
      f.q(
        'unlock',
        holder,
        token,
        '--next',
        'step 9: back from the lock, the integration needs a fix',
      ),
      'release with the current token',
    );
    assert.equal(
      f.state().tasks[holder].next,
      'step 9: back from the lock, the integration needs a fix',
      'the next step says why the task came back',
    );
    refused(
      f.q('check', holder, token),
      /stale token: .*\(the lock is free\)\. Stop acting, read the actual state — the PR, main's workflow run, the tag — and queue again/,
      'check after the release',
    );
    refused(f.q('unlock', holder, token, '--next', 'x'), /stale token/, 'a second release');
    previous = token;
  }
});

test('the lock waits up to its bound, then the task stays awaiting it; the queue paused keeps it from anyone', (t) => {
  const f = fixture(t);
  const a = dayTask(f, 'day-a');
  const b = dayTask(f, 'day-b');
  const token = tokenOf(ok(f.q('lock', 'day-a', '--session', a), 'a takes the lock'));
  const started = Date.now();
  refused(
    f.q('lock', 'day-b', '--session', b, '--wait', '0.02'),
    /held by day-a.*stays awaiting the lock/,
    'b waits',
  );
  assert.ok(Date.now() - started >= 1000, 'the wait lasted its bound');
  assert.equal(f.state().tasks['day-b'].state, 'awaiting-lock');
  // The cycle's own words for a task waiting for the lock, and for one holding it.
  assert.equal(f.state().tasks['day-b'].next, 'step 9: take the lock');
  assert.equal(f.state().tasks['day-a'].next, 'step 9: integrate and number, under the lock');
  refused(f.q('lock', 'day-a', '--session', a), /holds the lock already/, 'the holder asks again');

  ok(f.q('pause', '--reason', 'recovery failed on main'), 'pause');
  ok(
    f.q('finish', 'day-a', 'blocked', '--session', a, '--token', token),
    'the holder ends blocked',
  );
  assert.equal(f.state().lock, null);
  refused(
    f.q('lock', 'day-b', '--session', b),
    /the queue is paused: recovery failed on main/,
    'paused',
  );
  // A paused queue refuses at once, not after the wait: no task takes the
  // lock until the owner's word unpauses it, so a fire that waited would be
  // held for its whole bound. The task is left awaiting the lock, polling no
  // more and holding no slot, a working one too.
  const c = dayTask(f, 'day-c');
  for (const [key, session] of [
    ['day-b', b],
    ['day-c', c],
  ]) {
    const asked = Date.now();
    refused(
      f.q('lock', key, '--session', session, '--wait', '1'),
      /^refused: the queue is paused: recovery failed on main; it takes the lock once the owner's word unpauses it\n$/,
      `${key} on a paused queue, --wait 1`,
    );
    assert.ok(Date.now() - asked < 10_000, `${key}: --wait 1 took ${Date.now() - asked} ms`);
    const task = f.state().tasks[key];
    assert.equal(task.state, 'awaiting-lock', `${key} awaits the lock`);
    assert.equal(task.polledAt, null, `${key} polls no more`);
  }
  ok(f.q('unpause'), 'unpause');
  assert.ok(tokenOf(ok(f.q('lock', 'day-b', '--session', b), 'b after the pause')));
  // One wait fits in one Bash call in the background, which runs 30 minutes.
  assert.equal(MAX_WAIT_MINUTES, 25);
  for (const bad of ['-1', '26', '25.001', '60', '121', 'x', '1e3', '', '0.0001']) {
    assert.equal(f.q('lock', 'day-b', '--session', b, '--wait', bad).status, 2, `--wait ${bad}`);
  }
  ok(f.q('unlock', 'day-b', f.state().lock.token, '--next', 'x'), 'b gives the lock back');
  assert.ok(tokenOf(ok(f.q('lock', 'day-b', '--session', b, '--wait', '25'), '--wait 25')));
});

test('a session that is not the task’s stops acting: its update, lock, reserve and finish are refused', (t) => {
  const f = fixture(t);
  const own = dayTask(f, 'day-a');
  const stranger = f.session();
  for (const args of [
    ['update', 'day-a', '--next', 'x'],
    ['lock', 'day-a'],
    ['reserve', 'day-a'],
    ['finish', 'day-a', 'stopped'],
  ]) {
    refused(
      f.q(...args, '--session', stranger),
      /belongs to the session .* stop acting on it/,
      args[0],
    );
  }
  ok(f.q('update', 'day-a', '--session', own, '--detach'), 'detach');
  refused(
    f.q('update', 'day-a', '--session', own, '--next', 'x'),
    /belongs to no session \(detached\)/,
    'after detaching',
  );
  for (const bad of [
    '',
    'fire 2026-10-09 10:00:00',
    'ABCDEFAB-0000-4000-8000-000000000000',
    `${randomUUID()}x`,
    '../../etc',
  ]) {
    assert.equal(f.q('update', 'day-a', '--session', bad).status, 2, `--session ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

test('with the limit 3 and five candidates at most three tasks hold a slot, concurrent starts included; waiting, paused and delivering tasks hold none', async (t) => {
  const areas = ['docs', 'auth', 'notifications', 'search', 'billing', 'tooling', 'e2e'];
  const issues = areas.map((area, at) => issue(400 + at, { body: touches(area) }));
  const f = fixture(t, { issues });
  const sessions = new Map(issues.map((item) => [item.number, f.session()]));
  const start = (number) =>
    f.qAsync(
      'start',
      String(number),
      '--session',
      sessions.get(number),
      '--branch',
      `fix/t${number}`,
      '--worktree',
      `/tmp/t${number}`,
    );

  const results = await Promise.all([400, 401, 402, 403, 404].map(start));
  assert.equal(
    results.filter((r) => r.status === 0).length,
    3,
    results.map((r) => r.stderr).join(''),
  );
  for (const r of results.filter((r) => r.status !== 0))
    assert.match(r.stderr, /no slot is free: 3 of 3/);
  assert.match(ok(f.q('status'), 'status'), /3 of 3 slots in use/);
  const working = Object.keys(f.state().tasks).map(Number);

  // Waiting for the lock frees a slot, and so does a pause for a resource or
  // a dependency; the lock is a place of its own.
  ok(
    f.q(
      'update',
      String(working[0]),
      '--session',
      sessions.get(working[0]),
      '--state',
      'awaiting-lock',
    ),
    'awaiting',
  );
  ok(await start(405), 'a slot freed by a task waiting for the lock');
  ok(
    f.q(
      'update',
      String(working[1]),
      '--session',
      sessions.get(working[1]),
      '--state',
      'paused',
      '--reason',
      'HTTP 429',
    ),
    'paused for a resource',
  );
  ok(await start(406), 'a slot freed by a task paused');
  refused(
    f.q(
      'start',
      '403',
      '--session',
      sessions.get(403),
      '--branch',
      'fix/x',
      '--worktree',
      '/tmp/x',
    ),
    /no slot is free|in the queue already/,
    'full again',
  );
  assert.ok(
    tokenOf(ok(f.q('lock', String(working[0]), '--session', sessions.get(working[0])), 'lock')),
  );
  assert.match(ok(f.q('status'), 'status'), /3 of 3 slots in use/, 'the holder holds no slot');
  ok(
    f.q(
      'update',
      String(working[2]),
      '--session',
      sessions.get(working[2]),
      '--state',
      'paused',
      '--reason',
      'depends on #148',
    ),
    'paused for a dependency',
  );
  assert.match(ok(f.q('status'), 'status'), /2 of 3 slots in use/);

  // The limit comes from the setting, and a day task is never refused.
  ok(f.q('set', 'slots', '2'), 'set slots 2');
  assert.match(ok(f.q('status'), 'status'), /2 of 2 slots in use/);
  const day = f.session();
  assert.match(
    ok(
      f.q(
        'start',
        'day-owner',
        '--day',
        '--session',
        day,
        '--branch',
        'chore/o',
        '--worktree',
        '/tmp/o',
        '--areas',
        'docs',
      ),
      'day',
    ),
    /over the slot limit: 3 of 2, a day task is never refused/,
  );
  ok(f.q('set', 'slots', '5'), 'set slots 5');
  assert.match(ok(f.q('status'), 'status'), /3 of 5 slots in use/);
  for (const bad of ['0', '11', '-1', 'x', '3.5', '']) {
    assert.equal(f.q('set', 'slots', bad).status, 2, `set slots ${bad}`);
  }
  for (const bad of ['29', '1441', 'ninety']) {
    assert.equal(f.q('set', 'stale-minutes', bad).status, 2, `set stale-minutes ${bad}`);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.work, '.git', 'delivery-queue', 'settings.json'), 'utf8')),
    {
      slots: 5,
      staleMinutes: 90,
    },
  );
});

test('a fire starts only an open state:ready issue outside delivery:attended and type:epic, with its labels in order and its dependencies closed, and only with a transcript of its session', (t) => {
  const f = fixture(t, {
    issues: [
      issue(500, { body: `${touches('docs')}\nDepends on #148\n` }),
      issue(501, { body: touches('docs'), labels: ['delivery:attended'] }),
      issue(502, { body: touches('docs'), state: 'CLOSED' }),
      issue(503, { body: `${touches('docs')}\nDepends on #149\n` }),
      issue(504, { body: `${touches('docs')}\nDepends on #149, #148\n` }),
      issue(505, { body: touches('docs'), labels: ['type:epic'] }),
      issue(506, { body: touches('docs'), labels: ['state:grooming'] }),
      issue(507, { body: touches('docs'), labels: ['prio:3', 'prio:1'] }),
      issue(508, { body: touches('docs'), ready: false, labels: ['state:needs-owner'] }),
      issue(148, { ready: false }),
      issue(149, { state: 'CLOSED' }),
    ],
  });
  const s = f.session();
  const start = (number, session = s) =>
    f.q('start', String(number), '--session', session, '--branch', 'fix/x', '--worktree', '/tmp/x');
  refused(start(500), /depends on #148, still open/, 'open dependency');
  refused(start(504), /depends on #148, still open/, 'the second of a Depends on line, open');
  for (const [number, why] of [
    [501, 'delivery:attended'],
    [505, 'type:epic'],
    [502, 'closed'],
    [508, 'not state:ready'],
  ]) {
    refused(
      start(number),
      new RegExp(
        `^refused: #${number} is no longer an open state:ready issue outside delivery:attended and type:epic\\n$`,
      ),
      why,
    );
  }
  refused(
    start(506),
    /^refused: #506 carries 2 state: labels \(state:grooming, state:ready\): fix its labels; the queue does not guess which holds\n$/,
    'two state labels',
  );
  refused(
    start(507),
    /^refused: #507 carries 2 prio: labels \(prio:1, prio:3\): fix its labels; the queue does not guess which holds\n$/,
    'two prio labels',
  );
  refused(start(503, randomUUID()), /no transcript of the session/, 'no transcript');
  assert.equal(
    f.q(
      'start',
      '503',
      '--session',
      s,
      '--branch',
      'fix/x',
      '--worktree',
      '/tmp/x',
      '--areas',
      'docs',
    ).status,
    2,
    '--areas without --day',
  );
  ok(start(503), 'a closed dependency');
  // Claimed after the preflight on main: the next step is the cycle's step 2.
  assert.equal(f.state().tasks['503'].next, 'step 2: branch and worktree');
  // The issue is read with the fields the queue needs, from the configured repository.
  const views = f.ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'view');
  assert.deepEqual(views.at(-2), [
    'issue',
    'view',
    '503',
    '--repo',
    REPO,
    '--json',
    'number,state,labels,body',
  ]);
  assert.deepEqual(views.at(-1), [
    'issue',
    'view',
    '149',
    '--repo',
    REPO,
    '--json',
    'number,state,labels,body',
  ]);
  refused(start(503), /in the queue already: resume it through the queue/, 'a second start');
  for (const [flag, value] of [
    ['--branch', 'fix/../x'],
    ['--branch', '-x'],
    ['--worktree', 'relative/path'],
    ['--worktree', '/tmp/a\nb'],
    ['--base', 'not-a-sha'],
  ]) {
    const args = [
      'start',
      'day-x',
      '--day',
      '--session',
      s,
      '--branch',
      'fix/x',
      '--worktree',
      '/tmp/x',
      '--areas',
      'docs',
    ];
    args[args.indexOf(flag) + 1] = value;
    assert.equal(f.q(...args).status, 2, `${flag} ${JSON.stringify(value)}`);
  }
  for (const key of ['0', '01', '1234567890', 'day-', 'day-X', '../x', 'day-a/b', '#12']) {
    assert.equal(f.q('show', key).status, 2, `task ${key}`);
  }
});

// `update --worktree` adds a tree to remove when the task ends, which `show`,
// `status` and `finish` print back, so it is held to what `start` takes: an
// absolute path on one line, at most 4096 characters.
test('update --worktree takes only what start takes, and the state is left as it was', (t) => {
  const f = fixture(t);
  const s = dayTask(f, 'day-w');
  const before = readFileSync(f.stateFile, 'utf8');
  for (const value of [
    'relative/path',
    '/tmp/a\nb',
    '/tmp/a\rb',
    '/tmp/\u001b[31mred',
    '/tmp/a b',
    '/tmp/a  b',
    '/tmp/a ',
    `/${'a'.repeat(100_000)}`,
    `/${'a'.repeat(4096)}`,
  ]) {
    const result = f.q('update', 'day-w', '--session', s, '--worktree', value);
    assert.equal(result.status, 2, `${JSON.stringify(value.slice(0, 40))}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /--worktree is an absolute path on one line, at most 4096 characters/,
    );
    assert.equal(readFileSync(f.stateFile, 'utf8'), before, JSON.stringify(value.slice(0, 40)));
  }
  const longest = `/${'a'.repeat(4095)}`;
  ok(f.q('update', 'day-w', '--session', s, '--worktree', longest), 'the longest path');
  ok(f.q('update', 'day-w', '--session', s, '--worktree', '/tmp/day-w tester'), 'one space');
  const ended = ok(f.q('finish', 'day-w', 'stopped', '--session', s), 'finish');
  assert.ok(ended.includes(`Its worktrees: /tmp/day-w, ${longest}, /tmp/day-w tester\n`), ended);
});

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

const offered = (stdout) =>
  [...stdout.split('Passed over')[0].matchAll(/^ {2}#(\d+) /gm)].map((match) => Number(match[1]));
const passedOver = (stdout) =>
  new Map(
    [...(stdout.split('Passed over')[1] ?? '').matchAll(/^ {2}#(\d+) {2}(.*)$/gm)].map((m) => [
      Number(m[1]),
      m[2],
    ]),
  );

test('the pick passes over hard-area clashes, open dependencies, clashing labels and an issue without Touches while tasks are in flight, leaves out attended issues and epics, and orders the rest by priority, shared areas and number', (t) => {
  const f = fixture(t, {
    issues: [
      issue(601, { labels: ['prio:2'], body: touches('auth') }),
      issue(602, { labels: ['prio:1'], body: touches('migrations', 'server') }),
      issue(603, { labels: ['prio:1'], body: touches('docs', 'web-account') }),
      issue(604, { labels: ['prio:1'], body: touches('web-account') }),
      issue(605, { labels: ['prio:1'], body: '## Problem\n\nno touches here\n' }),
      issue(606, { labels: ['prio:1'], body: `${touches('docs')}\nDepends on #148\n` }),
      issue(607, { labels: ['prio:1'], body: `${touches('tooling')}\nDepends on #149\n` }),
      issue(608, { labels: ['prio:1'], body: touches('notifications') }),
      issue(609, { body: touches('operations') }),
      issue(610, { labels: ['prio:1'], body: touches('auth', 'ci-deploy') }),
      issue(611, { labels: ['prio:1'], body: '## Touches\n\nauth, the-receiver\n' }),
      // The second issue a `Depends on` line names counts too.
      issue(612, {
        labels: ['prio:1'],
        body: `${touches('docs')}\nDepends on #149, #148\n`,
      }),
      // Two priorities, or two states: a fault, never guessed.
      issue(613, { labels: ['prio:3', 'prio:1'], body: touches('search') }),
      issue(614, { labels: ['state:grooming'], body: touches('search') }),
      // Never the cycle's: neither offered nor listed as passed over.
      issue(615, { labels: ['prio:1', 'type:epic'], body: touches('billing') }),
      issue(616, { labels: ['prio:1', 'delivery:attended'], body: touches('billing') }),
      issue(148, { ready: false }),
      issue(149, { state: 'CLOSED' }),
    ],
  });
  // In flight: one task that declared migrations and web-account, and one
  // whose branch changed CI although it declared only docs.
  const sessionA = dayTask(f, 'day-a', 'migrations,web-account');
  gitRun(f.work, 'switch', '--quiet', '--create', 'chore/day-b');
  mkdirSync(join(f.work, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(f.work, '.github', 'workflows', 'ci.yml'), 'x: 1\n');
  gitRun(f.work, 'add', '-A');
  gitRun(f.work, 'commit', '--quiet', '-m', 'ci');
  gitRun(f.work, 'switch', '--quiet', 'main');
  const sessionB = dayTask(f, 'day-b', 'docs');

  const out = ok(f.q('pick'), 'pick');
  // The listing, word for word: the ready issues of the configured repository.
  const listing = f.ghCalls().find((args) => args[0] === 'issue' && args[1] === 'list');
  assert.deepEqual(listing, [
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--label',
    'state:ready',
    '--json',
    'number,title,labels,body,updatedAt',
    '--limit',
    '200',
  ]);
  // prio:1 first: 607 (tooling, nothing shared), 608 (notifications, nothing
  // shared), 604 (web-account, 1 shared), 603 (docs and web-account, 2
  // shared); then 601 (prio:2); then 609.
  assert.deepEqual(offered(out), [607, 608, 604, 603, 601, 609]);
  const passed = passedOver(out);
  assert.match(passed.get(602), /shares the hard area migrations with day-a/);
  assert.match(passed.get(605), /touches every area \(no ## Touches\), and day-a, day-b in flight/);
  assert.match(passed.get(606), /depends on #148, still open/);
  assert.match(passed.get(612), /depends on #148, still open/);
  assert.match(passed.get(610), /shares the hard area ci-deploy with day-b/);
  assert.match(
    passed.get(611),
    /touches every area \(## Touches names the-receiver, which is no area\)/,
  );
  assert.equal(
    passed.get(613),
    'carries 2 prio: labels (prio:1, prio:3): fix its labels; the queue does not guess which holds',
  );
  assert.equal(
    passed.get(614),
    'carries 2 state: labels (state:grooming, state:ready): fix its labels; the queue does not guess which holds',
  );
  for (const number of [615, 616]) {
    assert.ok(!offered(out).includes(number) && !passed.has(number), `${number} is left out`);
    assert.doesNotMatch(out, new RegExp(`#${number}`));
  }
  assert.match(out, /^ {2}#607 {2}prio:1 {2}areas: tooling {2}shared with tasks in flight: 0$/m);
  assert.match(out, /^ {2}#609 {2}no prio {2}/m);
  assert.match(out, /shared with tasks in flight: 2/);
  // A clashing issue's dependencies are not looked up.
  const viewed = f
    .ghCalls()
    .filter((args) => args[0] === 'issue' && args[1] === 'view')
    .map((args) => args[2]);
  assert.deepEqual(viewed.sort(), ['148', '149']);

  // With nothing in flight, the issue without Touches is offered too.
  ok(f.q('finish', 'day-a', 'stopped', '--session', sessionA), 'finish day-a');
  ok(f.q('finish', 'day-b', 'stopped', '--session', sessionB), 'finish day-b');
  const empty = ok(f.q('pick'), 'pick with nothing in flight');
  assert.deepEqual(offered(empty), [602, 603, 604, 605, 607, 608, 610, 611, 601, 609]);

  // A task in the queue is never offered: it is resumed.
  ok(
    f.q('start', '602', '--session', f.session(), '--branch', 'fix/602', '--worktree', '/tmp/602'),
    'start 602',
  );
  assert.match(passedOver(ok(f.q('pick'), 'pick')).get(602), /in the queue already/);
  ok(f.q('set', 'slots', '1'), 'one slot');
  refused(f.q('pick'), /No slot is free: take no new issue/, 'slots full');
  ok(f.q('set', 'slots', '3'), 'three slots');
  f.setIssues([]);
  refused(f.q('pick'), /nothing to take/, 'no candidate');
});

// An epic is a container `/decompose` made: it is never delivered, whatever
// labels it carries, and the pick leaves it out as it leaves out an issue
// that needs a person present.
test('the pick never offers an issue labelled type:epic, even state:ready with a priority', (t) => {
  const f = fixture(t, {
    issues: [
      issue(620, { labels: ['type:epic', 'prio:1'], body: touches('docs') }),
      issue(621, { labels: ['type:epic'], body: touches('tooling') }),
    ],
  });
  const nothing = f.q('pick', '--json');
  refused(nothing, /^refused: nothing to take\n$/, 'epics only');
  assert.deepEqual(JSON.parse(nothing.stdout).take, []);
  assert.deepEqual(JSON.parse(nothing.stdout).passed, [], 'not even listed as passed over');
  f.setIssues([
    issue(620, { labels: ['type:epic', 'prio:1'], body: touches('docs') }),
    issue(622, { labels: ['prio:3'], body: touches('docs') }),
  ]);
  const json = JSON.parse(ok(f.q('pick', '--json'), 'pick beside an epic'));
  assert.deepEqual(
    json.take.map((item) => item.iid),
    [622],
  );
});

// `pick --json` is what `.claude/scripts/fire-check.mjs` reads before a
// scheduled fire starts a session (D17): the same candidates in the same
// order, the same pass-overs with their reasons, and the same exit statuses,
// a refusal carrying the JSON on stdout and its one line on stderr.
test('pick --json offers what pick offers, in its order, with the same pass-overs and exit statuses', (t) => {
  const f = fixture(t, {
    issues: [
      issue(621, { labels: ['prio:2'], body: touches('docs') }),
      issue(622, { labels: ['prio:1'], body: touches('migrations') }),
      issue(623, { labels: ['prio:1'], body: `${touches('tooling')}\nDepends on #148\n` }),
      issue(624, { body: '## Problem\n\nno touches here\n' }),
      issue(625, { labels: ['prio:1'], body: touches('tooling') }),
      issue(626, { labels: ['prio:1', 'prio:2'], body: touches('tooling') }),
      issue(148, { ready: false }),
    ],
  });
  dayTask(f, 'day-a', 'migrations');
  const text = ok(f.q('pick'), 'pick');
  const json = JSON.parse(ok(f.q('pick', '--json'), 'pick --json'));
  assert.deepEqual(
    json.take.map((item) => item.iid),
    offered(text),
  );
  assert.deepEqual(
    json.take.map((item) => item.iid),
    [625, 621],
  );
  assert.deepEqual(json.take[1], { iid: 621, priority: 2, areas: ['docs'], shared: 0 });
  assert.deepEqual(new Map(json.passed.map((item) => [item.iid, item.why])), passedOver(text));
  assert.equal(json.passed.length, 4);
  assert.equal(json.slots, 3);
  assert.equal(json.used, 1);
  assert.equal(json.lock, null);
  assert.equal(json.paused, false);

  // Nothing to take: exit 3, the JSON on stdout, one refusal line.
  f.setIssues([issue(622, { labels: ['prio:1'], body: touches('migrations') })]);
  const nothing = f.q('pick', '--json');
  refused(nothing, /^refused: nothing to take\n$/, 'nothing to take');
  const answer = JSON.parse(nothing.stdout);
  assert.deepEqual(answer.take, []);
  assert.match(answer.passed[0].why, /shares the hard area migrations with day-a/);

  // No slot free: exit 3, the JSON with nothing offered, GitHub not asked.
  ok(f.q('set', 'slots', '1'), 'one slot');
  const calls = f.ghCalls().length;
  const full = f.q('pick', '--json');
  refused(full, /No slot is free: take no new issue/, 'slots full');
  assert.deepEqual(JSON.parse(full.stdout), {
    slots: 1,
    used: 1,
    lock: null,
    paused: false,
    take: [],
    passed: [],
  });
  assert.equal(f.ghCalls().length, calls, 'a full queue asks GitHub nothing');
  assert.equal(f.q('pick', '--jsonx').status, 2, 'an unknown flag is wrong usage');
});

test('pickOrder and conflict, on made-up candidates', () => {
  const flight = new Map([
    ['10', ['auth', 'docs']],
    ['11', null],
  ]);
  assert.equal(
    conflict({ every: false, areas: ['migrations'] }, flight, vocabulary),
    'shares the hard area migrations with #11',
  );
  assert.equal(
    conflict({ every: false, areas: ['auth', 'notifications'] }, flight, vocabulary),
    null,
  );
  assert.equal(conflict({ every: true, why: 'no ## Touches' }, new Map(), vocabulary), null);
  const { take, passed } = pickOrder(
    [
      { iid: 3, priority: 1, declared: { every: false, areas: ['auth'] }, open: [] },
      { iid: 2, priority: 1, declared: { every: false, areas: ['notifications'] }, open: [] },
      { iid: 1, priority: 2, declared: { every: false, areas: ['notifications'] }, open: [] },
      { iid: 4, priority: 1, declared: { every: false, areas: ['notifications'] }, open: [] },
      {
        iid: 5,
        priority: 4,
        fault: 'carries 2 prio: labels',
        declared: { every: false, areas: ['docs'] },
        open: [],
      },
    ],
    new Map([['10', ['auth']]]),
    vocabulary,
  );
  assert.deepEqual(
    take.map((item) => item.iid),
    [2, 4, 3, 1],
  );
  assert.deepEqual(passed, [{ iid: 5, why: 'carries 2 prio: labels' }]);
  assert.deepEqual(
    [[], ['prio:2'], ['prio:3', 'prio:2'], ['prio:9', 'xprio:1'], null, 'prio:1', ['prio::1']].map(
      priority,
    ),
    [4, 2, null, 4, 4, 4, 4],
  );
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// GitHub has no scoped labels: nothing keeps an issue from carrying two
// `state:` or two `prio:` labels. The queue reads either as a fault of that
// issue, in whatever order the labels come, and never picks one of them.
test('two prio: or two state: labels are a fault whatever order they come in, never a priority or a state', () => {
  const orders = [
    ['prio:1', 'prio:2', 'prio:3'],
    ['prio:1', 'prio:3', 'prio:2'],
    ['prio:2', 'prio:1', 'prio:3'],
    ['prio:2', 'prio:3', 'prio:1'],
    ['prio:3', 'prio:1', 'prio:2'],
    ['prio:3', 'prio:2', 'prio:1'],
  ];
  for (const labels of orders) {
    assert.equal(priority(labels), null, labels.join(','));
    assert.equal(
      labelFault(['area:server', ...labels, 'type:bug']),
      'carries 3 prio: labels (prio:1, prio:2, prio:3): fix its labels; the queue does not guess which holds',
      labels.join(','),
    );
    const two = labels.filter((name) => name !== 'prio:1');
    assert.equal(priority(two), null, two.join(','));
  }
  assert.equal(priority(['area:server', 'prio:2', 'type:bug']), 2);
  assert.equal(labelFault(['state:ready', 'prio:2', 'area:docs', 'type:chore']), null);
  assert.equal(
    labelFault(['state:needs-owner', 'state:ready']),
    'carries 2 state: labels (state:needs-owner, state:ready): fix its labels; the queue does not guess which holds',
  );
  assert.match(labelFault(['state:ready', 'state:x']), /carries 2 state: labels/);
  // Any label that begins `state:` counts, GitLab's scoped spelling too.
  assert.match(labelFault(['state::ready', 'state:ready']), /carries 2 state: labels/);
  assert.equal(labelFault(['delivery:attended', 'type:epic', 'area:docs']), null);
});

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

test("a branch's changed files map onto the vocabulary's areas against origin's main branch, bookkeeping counting in none", (t) => {
  const f = fixture(t);
  const write = (path, text) => {
    mkdirSync(join(f.work, path, '..'), { recursive: true });
    writeFileSync(join(f.work, path), text);
  };
  write('VERSION', '0.51.0\n');
  gitRun(f.work, 'add', '-A');
  gitRun(f.work, 'commit', '--quiet', '-m', 'more');
  gitRun(f.work, 'push', '--quiet', 'origin', 'main');
  gitRun(f.work, 'fetch', '--quiet', 'origin');

  gitRun(f.work, 'switch', '--quiet', '--create', 'feat/x');
  write('server/src/auth/login.ts', 'x\n');
  write('web/src/lib/account-link.ts', 'x\n');
  write('VERSION', '0.52.0\n');
  write('CHANGELOG.md', '## 0.52.0\n');
  write('docs/DECISIONS.md', '## D217 — c\n');
  write('weird/thing.txt', 'x\n');
  gitRun(f.work, 'add', '-A');
  gitRun(f.work, 'commit', '--quiet', '-m', 'change');
  gitRun(f.work, 'switch', '--quiet', 'main');

  const out = ok(f.q('areas', 'feat/x'), 'areas');
  assert.match(out, /^areas of feat\/x against [0-9a-f]{12}: auth, other, web-account$/m);
  assert.match(out, /^VERSION: \(bookkeeping\)$/m);
  assert.match(out, /^docs\/DECISIONS\.md: \(bookkeeping\)$/m);

  // After main is merged into the branch, the base is that main: main's own
  // changes are not the branch's.
  write('server/migrations/011_x.sql', 'select 1;\n');
  gitRun(f.work, 'add', '-A');
  gitRun(f.work, 'commit', '--quiet', '-m', 'a migration on main');
  gitRun(f.work, 'push', '--quiet', 'origin', 'main');
  gitRun(f.work, 'fetch', '--quiet', 'origin');
  gitRun(f.work, 'switch', '--quiet', 'feat/x');
  gitRun(f.work, 'merge', '--quiet', '--no-edit', 'origin/main');
  gitRun(f.work, 'switch', '--quiet', 'main');
  assert.doesNotMatch(ok(f.q('areas', 'feat/x'), 'after integration'), /migrations/);

  assert.equal(f.q('areas', 'no/such-branch').status, 1, 'a branch that does not exist');
  assert.equal(f.q('areas', '../x').status, 2, 'not a branch name');
  assert.match(
    ok(f.q('areas', '--files', 'server/src/search/q.ts', 'VERSION'), 'files'),
    /^server\/src\/search\/q\.ts: search\nVERSION: \(bookkeeping\)\nareas: search\n$/,
  );
});

// The main branch is `project.mainBranch`, read as `origin/<it>` for a
// branch's base and for the decision log; nothing assumes `main`.
test('the main branch comes from flow.json: areas and reserve read origin/<mainBranch>', (t) => {
  const f = fixture(t, { main: 'trunk' });
  gitRun(f.work, 'switch', '--quiet', '--create', 'feat/y');
  mkdirSync(join(f.work, 'server', 'src', 'search'), { recursive: true });
  writeFileSync(join(f.work, 'server', 'src', 'search', 'q.ts'), 'x\n');
  gitRun(f.work, 'add', '-A');
  gitRun(f.work, 'commit', '--quiet', '-m', 'search');
  gitRun(f.work, 'switch', '--quiet', 'trunk');
  assert.match(ok(f.q('areas', 'feat/y'), 'areas on trunk'), /^areas of feat\/y against [0-9a-f]{12}: search$/m);
  const s = dayTask(f, 'day-a');
  assert.match(ok(f.q('reserve', 'day-a', '--session', s), 'reserve on trunk'), /: D217$/m);

  // Pointed at `main`, which origin does not have, the same reads fail.
  const flow = JSON.parse(readFileSync(f.flowFile, 'utf8'));
  writeFileSync(
    f.flowFile,
    JSON.stringify({ ...flow, project: { ...flow.project, mainBranch: 'main' } }),
  );
  const missing = f.q('areas', 'feat/y');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /^fault: the branch feat\/y or its base on origin\/main cannot be found \[D16\]\n$/);
  writeFileSync(
    f.flowFile,
    JSON.stringify({ ...flow, project: { ...flow.project, mainBranch: '-x' } }),
  );
  assert.match(f.q('areas', 'feat/y').stderr, /project\.mainBranch .* is not a branch name/);
});

// `.claude/flow.json` is read only by the commands that need GitHub or the
// main branch: a queue whose configuration is broken still shows its tasks,
// takes and gives back its lock, and finishes them.
test('a broken flow.json is a fault for pick, start, merge, areas and reserve, and leaves the rest of the queue working', (t) => {
  const f = fixture(t, { issues: [issue(630, { body: touches('docs') })] });
  const s = dayTask(f, 'day-a');
  for (const [text, pattern] of [
    [null, /flow\.json cannot be read \(ENOENT\): run \/flow-init/],
    ['{', /flow\.json is not JSON/],
    [JSON.stringify({ project: { repo: '' } }), /project\.repo is "", not owner\/name: run \/flow-init/],
  ]) {
    if (text === null) rmSync(f.flowFile, { force: true });
    else writeFileSync(f.flowFile, text);
    for (const args of [
      ['pick'],
      ['start', '630', '--session', s, '--branch', 'fix/t630', '--worktree', '/tmp/t630'],
      ['areas', 'main'],
      ['reserve', 'day-a', '--session', s],
      ['merge', 'day-a', '--token', 'a'.repeat(32), '--sha', 'b'.repeat(40)],
    ]) {
      const result = f.q(...args);
      assert.equal(result.status, 1, `${args[0]}: ${result.stderr}`);
      assert.match(result.stderr, /^fault: [^\n]+\[D16\]\n$/, args[0]);
      assert.match(result.stderr, pattern, args[0]);
    }
    ok(f.q('status'), 'status');
    ok(f.q('show', 'day-a'), 'show');
    const token = tokenOf(ok(f.q('lock', 'day-a', '--session', s), 'lock'));
    ok(f.q('check', 'day-a', token), 'check');
    ok(f.q('unlock', 'day-a', token, '--next', 'x'), 'unlock');
  }
  assert.deepEqual(f.ghCalls(), [], 'GitHub is never asked without a repository');
  ok(f.q('finish', 'day-a', 'stopped', '--session', s), 'finish');
});

test('files map to areas: hard areas always, the most specific ordinary glob, other for none', () => {
  const cases = [
    ['server/migrations/011_x.sql', ['migrations', 'server']],
    ['shared/src/index.ts', ['api-contract']],
    ['shared/src/billing.ts', ['api-contract', 'billing']],
    ['docs/API.md', ['api-contract', 'docs']],
    ['package-lock.json', ['dependencies']],
    ['web/package.json', ['dependencies', 'web']],
    ['.github/workflows/main.yml', ['ci-deploy']],
    ['.github/ISSUE_TEMPLATE/bug.md', ['delivery-process']],
    ['deploy/compose.yaml', ['ci-deploy']],
    ['server/Dockerfile', ['ci-deploy', 'server']],
    ['.claude/scripts/guard-bash.mjs', ['delivery-process']],
    ['CLAUDE.md', ['delivery-process']],
    ['docs/DELIVERY.md', ['delivery-process', 'docs']],
    ['server/src/auth/session.ts', ['auth']],
    ['server/src/notifications/hub.ts', ['notifications']],
    ['web/src/api/notifications.ts', ['notifications']],
    ['server/src/search/query.ts', ['search']],
    ['server/src/config.ts', ['server']],
    ['web/src/pages/AccountPage.tsx', ['web-account']],
    ['web/src/lib/account-filter.ts', ['web-account']],
    ['web/src/components/Header.tsx', ['web']],
    ['e2e/auth.spec.ts', ['auth']],
    ['e2e/helpers.ts', ['e2e']],
    ['scripts/db.mjs', ['operations']],
    ['README.md', ['docs']],
    ['eslint.config.mjs', ['tooling']],
    ['VERSION', []],
    ['CHANGELOG.md', []],
    ['docs/DECISIONS.md', []],
    ['somewhere/else.txt', ['other']],
  ];
  for (const [path, areas] of cases) {
    assert.deepEqual(areasOfFile(vocabulary, path).sort(), [...areas].sort(), path);
  }
});

test('a vocabulary not in the expected shape is a fault', () => {
  for (const broken of [
    'not json',
    JSON.stringify({ areas: [] }),
    JSON.stringify({ bookkeeping: [], areas: [{ name: 'other', hard: false, paths: ['x'] }] }),
    JSON.stringify({ bookkeeping: [], areas: [{ name: 'a', hard: 'yes', paths: ['x'] }] }),
    JSON.stringify({ bookkeeping: [], areas: [{ name: 'a', hard: true, paths: [] }] }),
    JSON.stringify({
      bookkeeping: [],
      areas: [
        { name: 'a', hard: true, paths: ['x'] },
        { name: 'a', hard: false, paths: ['y'] },
      ],
    }),
  ]) {
    writeFileSync(join(vocabularyDirectory, 'broken.json'), broken);
    assert.throws(
      () => readVocabulary(join(vocabularyDirectory, 'broken.json')),
      /the area vocabulary .* (cannot be read|is not in the expected shape)/,
      broken,
    );
  }
});

test('the glob match, on made-up globs and paths at growing sizes', () => {
  for (const [glob, path, expected] of [
    ['a/**', 'a/b/c', true],
    ['a/**', 'a', true],
    ['**/c', 'a/b/c', true],
    ['a/**/c', 'a/c', true],
    ['a/**/c', 'a/b/x/c', true],
    ['a/*/c', 'a/b/c', true],
    ['a/*/c', 'a/b/x/c', false],
    ['a/b*', 'a/bcd', true],
    ['a/b*', 'a/xb', false],
    ['a/*.test.mjs', 'a/x.test.mjs', true],
    ['a/*.test.mjs', 'a/x.test.mjs.bak', false],
    ['.claude/tests/delivery*.test.mjs', '.claude/tests/delivery-queue.test.mjs', true],
    ['.claude/tests/delivery*.test.mjs', '.claude/tests/fire-check.test.mjs', false],
    ['a', 'a/b', false],
    ['', '', true],
  ]) {
    assert.equal(globMatches(glob, path), expected, `${glob} ~ ${path}`);
  }
  for (const size of [1_000, 10_000, 100_000]) {
    const deep = Array.from({ length: size }, () => 'd').join('/');
    assert.equal(globMatches('apps/**', `apps/${deep}`), true);
    assert.equal(globMatches('**/x/**/y', `${deep}/x/${deep}/y`), true);
    assert.equal(globMatches('**/x/**/y', `${deep}/x/${deep}/z`), false);
    assert.equal(globMatches('a/*b', `a/${'a'.repeat(size * 10)}b`), true);
    assert.equal(globMatches('a/*b*c', `a/${'b'.repeat(size * 10)}`), false);
    assert.equal(globMatches(`${'*'.repeat(size)}`, 'x'), true);
    assert.deepEqual(areasOfFile(vocabulary, `web/src/lib/${'x'.repeat(size * 10)}.ts`), ['web']);
    assert.deepEqual(areasOfFile(vocabulary, `${'/'.repeat(size)}`), ['other']);
  }
});

// ---------------------------------------------------------------------------
// What an issue says
// ---------------------------------------------------------------------------

test('## Touches is read as area names and nothing else; anything else counts as every area', () => {
  const read = (text) => declaredAreas(text, vocabulary);
  assert.deepEqual(read('## Touches\n\nauth, docs\n'), {
    every: false,
    areas: ['auth', 'docs'],
  });
  assert.deepEqual(read('## Touches\n\nauth, docs\n\nDepends on #148\nRelated: #150\n'), {
    every: false,
    areas: ['auth', 'docs'],
  });
  assert.equal(read('## Touches\nauth\nDepends on #148\n').every, true, 'no blank line before it');
  assert.deepEqual(read('x\r\n## Touches\r\n\r\n- `auth`\r\n- migrations\r\n## Next\r\nfoo\r\n'), {
    every: false,
    areas: ['auth', 'migrations'],
  });
  assert.deepEqual(read('## Touches\nauth docs,\tauth\n### Sub\nnot read'), {
    every: false,
    areas: ['auth', 'docs'],
  });
  assert.deepEqual(read('```\n## Touches\nnope\n```\n## Touches\nnotifications\n'), {
    every: false,
    areas: ['notifications'],
  });
  assert.equal(read('## Touches\nauth (the login)\n').every, true);
  assert.equal(read('## Touches\n\n').every, true);
  assert.equal(read('## Touches\n#127 says so\n').every, true, 'a word that is no area');
  assert.equal(read('### Touches\nauth\n').every, true, 'another heading level');
  assert.equal(read('## Touches auth\n').every, true);
  assert.equal(read('').every, true);
  assert.equal(read(null).every, true);
  assert.equal(read('```\n## Touches\nauth\n').every, true, 'inside a fence never closed');

  for (const size of [1_000, 100_000, 1_000_000]) {
    assert.deepEqual(read(`## Touches\n${'auth, '.repeat(size / 6)}\n`), {
      every: false,
      areas: ['auth'],
    });
    assert.equal(read(`## Touches\n${'x'.repeat(size)}\n`).every, true);
    assert.ok(read(`## Touches\n${'x'.repeat(size)}\n`).why.length < 120, 'the reason stays short');
    assert.equal(read(`${'#'.repeat(size)}\n## Touches\ndocs`).every, false);
    assert.equal(read(`${'```\n'.repeat(size / 4)}## Touches\ndocs`).every, false);
    assert.equal(read(`## Touches\n${' '.repeat(size)}\n${'\n'.repeat(size)}docs`).every, false);
    assert.equal(read(`${'## Touches\n'.repeat(size / 11)}`).every, true);
  }
});

test('Depends on lines are read anywhere, every #<number> on them, digits only, at any length', () => {
  assert.deepEqual(
    dependencies('Depends on #148\nRelated: #150\nDepends on #149 and #7'),
    [7, 148, 149],
  );
  // Every issue a `Depends on` line names, from the phrase to the line's end.
  assert.deepEqual(dependencies('Depends on #1, #2'), [1, 2]);
  assert.deepEqual(dependencies('Depends on: #3 and #4 (see #5)\r\n#6'), [3, 4, 5]);
  assert.deepEqual(dependencies('#9 Depends on #10'), [10]);
  assert.deepEqual(
    dependencies('x Depends on #12, Depends on #012, Depends on #, #1234567890\ndepends on #5'),
    [12],
  );
  assert.deepEqual(dependencies('Depends on nothing\n#7'), []);
  assert.deepEqual(dependencies(null), []);
  for (const size of [1_000, 100_000, 1_000_000]) {
    assert.deepEqual(dependencies('Depends on #1 '.repeat(size / 14)), [1]);
    assert.deepEqual(dependencies(`Depends on ${'#1, '.repeat(size / 4)}`), [1]);
    assert.deepEqual(dependencies(`Depends on ${'#'.repeat(size)}`), []);
    assert.deepEqual(dependencies('Depends on x\n'.repeat(size / 13)), []);
    assert.deepEqual(dependencies(`${'Depends on '.repeat(size / 11)}#3`), [3]);
    const many = Array.from({ length: size / 10 }, (_, k) => `#${k + 1}`).join(', ');
    assert.equal(dependencies(`Depends on ${many}`).length, size / 10);
    assert.deepEqual(dependencies(`Depends on #${'9'.repeat(size)}`), []);
    assert.deepEqual(dependencies('Depends on #'.repeat(size / 12)), []);
  }
});

// ---------------------------------------------------------------------------
// State that survives, and state that is broken
// ---------------------------------------------------------------------------

test('state written by one process is read by a new one: the task, its step, its rounds and its token', (t) => {
  const f = fixture(t);
  const s = dayTask(f, 'day-a');
  const sha = 'a'.repeat(40);
  ok(
    f.q(
      'update',
      'day-a',
      '--session',
      s,
      '--next',
      'step 6: tester',
      '--round',
      '--pr',
      '151',
      '--tester',
      sha,
      '--reviewer',
      sha,
      '--verified-main',
      'b'.repeat(40),
      '--worktree',
      '/tmp/day-a-tester',
    ),
    'update',
  );
  ok(f.q('update', 'day-a', '--session', s, '--round'), 'a second round, from another process');
  assert.equal(f.q('update', 'day-a', '--session', s, '--mr', '151').status, 2, '--mr is gone');
  for (const bad of ['0', '-1', 'x', '!151', '#151']) {
    assert.equal(f.q('update', 'day-a', '--session', s, '--pr', bad).status, 2, `--pr ${bad}`);
  }
  const token = tokenOf(ok(f.q('lock', 'day-a', '--session', s), 'lock'));
  const shown = ok(f.q('show', 'day-a'), 'show from a new process');
  for (const line of [
    /^day-a: delivering, holding the lock$/m,
    /^ {2}origin: day \(the owner's session; a fire adopts it only once detached\)$/m,
    /correction rounds: 2/,
    /PR: #151/,
    new RegExp(`verified: tester ${sha}, reviewer ${sha}, against main b{40}`),
    /worktrees: \/tmp\/day-a, \/tmp\/day-a-tester/,
    /next: step 9: integrate and number, under the lock/,
  ]) {
    assert.match(shown, line);
  }
  ok(f.q('check', 'day-a', token), 'the token from a new process');
  const state = f.state();
  assert.equal(state.lock.token, token);
  assert.equal(state.tasks['day-a'].rounds, 2);
  assert.equal(state.tasks['day-a'].pr, 151);
  assert.equal(statMode(f.stateFile), 0o600);
  assert.equal(statMode(join(f.work, '.git', 'delivery-queue')), 0o700);
});

const statMode = (path) => statSync(path).mode & 0o777;

test('a state that is not the queue’s is a fault that changes nothing, never an empty queue', (t) => {
  const f = fixture(t);
  const s = dayTask(f, 'day-a');
  ok(f.q('lock', 'day-a', '--session', s), 'lock');
  const good = readFileSync(f.stateFile, 'utf8');
  const broken = [
    'not json',
    '',
    '[]',
    'null',
    JSON.stringify({ ...JSON.parse(good), version: 2 }),
    JSON.stringify({ ...JSON.parse(good), tasks: [] }),
    JSON.stringify({ ...JSON.parse(good), lock: { key: 'day-z', token: 'a'.repeat(32) } }),
    JSON.stringify({ ...JSON.parse(good), lock: { key: 'day-a', token: 'short' } }),
    good.replace('"working"', '"flying"').replace('"delivering"', '"flying"'),
    `${good.slice(0, -10)}`,
    `{"version":1,${' '.repeat(5 * 1024 * 1024)}}`,
  ];
  for (const text of broken) {
    writeFileSync(f.stateFile, text);
    for (const args of [
      ['status'],
      ['lock', 'day-a', '--session', s],
      ['check', 'day-a', 'a'.repeat(32)],
      ['unpause'],
    ]) {
      const result = f.q(...args);
      assert.equal(
        result.status,
        1,
        `${args[0]} on ${JSON.stringify(text.slice(0, 40))}: ${result.stderr}`,
      );
      assert.match(result.stderr, /^fault: [^\n]+\[D16\]\n$/);
    }
    assert.equal(readFileSync(f.stateFile, 'utf8'), text, 'the broken state is left as found');
  }
  rmSync(f.stateFile);
  symlinkSync('/etc/hosts', f.stateFile);
  assert.equal(f.q('status').status, 1, 'a link in its place');
  rmSync(f.stateFile);
  mkdirSync(f.stateFile);
  assert.equal(f.q('status').status, 1, 'a directory in its place');

  for (const text of ['x', '{', JSON.stringify({ version: 1 })]) {
    assert.throws(() => parseState(text), /nothing was changed|shape|not JSON/);
  }
});

test('a mutex left by a process that died is taken over once stale, and one held fresh is waited for', (t) => {
  const f = fixture(t);
  const s = dayTask(f, 'day-a');
  const mutex = join(f.work, '.git', 'delivery-queue', 'state.lock');
  writeFileSync(mutex, '');
  const started = Date.now();
  const held = f.q('update', 'day-a', '--session', s, '--next', 'x');
  assert.equal(held.status, 1, held.stderr);
  assert.match(held.stderr, /in use by another process/);
  assert.ok(Date.now() - started >= 4_000, 'it waited for the mutex');
  f.age(mutex, 1);
  ok(
    f.q('update', 'day-a', '--session', s, '--next', 'after a stale mutex'),
    'a stale mutex is taken over',
  );
  assert.match(ok(f.q('show', 'day-a'), 'show'), /next: after a stale mutex/);
});

// ---------------------------------------------------------------------------
// Signs of life
// ---------------------------------------------------------------------------

// A session's transcript is looked for in the folders Claude Code names after
// this repository's checkouts — the main one and each worktree — and nowhere
// else: a session of another project with the same id would not count.
test("a session's transcript is read only from the folders named after this repository's checkouts", (t) => {
  const f = fixture(t);
  const elsewhere = join(f.home, '.claude', 'projects', '-somewhere-else');
  const stranger = f.session(elsewhere);
  refused(
    f.q(
      'start',
      'day-a',
      '--day',
      '--session',
      stranger,
      '--branch',
      'chore/day-a',
      '--worktree',
      '/tmp/day-a',
      '--areas',
      'docs',
    ),
    /^refused: no transcript of the session [0-9a-f-]{36} under .*\/\.claude\/projects in the folders of this repository's checkouts: /,
    'a transcript of another project',
  );

  // A worktree with a dot in its path: Claude Code names its folder with `-`.
  const tree = join(f.root, 'trees', 'day.b');
  gitRun(f.work, 'worktree', 'add', '--quiet', '-b', 'chore/day-b', tree);
  const treeProjects = join(f.home, '.claude', 'projects', projectName(tree));
  assert.ok(projectName(tree).endsWith('-trees-day-b'));
  const inTree = f.session(treeProjects);
  ok(
    f.q(
      'start',
      'day-b',
      '--day',
      '--session',
      inTree,
      '--branch',
      'chore/day-b',
      '--worktree',
      tree,
      '--areas',
      'docs',
    ),
    'a session started in a worktree',
  );
  // Asked from the worktree, the queue is the same one and so is its life.
  const fromTree = ok(f.qAt(tree, 'status'), 'status from the worktree');
  assert.match(fromTree, /^day-b +day +working +- +slot +[0-9a-f]{8} +alive, last sign 0 min ago/m);
  assert.equal(fromTree, ok(f.q('status'), 'status from the main checkout'));
  // Its folder aged, the session is dead; its other copy elsewhere is not read.
  const state = f.state();
  state.tasks['day-b'].updatedAt = new Date(Date.now() - 120 * 60_000).toISOString();
  f.writeState(state);
  f.age(join(treeProjects, `${inTree}.jsonl`), 120);
  writeFileSync(join(elsewhere, `${inTree}.jsonl`), '{}\n');
  assert.match(ok(f.q('status'), 'status'), /^day-b .*DEAD, last sign 120 min ago/m);

  assert.deepEqual(projectNames('/Users/me/src/app'), ['-Users-me-src-app']);
  assert.deepEqual(projectNames('/Users/me/Projects/app/.claude/worktrees/x'), [
    '-Users-me-Projects-app--claude-worktrees-x',
  ]);
  assert.deepEqual(projectNames('/Users/me/src/my_app v2'), [
    '-Users-me-src-my-app-v2',
    '-Users-me-src-my_app v2',
  ]);
});

// ---------------------------------------------------------------------------
// A dead holder
// ---------------------------------------------------------------------------

test("a dead holder's lock is released only when its session shows no sign of life, and the old token is refused afterwards", (t) => {
  const f = fixture(t, { issues: [issue(700, { body: touches('docs') })] });
  const old = fireTask(f, 700);
  const subagent = f.subagent(old);
  const t1 = tokenOf(ok(f.q('lock', '700', '--session', old), 'lock'));
  const next = f.session();
  const ageUpdate = (minutes) => {
    const state = f.state();
    state.tasks['700'].updatedAt = new Date(Date.now() - minutes * 60_000).toISOString();
    f.writeState(state);
  };

  refused(
    f.q('adopt', '700', '--session', next),
    /is alive: its last sign was 0 min ago, within the 90 min threshold/,
    'everything fresh',
  );
  ageUpdate(120);
  refused(f.q('adopt', '700', '--session', next), /is alive/, 'its transcript is fresh');
  f.age(join(f.projects, `${old}.jsonl`), 120);
  refused(f.q('adopt', '700', '--session', next), /is alive/, "a sub-agent's transcript is fresh");
  f.age(subagent, 60);
  refused(
    f.q('adopt', '700', '--session', next),
    /last sign was 60 min ago/,
    'a sub-agent wrote an hour ago',
  );
  f.age(subagent, 120);
  ok(f.q('set', 'stale-minutes', '240'), 'a longer threshold');
  refused(
    f.q('adopt', '700', '--session', next),
    /within the 240 min threshold/,
    'two hours under four',
  );
  ok(f.q('set', 'stale-minutes', '90'), 'back to 90');
  ageUpdate(120);
  assert.match(ok(f.q('status'), 'status'), /DEAD, last sign 120 min ago/);
  refused(
    f.q('adopt', '700', '--session', randomUUID()),
    /no transcript of the session/,
    'an adopter with no transcript',
  );
  assert.equal(f.state().lock.token, t1, 'refused adoptions changed nothing');

  const adopted = ok(f.q('adopt', '700', '--session', next), 'adopt the dead holder');
  assert.match(adopted, /showed no sign of life for 120 min, past the 90 min threshold/);
  const t2 = tokenOf(adopted);
  assert.ok(t2 && t2 !== t1, 'a new token');
  refused(f.q('check', '700', t1), /stale token/, 'the old token is refused for a check');
  refused(f.q('unlock', '700', t1, '--next', 'x'), /stale token/, '…and for a release');
  refused(
    f.q('finish', '700', 'delivered', '--session', next, '--token', t1),
    /needs its current token/,
    '…and to finish',
  );
  refused(
    f.q('update', '700', '--session', old, '--next', 'x'),
    /belongs to the session/,
    'the old session stops acting',
  );
  ok(f.q('check', '700', t2), 'the new token');
  assert.equal(f.state().tasks['700'].adoptions.length, 1);

  // Its own session renews its token, and a detached task needs no verdict.
  const t3 = tokenOf(ok(f.q('adopt', '700', '--session', next), 'renew'));
  assert.ok(t3 && t3 !== t2);
  refused(f.q('check', '700', t2), /stale token/, 'the renewed-away token');
  ok(f.q('unlock', '700', t3, '--next', 'step 6: tester'), 'release');
  ok(
    f.q(
      'update',
      '700',
      '--session',
      next,
      '--state',
      'paused',
      '--reason',
      'Docker did not answer',
      '--detach',
    ),
    'pause and detach',
  );
  assert.match(
    ok(f.q('adopt', '700', '--session', f.session()), 'adopt detached'),
    /its session detached/,
  );
});

test('liveness reads the newest of the transcripts and the task’s update', (t) => {
  const f = fixture(t);
  const id = f.session();
  const agent = f.subagent(id);
  const task = { session: id, updatedAt: new Date(Date.now() - 200 * 60_000).toISOString() };
  f.age(join(f.projects, `${id}.jsonl`), 150);
  f.age(agent, 100);
  assert.deepEqual(liveness(task, 90, Date.now(), [f.projects]), {
    alive: false,
    minutes: 100,
    transcript: true,
  });
  assert.equal(liveness(task, 120, Date.now(), [f.projects]).alive, true);
  assert.deepEqual(liveness({ ...task, session: randomUUID() }, 90, Date.now(), [f.projects]), {
    alive: false,
    minutes: 200,
    transcript: false,
  });
  assert.deepEqual(liveness(task, 90, Date.now(), []), {
    alive: false,
    minutes: 200,
    transcript: false,
  });
  assert.equal(liveness({ ...task, session: null }, 90).alive, false);
});

// ---------------------------------------------------------------------------
// Decision ids
// ---------------------------------------------------------------------------

test('tasks reserving decision ids at once get different ids, after the highest on origin/main, never reused', async (t) => {
  const f = fixture(t);
  const keys = ['day-a', 'day-b', 'day-c', 'day-d', 'day-e', 'day-f'];
  const sessions = new Map(keys.map((key) => [key, dayTask(f, key)]));
  const results = await Promise.all(
    keys.map((key) => f.qAsync('reserve', key, '2', '--session', sessions.get(key))),
  );
  const ids = results.flatMap((result) => {
    assert.equal(result.status, 0, result.stderr);
    return [...result.stdout.matchAll(/D(\d+)/g)].map((match) => Number(match[1]));
  });
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12, `the same id twice: ${ids}`);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, at) => 217 + at),
  );

  // An id left by a stopped task stays unused; one added on main outside the
  // queue moves the counter past it.
  ok(f.q('finish', 'day-a', 'stopped', '--session', sessions.get('day-a')), 'stop');
  assert.match(
    ok(f.q('reserve', 'day-b', '--session', sessions.get('day-b')), 'reserve'),
    /D229$/m,
  );
  writeFileSync(join(f.work, 'docs', 'DECISIONS.md'), '## D240 — made outside the queue\n');
  gitRun(f.work, 'commit', '--quiet', '-am', 'd240');
  gitRun(f.work, 'push', '--quiet', 'origin', 'main');
  gitRun(f.work, 'fetch', '--quiet', 'origin');
  assert.match(
    ok(f.q('reserve', 'day-b', '--session', sessions.get('day-b')), 'reserve'),
    /D241$/m,
  );
  for (const bad of ['0', '6', 'x']) {
    assert.equal(
      f.q('reserve', 'day-b', bad, '--session', sessions.get('day-b')).status,
      2,
      `reserve ${bad}`,
    );
  }
});

test('the highest decision id is read from D<n> headings only, at any length; the kit’s DK<n> do not count', () => {
  assert.equal(highestDecision('## D12 — a\n## D9 — b\n## D100x\nD300\n### D400 — c\n## D7'), 12);
  assert.equal(highestDecision('## DK7 — the kit\n## D3 — b\n## DK99\n'), 3);
  assert.equal(highestDecision('## DK1 — a\n## DK2 — b\n'), null);
  assert.equal(highestDecision('nothing'), null);
  for (const size of [1_000, 100_000, 1_000_000]) {
    assert.equal(highestDecision(`## D5 — x\n${'## D'.repeat(size / 4)}`), 5);
    assert.equal(highestDecision(`## D${'9'.repeat(size)} — x`), null);
    assert.equal(highestDecision('## D1 — x\n'.repeat(size / 10)), 1);
  }
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("status lists each task's state, PR, slot or lock, reason and next step", (t) => {
  const f = fixture(t);
  const a = dayTask(f, 'day-a');
  const b = dayTask(f, 'day-b');
  const c = dayTask(f, 'day-c');
  const d = dayTask(f, 'day-d');
  ok(
    f.q(
      'update',
      'day-a',
      '--session',
      a,
      '--pr',
      '151',
      '--next',
      'step 9: follow the main workflow run',
    ),
    'a',
  );
  ok(f.q('lock', 'day-a', '--session', a), 'a locks');
  ok(f.q('update', 'day-b', '--session', b, '--pr', '152', '--next', 'step 6: tester'), 'b');
  ok(
    f.q(
      'update',
      'day-c',
      '--session',
      c,
      '--state',
      'awaiting-lock',
      '--pr',
      '153',
      '--next',
      'step 9: take the lock',
    ),
    'c',
  );
  ok(
    f.q(
      'update',
      'day-d',
      '--session',
      d,
      '--state',
      'paused',
      '--reason',
      'HTTP 429\nfrom the plan',
      '--next',
      'step 5: developer',
      '--detach',
    ),
    'd',
  );
  const out = ok(f.q('status'), 'status');
  const row = (key) => out.split('\n').find((line) => line.startsWith(`${key} `));
  assert.match(
    out,
    /^Delivery queue · 1 of 3 slots in use · lock: day-a since .* · queue running · dead after 90 min without a sign of life$/m,
  );
  assert.match(out, /^Task +Origin +State +PR +Holds +Session +Life +Next +Reason$/m);
  assert.match(
    row('day-a'),
    /^day-a +day +delivering +#151 +lock +[0-9a-f]{8} +alive, last sign 0 min ago +step 9: integrate and number, under the lock +-$/,
  );
  assert.match(row('day-b'), /^day-b +day +working +#152 +slot +.* +step 6: tester +-$/);
  assert.match(row('day-c'), /^day-c +day +awaiting-lock +#153 +- +.* +step 9: take the lock +-$/);
  assert.match(
    row('day-d'),
    /^day-d +day +paused +- +- +\(detached\) +detached +step 5: developer +HTTP 429 from the plan$/,
  );
  assert.doesNotMatch(out, /[0-9a-f]{32}/, 'status shows no token');

  ok(f.q('pause', '--reason', 'smoke failed and the rollback did not verify'), 'pause');
  assert.match(
    ok(f.q('status'), 'status'),
    /queue PAUSED since .*: smoke failed and the rollback did not verify/,
  );
  // One argument stays under the 128 KiB Linux allows it.
  for (const size of [1_000, 10_000, 50_000]) {
    const text = `${'\u0007\n '.repeat(size / 3)}x${'y'.repeat(size)}`;
    ok(f.q('update', 'day-b', '--session', b, '--next', text), `next of ${size}`);
    const next = f.state().tasks['day-b'].next;
    assert.ok(
      next.length <= 200 && [...next].every((c) => c.codePointAt(0) > 0x1f),
      `${size}: ${next.length}`,
    );
  }
});

// `status --json` is what `.claude/scripts/fire-check.mjs` reads for the work
// Resume first would take (D17): each task's origin and its life in the
// table's words — `alive`, `DEAD` or `detached` — with the lock, the pause
// and the slots, and no token; the text form is unchanged.
test('status --json gives each task its origin, state, holdings and life as the table does, and no token', (t) => {
  const f = fixture(t, {
    issues: [issue(731, { body: touches('docs') }), issue(732, { body: touches('tooling') })],
  });
  const quiet = (key, session) => {
    f.age(join(f.projects, `${session}.jsonl`), 120);
    const state = f.state();
    state.tasks[key].updatedAt = new Date(Date.now() - 120 * 60_000).toISOString();
    f.writeState(state);
  };
  fireTask(f, 731);
  const deadFire = fireTask(f, 732);
  const deadDay = dayTask(f, 'day-q');
  const detached = dayTask(f, 'day-r');
  ok(f.q('update', '731', '--session', f.state().tasks['731'].session, '--pr', '90'), 'pr');
  ok(f.q('lock', 'day-q', '--session', deadDay), 'day-q locks');
  ok(
    f.q(
      'update',
      'day-r',
      '--session',
      detached,
      '--state',
      'paused',
      '--reason',
      'HTTP 429',
      '--detach',
    ),
    'day-r detaches',
  );
  quiet('732', deadFire);
  quiet('day-q', deadDay);

  const text = ok(f.q('status'), 'status');
  const json = JSON.parse(ok(f.q('status', '--json'), 'status --json'));
  assert.doesNotMatch(JSON.stringify(json), /[0-9a-f]{32}/, 'no token in the JSON');
  assert.equal(json.slots, 3);
  assert.equal(json.used, 2);
  assert.equal(json.staleMinutes, 90);
  assert.equal(json.lock.task, 'day-q');
  assert.equal(json.paused, null);
  const rows = new Map(json.tasks.map((task) => [task.task, task]));
  assert.deepEqual(
    json.tasks.map((task) => task.task),
    ['731', '732', 'day-q', 'day-r'],
    'the order of the table',
  );
  for (const [key, origin, state, holds, life] of [
    ['731', 'fire', 'working', 'slot', 'alive'],
    ['732', 'fire', 'working', 'slot', 'DEAD'],
    ['day-q', 'day', 'delivering', 'lock', 'DEAD'],
    ['day-r', 'day', 'paused', null, 'detached'],
  ]) {
    const row = rows.get(key);
    assert.deepEqual(
      [row.origin, row.state, row.holds, row.life],
      [origin, state, holds, life],
      key,
    );
    // The table says the same of each.
    const line = text
      .split('\n')
      .find((entry) => entry.startsWith(`${key === '731' || key === '732' ? `#${key}` : key} `));
    assert.ok(line.includes(` ${origin} `) && line.includes(life), `${key}: ${line}`);
  }
  assert.equal(rows.get('731').pr, 90);
  assert.equal(rows.get('732').pr, null);
  assert.equal(rows.get('day-r').session, null);
  assert.equal(rows.get('day-r').minutes, null);
  assert.equal(rows.get('day-r').reason, 'HTTP 429');
  assert.ok(rows.get('732').minutes >= 120);

  ok(f.q('pause', '--reason', 'smoke failed'), 'pause');
  assert.equal(JSON.parse(ok(f.q('status', '--json'), 'paused')).paused.reason, 'smoke failed');
  assert.equal(f.q('status', '--jsn').status, 2, 'an unknown flag is wrong usage');
  // An empty queue is an empty list, not an absent one.
  const empty = fixture(t);
  assert.deepEqual(JSON.parse(ok(empty.q('status', '--json'), 'empty')).tasks, []);
});

test('free text becomes one short line, at any length', () => {
  assert.equal(oneLine('a b\u0085c\td'), 'a b c d');
  assert.equal(oneLine('  a  \n\n b  '), 'a b');
  for (const size of [1_000, 100_000, 1_000_000]) {
    assert.equal(oneLine('\u0000'.repeat(size)), '');
    assert.equal(oneLine(' \n'.repeat(size)), '');
    assert.equal(oneLine('x'.repeat(size)).length, 200);
    assert.equal(oneLine('x '.repeat(size), 50).length, 50);
  }
});

// ---------------------------------------------------------------------------
// The owner's day task
// ---------------------------------------------------------------------------

test('a day task is adopted only once its session detaches it, however long it was quiet; a fire task in the same state is adopted', (t) => {
  const f = fixture(t, { issues: [issue(710, { body: touches('docs') })] });
  const owner = dayTask(f, 'day-owner');
  const fire = fireTask(f, 710);
  // Both sessions quiet for two hours: their transcripts and their updates.
  const age = (key, session) => {
    f.age(join(f.projects, `${session}.jsonl`), 120);
    const state = f.state();
    state.tasks[key].updatedAt = new Date(Date.now() - 120 * 60_000).toISOString();
    f.writeState(state);
  };
  age('day-owner', owner);
  age('710', fire);
  const status = ok(f.q('status'), 'status');
  assert.match(status, /^day-owner +day +working .*DEAD, last sign 120 min ago/m);
  assert.match(status, /^#710 +fire +working .*DEAD, last sign 120 min ago/m);

  const fireSession = f.session();
  refused(
    f.q('adopt', 'day-owner', '--session', fireSession),
    /^refused: day-owner is a day task of the session [0-9a-f-]{36}: it is adopted only once that session detaches it \(update day-owner --session <its id> --detach\), whatever its last sign of life\. Leave it\n$/,
    'a quiet day task',
  );
  assert.equal(f.state().tasks['day-owner'].session, owner, 'the refusal changed nothing');
  assert.match(
    ok(f.q('adopt', '710', '--session', fireSession), 'the quiet fire task'),
    /adopted #710: its session .* showed no sign of life for 120 min/,
  );

  // Its own session may still act on it, and detaching hands it over.
  ok(
    f.q(
      'update',
      'day-owner',
      '--session',
      owner,
      '--next',
      'stop: finish it as stopped',
      '--detach',
    ),
    'the owner detaches it',
  );
  assert.match(
    ok(f.q('adopt', 'day-owner', '--session', fireSession), 'adopt once detached'),
    /adopted day-owner: its session detached/,
  );
  assert.match(ok(f.q('show', 'day-owner'), 'show'), /^ {2}origin: day /m);
  assert.match(
    ok(f.q('show', '710'), 'show'),
    /^ {2}origin: fire \(a session of the delivery cycle\)$/m,
  );
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const merges = (f) => f.ghCalls().filter((args) => args[0] === 'pr' && args[1] === 'merge');

test('the queue merges only under the current token, and runs gh pr merge itself with the checked SHA', (t) => {
  const f = fixture(t);
  const a = dayTask(f, 'day-a');
  const b = dayTask(f, 'day-b');
  const token = tokenOf(ok(f.q('lock', 'day-a', '--session', a), 'lock'));

  // Wrong usage changes nothing and asks GitHub nothing.
  for (const args of [
    ['merge', 'day-a', '--sha', SHA40],
    ['merge', 'day-a', '--token', token],
    ['merge', 'day-a', '--token', token, '--sha', SHA40.slice(0, 12)],
    ['merge', 'day-a', '--token', token, '--sha', `${SHA40}x`],
    ['merge', 'day-a', '--token', token, '--sha', `${SHA40}${SHA40.slice(0, 24)}`],
    ['merge', 'day-a', '--token', token, '--sha', SHA40.toUpperCase()],
    ['merge', 'day-a', '--token', 'TOKEN', '--sha', SHA40],
    ['merge', 'day-a', '--token', token.toUpperCase(), '--sha', SHA40],
    ['merge', 'day-a', 'extra', '--token', token, '--sha', SHA40],
    ['merge', '--token', token, '--sha', SHA40],
    ['merge', 'day-a', '--token', token, '--sha', SHA40, '--admin'],
    ['merge', 'day-a', '--token', token, '--sha', SHA40, '--auto'],
  ]) {
    assert.equal(f.q(...args).status, 2, args.join(' '));
  }
  // No pull request recorded yet.
  refused(
    f.q('merge', 'day-a', '--token', token, '--sha', SHA40),
    /^refused: day-a has no pull request recorded: record it with update day-a --session <id> --pr <n>\n$/,
    'no PR',
  );
  ok(f.q('update', 'day-a', '--session', a, '--pr', '151'), 'record the PR');
  ok(f.q('update', 'day-b', '--session', b, '--pr', '152'), 'record the PR');

  // A token that is not the current one is refused before gh is asked.
  for (const [key, stale] of [
    ['day-a', 'f'.repeat(32)],
    ['day-b', token],
  ]) {
    refused(
      f.q('merge', key, '--token', stale, '--sha', SHA40),
      /stale token: .* nothing was merged\. Stop acting, read the actual state — the PR, main's workflow run, the tag — and queue again/,
      `${key} with ${stale}`,
    );
  }
  ok(f.q('pause', '--reason', 'smoke failed'), 'pause');
  refused(
    f.q('merge', 'day-a', '--token', token, '--sha', SHA40),
    /the queue is paused: smoke failed; nothing is merged/,
    'paused',
  );
  ok(f.q('unpause'), 'unpause');
  assert.deepEqual(merges(f), [], 'no refused merge reached gh');

  // The current token: gh is run with the merge the procedure requires, a
  // merge commit of exactly the checked head, no auto-merge, no admin
  // override, no branch deletion of its own.
  const merged = ok(f.q('merge', 'day-a', '--token', token, '--sha', SHA40), 'merge');
  assert.deepEqual(merges(f), [
    ['pr', 'merge', '151', '--repo', REPO, '--merge', '--match-head-commit', SHA40],
  ]);
  assert.match(
    merged,
    /^gh pr merge 151 --repo acme\/widgets --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567: exit 0\n✓ Merged pull request acme\/widgets#151 \(Widgets\)\nday-a: #151 merged at 0123456789abcdef0123456789abcdef01234567\. Follow the main workflow's run for the merge commit, verify, tag \(step 9\)\.\n$/,
  );
  assert.equal(
    f.state().tasks['day-a'].next,
    'step 9: #151 merged at 0123456789ab: follow the run, verify, tag',
  );

  // gh's refusal is a fault with its output, and the step says to read the PR.
  f.setMerge({
    status: 1,
    stderr:
      'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n',
  });
  const failed = f.q('merge', 'day-a', '--token', token, '--sha', SHA40);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(
    failed.stderr,
    /^fault: gh pr merge 151 .* failed \(exit 1\); read the PR before acting again \[D16\]\n$/,
  );
  assert.match(failed.stdout, /Head branch was modified/);
  assert.match(
    f.state().tasks['day-a'].next,
    /^step 9: the merge of #151 at 0123456789ab was asked of GitHub at .*: read the PR before acting$/,
  );
  assert.equal(merges(f).length, 2);

  // After the release the old token merges nothing.
  ok(f.q('unlock', 'day-a', token, '--next', 'step 9: fix the branch'), 'release');
  refused(
    f.q('merge', 'day-a', '--token', token, '--sha', SHA40),
    /stale token: .*the lock is free/,
    'released',
  );
  assert.equal(merges(f).length, 2);
  // Every call the queue made named the configured repository.
  for (const args of f.ghCalls()) assert.equal(args[args.indexOf('--repo') + 1], REPO);
});

// Recovery with `delivery.rollback` empty is a revert pull request through
// the same lock (`.claude/scheduled/delivery-cycle.md`, step 9, A failed run
// after the merge): the task that merged records the revert's pull request
// with `update --pr`, while it still holds the lock, and merges it with the
// same `merge` and token. Once the lock is let go, neither merge is possible.
test('a task that merged records its revert pull request and merges it with the same token under the lock it still holds', (t) => {
  const f = fixture(t);
  const a = dayTask(f, 'day-a');
  const token = tokenOf(ok(f.q('lock', 'day-a', '--session', a), 'lock'));
  ok(f.q('update', 'day-a', '--session', a, '--pr', '151'), 'the PR');
  ok(f.q('merge', 'day-a', '--token', token, '--sha', SHA40), 'the first merge');

  // The run of the merge commit failed: the revert pull request, recorded.
  const revert = 'fedcba9876543210fedcba9876543210fedcba98';
  const recorded = ok(
    f.q('update', 'day-a', '--session', a, '--pr', '160', '--worktree', '/tmp/revert-day-a'),
    'the revert PR recorded under the lock',
  );
  assert.match(recorded, /^day-a: delivering, holding the lock\n/);
  assert.match(recorded, /PR: #160/);
  assert.equal(f.state().lock.token, token, 'the lock and its token are kept');
  ok(f.q('check', 'day-a', token), 'the token is still current');
  const merged = ok(f.q('merge', 'day-a', '--token', token, '--sha', revert), 'the revert merge');
  assert.match(merged, /day-a: #160 merged at fedcba98/);
  assert.deepEqual(merges(f), [
    ['pr', 'merge', '151', '--repo', REPO, '--merge', '--match-head-commit', SHA40],
    ['pr', 'merge', '160', '--repo', REPO, '--merge', '--match-head-commit', revert],
  ]);
  assert.equal(
    f.state().tasks['day-a'].next,
    'step 9: #160 merged at fedcba987654: follow the run, verify, tag',
  );
  const ended = ok(
    f.q('finish', 'day-a', 'recovered', '--session', a, '--token', token),
    'recovered',
  );
  assert.match(ended, /left the queue: recovered; the lock is released\. Its worktrees: \/tmp\/day-a, \/tmp\/revert-day-a/);
  assert.equal(f.state().ended.at(-1).pr, 160);
  refused(
    f.q('merge', 'day-a', '--token', token, '--sha', revert),
    /day-a is not in the queue|stale token/,
    'nothing merges after the task left',
  );

  // A task that gave the lock back merges nothing, whatever it records.
  const b = dayTask(f, 'day-b');
  const second = tokenOf(ok(f.q('lock', 'day-b', '--session', b), 'lock'));
  ok(f.q('update', 'day-b', '--session', b, '--pr', '170'), 'its PR');
  ok(f.q('merge', 'day-b', '--token', second, '--sha', SHA40), 'its merge');
  ok(f.q('unlock', 'day-b', second, '--next', 'step 9: take the lock'), 'it lets the lock go');
  ok(f.q('update', 'day-b', '--session', b, '--pr', '171'), 'a revert PR recorded without the lock');
  refused(
    f.q('merge', 'day-b', '--token', second, '--sha', revert),
    /stale token: .*the lock is free/,
    'the revert without the lock',
  );
  assert.equal(merges(f).length, 3);
});

// ---------------------------------------------------------------------------
// Slots: a task that comes back
// ---------------------------------------------------------------------------

test('a task back from the lock or a pause takes its slot back over the limit, and a new start waits until fewer hold one', (t) => {
  const numbers = [720, 721, 722, 723, 724, 725];
  const f = fixture(t, { issues: numbers.map((n) => issue(n, { body: touches('docs') })) });
  const sessions = new Map();
  const start = (number) => {
    sessions.set(number, f.session());
    return f.q(
      'start',
      String(number),
      '--session',
      sessions.get(number),
      '--branch',
      `fix/t${number}`,
      '--worktree',
      `/tmp/t${number}`,
    );
  };
  const update = (number, ...args) =>
    f.q('update', String(number), '--session', sessions.get(number), ...args);
  for (const number of [720, 721, 722]) ok(start(number), `start ${number}`);
  // One waits for the lock and one pauses, so two more start.
  ok(update(720, '--state', 'awaiting-lock'), '720 waits');
  ok(update(721, '--state', 'paused', '--reason', 'HTTP 429'), '721 pauses');
  for (const number of [723, 724]) ok(start(number), `start ${number}`);
  assert.match(ok(f.q('status'), 'status'), /3 of 3 slots in use · lock: free/);

  // 720 takes the lock and gives it back; 721 comes back from its pause.
  const token = tokenOf(ok(f.q('lock', '720', '--session', sessions.get(720)), 'lock'));
  assert.match(
    ok(f.q('unlock', '720', token, '--next', 'step 9: the integration needs a fix'), 'unlock'),
    /working again, holding a slot \(4 of 3\)/,
  );
  ok(update(721, '--state', 'working', '--clear-reason'), '721 back from its pause');
  assert.match(
    ok(f.q('status'), 'status'),
    /^Delivery queue · 5 of 3 slots in use \(over the limit: a task back at work took its slot back; no new start until fewer than 3\) · /,
  );
  refused(start(725), /no slot is free: 5 of 3 in use/, 'a new start over the limit');
  refused(f.q('pick'), /No slot is free: take no new issue/, 'the pick over the limit');
  for (const number of [720, 721])
    ok(update(number, '--state', 'paused', '--reason', 'x'), `${number} pauses`);
  refused(start(725), /no slot is free: 3 of 3 in use/, 'at the limit');
  ok(update(722, '--state', 'awaiting-lock'), 'one more waits');
  ok(start(725), 'below the limit a new start goes');
});

// A fire that resumes a paused task finds it still paused: `adopt` hands it
// over as it is. Its `lock` is refused on one line naming the command that
// puts it back to work, a refusal the procedure does not read as past the
// bound, and changes nothing; put back, it takes its slot back over the limit
// and is granted the lock. A task awaiting the lock that another session
// adopts calls `lock` again and keeps its `waitingSince`, its place in line.
const slotsOf = (f) =>
  Number(/^Delivery queue · (\d+) of \d+ slots in use/.exec(ok(f.q('status'), 'status'))?.[1]);

test('a paused task adopted by another session is refused the lock, naming update --state working --clear-reason, until put back; then it holds a slot and takes the lock', (t) => {
  const numbers = [730, 731, 732, 733];
  const f = fixture(t, { issues: numbers.map((n) => issue(n, { body: touches('docs') })) });
  const first = fireTask(f, 730);
  ok(
    f.q(
      'update',
      '730',
      '--session',
      first,
      '--state',
      'paused',
      '--reason',
      'HTTP 429: the plan limit',
      '--next',
      'step 9: take the lock',
      '--detach',
    ),
    '730 pauses and detaches',
  );
  // Its pause freed its slot, and three more tasks fill them.
  const sessions = new Map([731, 732, 733].map((n) => [n, fireTask(f, n)]));
  assert.equal(slotsOf(f), 3, 'three of three slots, the paused task holding none');

  const fire = f.session();
  assert.match(
    ok(f.q('adopt', '730', '--session', fire), 'adopt'),
    /^adopted #730: its session detached\n#730: paused\n/,
  );
  const adopted = f.state().tasks['730'];
  assert.equal(adopted.state, 'paused', 'adopt leaves it paused');
  assert.equal(adopted.reason, 'HTTP 429: the plan limit');
  assert.equal(slotsOf(f), 3, 'adopted, it still holds no slot');

  // Not put back: one refusal line naming the command, and nothing changed.
  const asked = f.q('lock', '730', '--session', fire, '--wait', '1');
  refused(
    asked,
    new RegExp(
      `^refused: #730 is paused: put it back to work first with update 730 --session ${fire} --state working --clear-reason, then take the lock\\n$`,
    ),
    'the paused task asks for the lock',
  );
  assert.doesNotMatch(
    asked.stderr,
    /the queue is paused|stays awaiting the lock/,
    'not a refusal the procedure reads as past the bound',
  );
  assert.deepEqual(f.state().tasks['730'], adopted, 'the refusal changed nothing');
  assert.equal(f.state().lock, null, 'nobody holds the lock');

  // Put back, it takes its slot back over the limit, and then the lock.
  assert.match(
    ok(
      f.q(
        'update',
        '730',
        '--session',
        fire,
        '--state',
        'working',
        '--clear-reason',
        '--next',
        'step 9: take the lock',
      ),
      'put back to work',
    ),
    /^#730: working, holding a slot\n/,
  );
  assert.equal(f.state().tasks['730'].reason, null, 'the reason is cleared');
  assert.equal(slotsOf(f), 4, 'four of three slots: back at work it took its slot back');
  const token = tokenOf(ok(f.q('lock', '730', '--session', fire), 'the put-back task locks'));
  assert.ok(token, 'it is given a token');
  assert.equal(f.state().lock.key, '730');
  assert.equal(f.state().tasks['730'].state, 'delivering');
  assert.equal(slotsOf(f), 3, 'under the lock it holds no slot');

  // A task awaiting the lock, adopted by another session, keeps its place.
  refused(
    f.q('lock', '731', '--session', sessions.get(731)),
    /^refused: the lock is held by #730 since .*; #731 stays awaiting the lock\n$/,
    '731 waits past its bound',
  );
  const waitingSince = f.state().tasks['731'].waitingSince;
  assert.ok(waitingSince, '731 waits from now on');
  ok(
    f.q(
      'update',
      '731',
      '--session',
      sessions.get(731),
      '--next',
      'step 9: take the lock',
      '--detach',
    ),
    '731 detaches',
  );
  const next = f.session();
  ok(f.q('adopt', '731', '--session', next), 'another session adopts 731');
  const before = Date.now();
  refused(
    f.q('lock', '731', '--session', next),
    /; #731 stays awaiting the lock\n$/,
    'the adopter calls lock again',
  );
  const again = f.state().tasks['731'];
  assert.equal(again.state, 'awaiting-lock');
  assert.equal(again.waitingSince, waitingSince, 'its waitingSince is kept');
  assert.ok(new Date(again.waitingSince) < before, 'not a fresh one');
  refused(
    f.q('lock', '732', '--session', sessions.get(732)),
    /stays awaiting the lock/,
    '732 waits after it',
  );
  assert.ok(
    f.state().tasks['732'].waitingSince > waitingSince,
    '732 waits behind 731, which is still first in line',
  );
});

// A task put back to work and then refused `the queue is paused` is left
// awaiting the lock, detached, and is no resume work for the fire check until
// the owner's word unpauses the queue.
test('a put-back task refused on a paused queue waits for the lock, detached, and is resumed only once the queue runs again', (t) => {
  const f = fixture(t, { issues: [issue(740, { body: touches('docs') })] });
  const first = fireTask(f, 740);
  ok(
    f.q(
      'update',
      '740',
      '--session',
      first,
      '--state',
      'paused',
      '--reason',
      'Docker does not answer',
      '--detach',
    ),
    '740 pauses and detaches',
  );
  const fire = f.session();
  ok(f.q('adopt', '740', '--session', fire), 'adopt');
  ok(f.q('update', '740', '--session', fire, '--state', 'working', '--clear-reason'), 'put back');
  ok(f.q('pause', '--reason', 'recovery failed on main'), 'the queue pauses');
  refused(
    f.q('lock', '740', '--session', fire, '--wait', '1'),
    /^refused: the queue is paused: recovery failed on main; it takes the lock once the owner's word unpauses it\n$/,
    'the put-back task on a paused queue',
  );
  assert.equal(f.state().tasks['740'].state, 'awaiting-lock', 'it is left awaiting the lock');
  assert.equal(f.state().tasks['740'].polledAt, null, 'polling no more');
  assert.equal(slotsOf(f), 0, 'waiting, it holds no slot');
  ok(
    f.q('update', '740', '--session', fire, '--next', 'step 9: take the lock', '--detach'),
    'recorded and detached',
  );
  const statusJson = () => JSON.parse(ok(f.q('status', '--json'), 'status --json'));
  assert.equal(resumable(statusJson()), null, 'no resume work while the queue is paused');
  ok(f.q('unpause'), 'unpause');
  assert.equal(resumable(statusJson()), 'resume #740 (fire task, detached)');
  const next = f.session();
  ok(f.q('adopt', '740', '--session', next), 'the next fire adopts it');
  assert.ok(tokenOf(ok(f.q('lock', '740', '--session', next), 'lock')), 'and takes the lock');
});

// ---------------------------------------------------------------------------
// The order of the waiters, and the lookups
// ---------------------------------------------------------------------------

// Polls the state until `ready` holds for it, without a clock: at most `tries`
// reads, 50 ms apart.
async function until(f, ready, what, tries = 200) {
  for (let at = 0; at < tries; at += 1) {
    try {
      if (ready(f.state())) return;
    } catch {
      // Not written yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`never: ${what}`);
}

test('the longest live waiter gets the lock first, and a waiter that stopped polling holds nobody back', async (t) => {
  const f = fixture(t);
  const a = dayTask(f, 'day-a');
  const b = dayTask(f, 'day-b');
  const c = dayTask(f, 'day-c');
  const token = tokenOf(ok(f.q('lock', 'day-a', '--session', a), 'a holds the lock'));

  // b starts waiting first, c after it. b looks every 3 s and c every 300 ms,
  // so once the lock is free c looks first: only the order keeps it from
  // taking the lock ahead of b.
  const waitB = f.qAsync('lock', 'day-b', '--session', b, '--wait', '1');
  await until(f, (state) => state.tasks['day-b'].polledAt !== null, 'b polls');
  const waitC = f.qAsync('lock', 'day-c', '--session', c, '--wait', '0.1');
  await until(f, (state) => state.tasks['day-c'].polledAt !== null, 'c polls');
  assert.ok(f.state().tasks['day-b'].waitingSince < f.state().tasks['day-c'].waitingSince);
  ok(f.q('unlock', 'day-a', token, '--next', 'step 9: fix'), 'a releases');
  const [gotB, gotC] = await Promise.all([waitB, waitC]);
  assert.equal(gotB.status, 0, `b: ${gotB.stderr}`);
  assert.ok(tokenOf(gotB.stdout), 'b, which waited longest, holds the lock');
  assert.equal(gotC.status, 3, `c: ${gotC.stderr}`);
  assert.match(gotC.stderr, /the lock is held by day-b/);
  assert.equal(f.state().lock.key, 'day-b');

  // A waiter whose process is gone stops counting once it stops polling.
  ok(f.q('unlock', 'day-b', f.state().lock.token, '--next', 'x'), 'b releases');
  const state = f.state();
  state.tasks['day-b'].state = 'awaiting-lock';
  state.tasks['day-b'].waitingSince = new Date(Date.now() - 600_000).toISOString();
  state.tasks['day-b'].polledAt = new Date(Date.now() - 600_000).toISOString();
  state.tasks['day-b'].pollMs = 15_000;
  f.writeState(state);
  assert.ok(tokenOf(ok(f.q('lock', 'day-c', '--session', c), 'c, behind a waiter that left')));
});

const views = (f) =>
  f
    .ghCalls()
    .filter((args) => args[0] === 'issue' && args[1] === 'view')
    .map((args) => args[2]);

test('the pick asks GitHub once per dependency, however many issues name it', (t) => {
  const f = fixture(t, {
    issues: [
      issue(730, { body: `${touches('docs')}\nDepends on #148\n` }),
      issue(731, { body: `${touches('tooling')}\nDepends on #148\nDepends on #149\n` }),
      issue(732, { body: `${touches('e2e')}\nDepends on #149\nDepends on #148\n` }),
      issue(733, { body: `${touches('billing')}\nDepends on #149\n` }),
      issue(148, { ready: false }),
      issue(149, { state: 'CLOSED' }),
    ],
  });
  const out = ok(f.q('pick'), 'pick');
  assert.deepEqual(offered(out), [733]);
  assert.deepEqual(views(f).sort(), ['148', '149']);
});

// An issue may name any number of dependencies, and each is a GitHub call: at
// most twenty of one issue's are looked up, and any beyond count as open, so
// the issue is passed over, with the reason, whatever the twenty say.
test('the pick and start look up at most twenty dependencies of one issue, and count the rest as open', (t) => {
  const named = Array.from({ length: 30 }, (_, k) => 900 + k);
  const f = fixture(t, {
    issues: [
      issue(740, {
        body: `${touches('docs')}\n${named.map((n) => `Depends on #${n}`).join('\n')}\n`,
      }),
      ...named.map((n) => issue(n, { state: 'CLOSED' })),
    ],
  });
  const reason =
    '#740  names 10 more dependencies past the first 20, not looked up and counted as open';

  const picked = f.q('pick');
  refused(picked, /nothing to take/, 'pick');
  assert.ok(picked.stdout.includes(reason), picked.stdout);
  assert.deepEqual(
    views(f),
    named.slice(0, 20).map(String),
    'exactly the first twenty, once each',
  );

  const before = views(f).length;
  refused(
    f.q(
      'start',
      '740',
      '--session',
      f.session(),
      '--branch',
      'fix/t740',
      '--worktree',
      '/tmp/t740',
    ),
    /^refused: #740 names 10 more dependencies past the first 20, not looked up and counted as open\n$/,
    'start',
  );
  // The issue itself, then twenty of its dependencies.
  assert.equal(views(f).length - before, 21);

  // Twenty named are all looked up, and decide alone.
  f.setIssues([
    issue(741, {
      body: `${touches('docs')}\n${named
        .slice(0, 20)
        .map((n) => `Depends on #${n}`)
        .join('\n')}\n`,
    }),
    ...named.map((n) => issue(n, { state: 'CLOSED' })),
  ]);
  assert.deepEqual(offered(ok(f.q('pick'), 'pick of twenty')), [741]);
});

// ---------------------------------------------------------------------------
// The mutex under kills and stampedes
// ---------------------------------------------------------------------------

// A PID no process holds: one of a process that has ended and been reaped.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const mutexOf = (f) => join(f.directory, 'state.lock');
const leftovers = (f) =>
  readdirSync(f.directory).filter((name) => /\.tmp$|^state\.lock\.claim-/.test(name));

// Every process that reported success left its reservation and its update in
// the state, and no id was given twice: what a second writer let in would
// break. A process that gave up on the mutex left nothing of its own: no
// update, and no reservation beyond those reported, which `reserved` counts
// per task over the rounds.
function assertConsistent(f, results, label, reserved, gaveUp) {
  const state = f.state();
  const given = [];
  for (const { key, kind, value, result } of results) {
    if (result.status !== 0) continue;
    if (kind === 'reserve') {
      const id = Number(/D(\d+)/.exec(result.stdout)[1]);
      given.push(id);
      reserved.set(key, reserved.get(key) + 1);
      assert.ok(state.tasks[key].decisions.includes(id), `${label}: ${key}'s D${id} was lost`);
    } else {
      assert.equal(state.tasks[key].next, value, `${label}: ${key}'s update was lost`);
    }
  }
  for (const { key, kind, value } of gaveUp) {
    if (kind === 'update') {
      assert.notEqual(
        state.tasks[key].next,
        value,
        `${label}: ${key}'s update was written by a process that gave up on the mutex`,
      );
    }
  }
  for (const [key, count] of reserved) {
    assert.equal(
      state.tasks[key].decisions.length,
      count,
      `${label}: ${key} holds ${state.tasks[key].decisions.length} reservations, ${count} reported`,
    );
  }
  assert.equal(new Set(given).size, given.length, `${label}: an id given twice: ${given}`);
  const recorded = Object.values(state.tasks).flatMap((task) => task.decisions);
  assert.equal(new Set(recorded).size, recorded.length, `${label}: an id recorded twice`);
  assert.ok(
    recorded.every((id) => id < state.nextDecision),
    `${label}: the counter fell behind`,
  );
}

test('of processes waiting on a mutex that goes stale at once, and holders killed midway, none lets a second writer in', async (t) => {
  const f = fixture(t);
  const keys = ['day-a', 'day-b', 'day-c', 'day-d', 'day-e', 'day-f', 'day-g', 'day-h'];
  const sessions = new Map(keys.map((key) => [key, dayTask(f, key)]));
  const nonce = () => randomUUID().replaceAll('-', '');
  // A mutex put in place whole, as a holder's would be.
  const swap = (text, aged = false) => {
    const next = join(f.directory, 'next-mutex');
    writeFileSync(next, text);
    if (aged) f.age(next, 2);
    renameSync(next, mutexOf(f));
  };
  // How the held mutex goes stale, in one stroke, while every process waits.
  const shapes = [
    ["its holder's time runs past the bound", () => f.age(mutexOf(f), 2)],
    ['its holder is gone', () => swap(`${deadPid()} ${nonce()}\n`)],
    [
      'its holder is gone, and so is the first process to claim it',
      () => {
        const id = nonce();
        writeFileSync(join(f.directory, `state.lock.claim-${id}-1`), `${deadPid()} ${nonce()}\n`);
        swap(`${deadPid()} ${id}\n`);
      },
    ],
    ['an empty mutex past the bound', () => swap('', true)],
  ];
  // A process gives up on the mutex 5 s after it began to wait for it
  // (MUTEX_WAIT_MS in delivery-queue.mjs), with exit 1, this fault and
  // nothing written. The test holds the mutex until every process waits, or
  // HOLD_MS after the first began to, so that each process waiting when it
  // goes stale has most of its wait left for its turn. One that runs out all
  // the same, on a loaded machine, is not a second writer: it is held to that
  // fault, alone on its stderr, and to writing nothing. A round counts only
  // when at least two of the processes waiting at the stale moment wrote;
  // with fewer there was no second writer to keep out, and the test fails as
  // too loaded to check.
  //
  // A process killed between making its claim and writing its PID in it
  // leaves the claim empty, and the queue waits on an empty claim as on one
  // being made until it is as old as a stale mutex, 30 s: every process then
  // gives up on the mutex that claim names, as it should. Once a round is
  // over, such a claim is aged past the bound, as 30 s would age it, so that
  // the next holder sweeps it; a round it kept from writing at all is made
  // again, up to three attempts in all.
  const HOLD_MS = 2000;
  const ATTEMPTS = 3;
  const inUse =
    /^fault: the queue state is in use by another process \((.+?)(?:, PID [1-9]\d*)?\) \[D16\]\n$/;
  const reserved = new Map(keys.map((key) => [key, 0]));
  const aged = new Set();
  for (let round = 0, attempt = 1; round < 8;) {
    const [what, goStale] = shapes[round % shapes.length];
    // A live holder, this test's own process: every process waits on it.
    swap(`${process.pid} ${nonce()}\n`);
    // What a writer killed mid-write leaves.
    writeFileSync(join(f.directory, `state.json.${deadPid()}.0badc0de.tmp`), '{"half":');
    const runs = keys.flatMap((key, at) => {
      const value = `round ${round}, attempt ${attempt}, ${key}`;
      return [
        { key, kind: 'reserve', run: f.qAsync('reserve', key, '--session', sessions.get(key)) },
        {
          key,
          kind: 'update',
          value,
          run: f.qAsync('update', key, '--session', sessions.get(key), '--next', value),
          // Every third update is killed a moment after the mutex goes stale,
          // while it takes the mutex over, holds it or writes.
          kill: at % 3 === round % 3 ? (round * 3 + at * 5) % 20 : null,
        },
      ];
    });
    // The processes waiting on the mutex, each by its own file beside it,
    // which it makes as it begins to wait.
    const pids = new Set(runs.map(({ run }) => run.pid));
    const waiters = () =>
      readdirSync(f.directory).filter((name) =>
        pids.has(Number(/^state\.lock\.(\d+)\.[0-9a-f]{32}\.tmp$/.exec(name)?.[1])),
      );
    // Until each waits, or HOLD_MS after the first began to by its file's
    // time; 20 s at most, should none ever wait.
    const spawned = Date.now();
    let first = Infinity;
    for (;;) {
      const names = waiters();
      for (const name of names) {
        try {
          first = Math.min(first, statSync(join(f.directory, name)).mtimeMs);
        } catch {
          // It has just given up.
        }
      }
      const now = Date.now();
      if (names.length === runs.length || now - first >= HOLD_MS || now - spawned >= 20_000) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const waiting = new Set(waiters().map((name) => Number(name.split('.')[2])));
    goStale();
    for (const item of runs) {
      if (item.kill !== null && item.kill !== undefined) {
        setTimeout(() => item.run.kill('SIGKILL'), item.kill);
      }
    }
    const results = [];
    for (const item of runs) results.push({ ...item, result: await item.run });
    const label = `round ${round}, ${what}`;
    const gaveUp = [];
    for (const item of results) {
      const { kind, result } = item;
      if (result.signal === 'SIGKILL') continue;
      if (
        result.status === 1 &&
        result.stdout === '' &&
        inUse.exec(result.stderr)?.[1] === mutexOf(f)
      ) {
        gaveUp.push(item);
        continue;
      }
      assert.equal(result.status, 0, `${label}: ${kind} ${result.stderr}`);
    }
    assertConsistent(f, results, label, reserved, gaveUp);
    const halfMade = readdirSync(f.directory).filter(
      (name) =>
        !aged.has(name) &&
        /^state\.lock\.claim-/.test(name) &&
        statSync(join(f.directory, name)).size === 0,
    );
    for (const name of halfMade) {
      f.age(join(f.directory, name), 2);
      aged.add(name);
    }
    const wrote = results.filter(
      ({ run, result }) => result.status === 0 && waiting.has(run.pid),
    ).length;
    if (wrote < 2 && halfMade.length > 0 && attempt < ATTEMPTS) {
      attempt += 1;
      continue;
    }
    assert.ok(
      wrote >= 2,
      halfMade.length > 0
        ? `${label}: in each of ${attempt} attempts a process killed between making its claim and writing it left the claim empty, which holds every other process off the stale mutex for 30 s, and ${wrote} of the ${waiting.size} processes waiting when it went stale wrote: the round checked nothing`
        : `the machine was too loaded to check: ${label}: ${wrote} of the ${waiting.size} processes waiting when the mutex went stale wrote, fewer than the two a second writer needs, and ${gaveUp.length} of the ${runs.length} gave up on their 5 s wait; or delivery-queue.mjs no longer lets a waiting process take a stale mutex over`,
    );
    round += 1;
    attempt = 1;
  }
  // The next holder sweeps what the killed ones left, and the mutex is free.
  ok(f.q('update', 'day-a', '--session', sessions.get('day-a'), '--next', 'last'), 'one more');
  assert.deepEqual(leftovers(f), []);
  assert.equal(existsSync(mutexOf(f)), false, 'the mutex is let go');
});

// The race the first version lost: two processes find the same stale mutex,
// the first takes it over and holds a new one, and the second, a moment
// behind, removes what it takes for the stale one. Played here step by step,
// so that it happens every time rather than one run in many.
test('a takeover of a mutex found stale removes it only while it is still that one, never the mutex another process took meanwhile', (t) => {
  const f = fixture(t);
  dayTask(f, 'day-a');
  const mutex = mutexOf(f);
  const own = `${process.pid} ${'c'.repeat(32)}\n`;
  const claim = (id, level) => join(f.directory, `state.lock.claim-${id}-${level}`);

  // A holder died; this process finds its mutex stale…
  writeFileSync(mutex, `${deadPid()} ${'a'.repeat(32)}\n`);
  const found = readMutex(mutex);
  assert.equal(found.nonce, 'a'.repeat(32));
  // …and before it acts, another process takes it over and holds it.
  rmSync(mutex);
  writeFileSync(mutex, `${process.pid} ${'b'.repeat(32)}\n`);
  assert.equal(takeOver(f.directory, mutex, found, own), true, 'it tries the mutex again');
  assert.equal(
    readFileSync(mutex, 'utf8'),
    `${process.pid} ${'b'.repeat(32)}\n`,
    "the live holder's mutex stays",
  );
  assert.deepEqual(leftovers(f), [], 'its claim is let go');

  // The mutex it found, still there: removed.
  writeFileSync(mutex, `${deadPid()} ${'d'.repeat(32)}\n`);
  assert.equal(takeOver(f.directory, mutex, readMutex(mutex), own), true);
  assert.equal(existsSync(mutex), false);

  // Another live process holds the claim: this one leaves the mutex to it.
  writeFileSync(mutex, `${deadPid()} ${'e'.repeat(32)}\n`);
  const contested = readMutex(mutex);
  writeFileSync(claim('e'.repeat(32), 1), `${process.pid} ${'f'.repeat(32)}\n`);
  assert.equal(takeOver(f.directory, mutex, contested, own), false);
  assert.ok(existsSync(mutex), 'left to the process taking it over');
  // The claim's maker died holding it: the next level takes the mutex away.
  writeFileSync(claim('e'.repeat(32), 1), `${deadPid()} ${'f'.repeat(32)}\n`);
  assert.equal(takeOver(f.directory, mutex, contested, own), true);
  assert.equal(existsSync(mutex), false);
  assert.equal(existsSync(claim('e'.repeat(32), 2)), false, 'the second claim is let go');
  // An empty mutex is known by its file, not its words.
  writeFileSync(mutex, '');
  const empty = readMutex(mutex);
  assert.equal(empty.nonce, null);
  rmSync(mutex);
  writeFileSync(mutex, `${process.pid} ${'9'.repeat(32)}\n`);
  assert.equal(takeOver(f.directory, mutex, empty, own), true);
  assert.ok(existsSync(mutex), 'a later mutex in its place stays');
});

test("a holder's mutex is never taken from a live process inside the bound; a dead process's is taken at once", (t) => {
  const f = fixture(t);
  const s = dayTask(f, 'day-a');
  // This test's own process is alive: its mutex is waited for, then a fault
  // names it, and nothing was written.
  const before = readFileSync(f.stateFile, 'utf8');
  writeFileSync(mutexOf(f), `${process.pid} ${'a'.repeat(32)}\n`);
  const held = f.q('update', 'day-a', '--session', s, '--next', 'x');
  assert.equal(held.status, 1, held.stderr);
  assert.match(
    held.stderr,
    new RegExp(`in use by another process \\(.*state\\.lock, PID ${process.pid}\\)`),
  );
  assert.equal(readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(
    readFileSync(mutexOf(f), 'utf8'),
    `${process.pid} ${'a'.repeat(32)}\n`,
    'left as found',
  );
  // The same mutex from a process that is gone is taken at once.
  writeFileSync(mutexOf(f), `${deadPid()} ${'b'.repeat(32)}\n`);
  ok(f.q('update', 'day-a', '--session', s, '--next', 'after a dead holder'), 'taken over');
  assert.match(ok(f.q('show', 'day-a'), 'show'), /next: after a dead holder/);
  // A mutex that is not a file is a fault for a person to look at.
  rmSync(mutexOf(f), { force: true });
  mkdirSync(mutexOf(f));
  const odd = f.q('update', 'day-a', '--session', s, '--next', 'x');
  assert.equal(odd.status, 1);
  assert.match(odd.stderr, /state\.lock (?:is not a regular file|cannot be made)/);
});

// A holder stopped past the bound loses its mutex to another process, and then
// must write nothing: it checks, before writing, that the mutex is still its
// own. The holder is held inside its turn by a FIFO named like a claim, which
// its sweep opens and which blocks until this test opens the other end; while
// it waits, the mutex is taken from it, as a process that found it stale would
// take it. Then the FIFO is opened, the holder goes on to write, and finds the
// mutex is not its own.
test('a holder whose mutex was taken over while it held it writes nothing and says so', async (t) => {
  const f = fixture(t);
  const s = dayTask(f, 'day-a');
  const before = readFileSync(f.stateFile, 'utf8');
  const fifo = join(f.directory, 'state.lock.claim-held-1');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0, `mkfifo: ${made.stderr}`);
  t.after(() => rmSync(fifo, { force: true }));

  const holder = f.qAsync('update', 'day-a', '--session', s, '--next', 'written past the bound');
  const wait = async (what, ready) => {
    for (let tries = 0; tries < 500; tries += 1) {
      const value = ready();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    holder.kill('SIGKILL');
    assert.fail(`${what} did not happen within 10 s`);
  };
  // The holder has the mutex once it names the holder's process.
  await wait('the holder taking the mutex', () => {
    try {
      return readMutex(mutexOf(f))?.pid === holder.pid;
    } catch {
      return false;
    }
  });
  // Another process takes it, as one that found it stale would.
  const other = `${process.pid} ${'7'.repeat(32)}\n`;
  const swap = join(f.directory, 'swap.tmp');
  writeFileSync(swap, other);
  renameSync(swap, mutexOf(f));
  // The other end of the FIFO, opened once the holder waits at it.
  const writer = await wait('the holder reaching its sweep', () => {
    try {
      return openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENXIO') return null;
      throw error;
    }
  });
  closeSync(writer);

  const result = await holder;
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(
    result.stderr,
    /^fault: this process held the queue's mutex past 30 s and another took it over; nothing was written \[D16\]\n$/,
  );
  assert.equal(readFileSync(f.stateFile, 'utf8'), before, 'nothing was written');
  assert.equal(readFileSync(mutexOf(f), 'utf8'), other, "the other process's mutex stays");
  rmSync(mutexOf(f));
  assert.doesNotMatch(ok(f.q('show', 'day-a'), 'show'), /written past the bound/);
});
