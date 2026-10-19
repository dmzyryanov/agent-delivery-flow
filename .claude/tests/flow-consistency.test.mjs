// The flow's texts and scripts agree with each other: every file they name
// exists, every queue command they run is one the queue has, every label they
// use is one /flow-init creates, every decision they cite is recorded, and the
// few phrases a script reads back from what a procedure writes are still
// written that way. It reads the repository; it never pins a procedure's
// wording beyond those phrases.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const ROOT = new URL('../..', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '.git' || name === 'node_modules') continue;
    const path = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

// The flow's own texts: everything under .claude/ and .github/, and the
// process documents. A project's own docs are not read.
const FLOW_TEXTS = walk('', (path) => path.endsWith('.md'))
  .filter((path) =>
    /^(\.claude|\.github)\//.test(path) ||
    ['CLAUDE.md', 'docs/DELIVERY.md', 'docs/DECISIONS.md', 'docs/RESOURCES.md'].includes(path) ||
    path.startsWith('docs/tooling/'),
  );

test('the six roles are defined, each named after its file', () => {
  for (const role of ['developer', 'tester', 'tester-process', 'tester-look', 'reviewer', 'architect']) {
    const text = read(`.claude/agents/${role}.md`);
    const name = /^---\n[\s\S]*?^name: *(\S+)/m.exec(text)?.[1];
    assert.equal(name, role, `.claude/agents/${role}.md`);
  }
});

test('every flow file a text names exists', () => {
  const missing = [];
  const pattern =
    /(?<![\w/.-])(\.claude\/(?:scripts|skills|scheduled|agents|tests)\/[\w./-]+|docs\/[\w./-]+\.md|\.github\/(?:workflows|ISSUE_TEMPLATE)\/[\w./-]+)/g;
  for (const path of FLOW_TEXTS) {
    for (const [, named] of read(path).matchAll(pattern)) {
      const clean = named.replace(/[.,;:]+$/, '');
      if (clean.endsWith('/')) continue;
      if (!existsSync(join(ROOT, clean))) missing.push(`${path} names ${clean}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every queue command a text runs is one the queue has, and --mr is gone', () => {
  const queue = read('.claude/scripts/delivery-queue.mjs');
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(queue)?.[1];
  assert.ok(usage, 'the queue keeps its usage text');
  const commands = new Set(
    [...usage.matchAll(/(?:^|\n|\| )\s*([a-z]+)(?=\s|$)/g)].map((match) => match[1]),
  );
  const unknown = [];
  for (const path of FLOW_TEXTS) {
    const text = read(path);
    for (const [, command] of text.matchAll(/delivery-queue\.mjs ([a-z-]+)/g)) {
      if (!commands.has(command)) unknown.push(`${path}: ${command}`);
    }
    assert.doesNotMatch(text, /delivery-queue\.mjs [^\n`]*--mr\b/, path);
  }
  assert.deepEqual(unknown, []);
});

test('every label a text or script uses is one /flow-init creates', () => {
  const init = read('.claude/skills/flow-init/SKILL.md');
  const created = new Set([...init.matchAll(/^ *\| `([a-z]+:[a-z0-9-]+)` \|/gm)].map((m) => m[1]));
  assert.ok(created.has('state:ready') && created.has('type:epic'), 'the label table is found');
  const files = [
    ...FLOW_TEXTS,
    ...walk('.claude/scripts', (path) => path.endsWith('.mjs') || path.endsWith('.sh')),
  ];
  const unknown = new Set();
  for (const path of files) {
    for (const [label] of read(path).matchAll(/\b(?:state|type|prio|delivery|area):[a-z0-9]+(?:-[a-z0-9]+)*\b/g)) {
      if (!created.has(label)) unknown.add(`${relative(ROOT, join(ROOT, path))}: ${label}`);
    }
  }
  assert.deepEqual([...unknown], []);
});

test('no scoped GitLab label or glab command is left in the flow', () => {
  const left = [];
  for (const path of FLOW_TEXTS.filter((p) => p !== 'docs/DECISIONS.md')) {
    const text = read(path);
    if (/\b(?:state|type|prio|delivery|area)::/.test(text)) left.push(`${path}: scoped label`);
    if (/\bglab\b/.test(text)) left.push(`${path}: glab`);
  }
  assert.deepEqual(left, []);
});

test('every decision a text cites is recorded in docs/DECISIONS.md', () => {
  const decisions = read('docs/DECISIONS.md');
  const recorded = new Set([...decisions.matchAll(/^## (D\d+) — /gm)].map((m) => m[1]));
  assert.ok(recorded.size > 0);
  const cited = new Set();
  for (const path of FLOW_TEXTS) {
    for (const [id] of read(path).matchAll(/\bD\d+\b/g)) {
      if (!recorded.has(id)) cited.add(`${path}: ${id}`);
    }
  }
  assert.deepEqual([...cited], []);
});

test('the settings run the guard before every Bash call and never allow a merge', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  const hooks = settings.hooks?.PreToolUse ?? [];
  assert.ok(
    hooks.some(
      (entry) =>
        entry.matcher === 'Bash' &&
        entry.hooks?.some((hook) => /\.claude\/scripts\/guard-bash\.mjs/.test(hook.command)),
    ),
    'the Bash guard hook',
  );
  const allow = settings.permissions?.allow ?? [];
  assert.equal(allow.filter((rule) => /gh pr merge|pulls\/.*\/merge/.test(rule)).length, 0);
  assert.equal(settings.permissions?.defaultMode, undefined, 'the project sets no starting mode');
});

test('CLAUDE.md lists every placeholder it uses, or uses none once filled', () => {
  const text = read('CLAUDE.md');
  const used = new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]));
  const comment = /^<!--([\s\S]*?)-->/.exec(text.trimStart())?.[1] ?? '';
  const listed = new Set([...comment.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]));
  if (listed.size === 0) {
    assert.deepEqual([...used], [], 'a filled CLAUDE.md keeps no placeholder');
    return;
  }
  for (const name of used) assert.ok(listed.has(name), `{{${name}}} is listed at the top`);
});

test('the phrases fire-check and the queue read back are still the ones the procedures write', () => {
  const cycle = read('.claude/scheduled/delivery-cycle.md');
  const grooming = read('.claude/scheduled/grooming.md');
  const fireCheck = read('.claude/scripts/fire-check.mjs');
  assert.match(cycle, /Scheduled run <[^>]+>: taken/);
  assert.match(grooming, /Grooming run <[^>]+>: taken/);
  assert.match(fireCheck, /Scheduled run/);
  assert.match(fireCheck, /Grooming run/);
  for (const [name, text] of [['cycle', cycle], ['grooming', grooming]]) {
    assert.match(text, /date '\+%Y-%m-%d %H:%M:%S %z'/, `${name} writes fire times with a numeric offset`);
    assert.doesNotMatch(text, /date '[^']*%Z/, `${name} never writes a zone abbreviation`);
  }
  assert.match(cycle, /## Owner steps before delivery/);
  assert.match(fireCheck, /Owner steps before delivery/);
  assert.match(cycle, /type:epic/);
  assert.match(grooming, /type:epic/);
});

test('the scheduled tasks /flow-init creates run the no-token check first', () => {
  const init = read('.claude/skills/flow-init/SKILL.md');
  assert.match(init, /node \.claude\/scripts\/fire-check\.mjs cycle/);
  assert.match(init, /\.claude\/scheduled\/delivery-cycle\.md/);
  const fires = read('docs/tooling/scheduled-fires.md');
  assert.match(fires, /fire-check\.mjs/);
});

test('the main workflow and its smoke job are the ones the flow follows', () => {
  const flow = JSON.parse(read('.claude/flow.json'));
  const main = read(`.github/workflows/${flow.delivery.mainWorkflow}`);
  assert.match(main, new RegExp(`^  ${flow.delivery.smokeJob}:$`, 'm'));
  assert.match(main, /^ {2}deploy:$/m);
  assert.match(main, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^ {2}flow:$/m);
  assert.match(ci, /^ {2}project:$/m);
  assert.match(ci, /node --test \.claude\/tests\/\*\.test\.mjs/);
});

test("every command of the project's configuration has its allow rules", () => {
  const flow = JSON.parse(read('.claude/flow.json'));
  const allow = JSON.parse(read('.claude/settings.json')).permissions?.allow ?? [];
  const commands = [
    ...Object.entries(flow.commands ?? {}).filter(([key]) => key !== 'about'),
    ['delivery.rollback', flow.delivery?.rollback ?? ''],
  ];
  const missing = [];
  for (const [name, value] of commands) {
    if (typeof value !== 'string' || value === '') continue;
    const command = value.replaceAll('{task}', '*');
    for (const rule of [`Bash(${command})`, `Bash(${command} *)`]) {
      if (!allow.includes(rule)) missing.push(`${name}: ${rule}`);
    }
  }
  assert.deepEqual(missing, [], 'a PR that sets a command adds its rules to .claude/settings.json');
});

test('docs/RESOURCES.md keeps its template comment or no placeholder at all', () => {
  const text = read('docs/RESOURCES.md');
  const comment = /^<!--[\s\S]*?placeholders?[\s\S]*?-->/i.test(text.trimStart());
  if (!comment) assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, 'a filled RESOURCES.md keeps no placeholder');
});
