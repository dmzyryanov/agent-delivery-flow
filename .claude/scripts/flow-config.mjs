// The project's flow configuration, `.claude/flow.json` (D23), read the same
// way by every script of the flow.
//
//   import { loadFlow } from './flow-config.mjs';
//   const flow = loadFlow(root);   // root: the repository's top directory
//
// `FLOW_CONFIG`, when set, names the file to read instead, for tests. Missing
// keys get their defaults; a file that is missing, is not JSON, or names no
// `project.repo` of the form `owner/name` is a FlowConfigError with one line
// saying which. Run as a script it prints one value, for shells and workflows:
//
//   node .claude/scripts/flow-config.mjs <dotted.key>
//
// exit 0 with the value on stdout (an object as JSON), 1 a FlowConfigError,
// 2 wrong usage or no such key.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class FlowConfigError extends Error {}

const DEFAULTS = {
  project: { name: '', repo: '', mainBranch: 'main', site: '', ownerLanguage: 'Russian' },
  commands: {
    install: '',
    check: '',
    test: '',
    taskTest: '',
    taskDown: '',
    e2e: '',
    build: '',
  },
  delivery: {
    versioning: true,
    deploy: false,
    mainWorkflow: 'main.yml',
    smokeJob: 'smoke',
    rollback: '',
  },
  outsideReview: { enabled: false, areas: [] },
  design: { figma: false },
  schedule: { cycle: '*/30 * * * *', grooming: '7,22,37,52 * * * *', morningFire: '09:07' },
};

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function flowPath(root = ROOT) {
  return process.env.FLOW_CONFIG || join(root, '.claude', 'flow.json');
}

export function loadFlow(root = ROOT, { requireRepo = true } = {}) {
  const path = flowPath(root);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new FlowConfigError(`${path} cannot be read (${error.code ?? error.message}): run /flow-init`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FlowConfigError(`${path} is not JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FlowConfigError(`${path} is not a JSON object`);
  }
  const flow = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    const given = parsed[section];
    flow[section] = { ...defaults };
    if (given === undefined) continue;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) {
      throw new FlowConfigError(`${path}: ${section} is not an object`);
    }
    for (const [key, value] of Object.entries(given)) {
      if (key === 'about') continue;
      if (key in defaults) {
        const list = Array.isArray(defaults[key]);
        if (list ? !Array.isArray(value) : typeof value !== typeof defaults[key]) {
          const kind = list ? 'list' : `${typeof defaults[key]}`;
          throw new FlowConfigError(`${path}: ${section}.${key} is not a ${kind}`);
        }
      }
      flow[section][key] = value;
    }
  }
  if (requireRepo && !REPO.test(flow.project.repo)) {
    throw new FlowConfigError(
      `${path}: project.repo is ${JSON.stringify(flow.project.repo)}, not owner/name: run /flow-init`,
    );
  }
  if (!flow.project.mainBranch) flow.project.mainBranch = 'main';
  return flow;
}

// A command with `{task}` filled in, or '' when the project has none.
export function taskCommand(flow, name, task) {
  const command = flow.commands[name] || (name === 'taskTest' ? flow.commands.test : '');
  return command.replaceAll('{task}', task);
}

function main(argv) {
  if (argv.length !== 1 || !/^[A-Za-z]+(?:\.[A-Za-z]+)*$/.test(argv[0])) {
    process.stderr.write('usage: node .claude/scripts/flow-config.mjs <dotted.key>\n');
    return 2;
  }
  let flow;
  try {
    flow = loadFlow(ROOT, { requireRepo: false });
  } catch (error) {
    if (!(error instanceof FlowConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  let value = flow;
  for (const part of argv[0].split('.')) {
    if (value === null || typeof value !== 'object' || !(part in value)) {
      process.stderr.write(`no such key: ${argv[0]}\n`);
      return 2;
    }
    value = value[part];
  }
  process.stdout.write(`${typeof value === 'object' ? JSON.stringify(value) : String(value)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
