# Claude Code MCP access

## Configuration and roles

This file is the single statement of the MCP contract for the project. The
agent definitions point at it instead of repeating it; read it when a task needs
an external tool.

**A tool being listed is not access.** Tool visibility, permission to invoke the
tool, the server connection, OAuth authentication and permission on the Figma
file itself are five separate requirements, and a listed tool proves only the
first. When a call fails, report the layer that actually failed and its exact
error; never present a cached description, a link or an assumption as a design
you inspected. A role does not edit the Figma canvas; when `design.figma` in
`.claude/flow.json` is true, the main session draws a design there before
implementation, for the owner to approve (`docs/DELIVERY.md` step 3). Its
Figma writes are not allow-listed and go through the normal permission prompt,
so the read-only allowlists below stay true. The scheduled grooming's session
draws desktop directions the same way, unattended, where Auto mode decides
each write; a missing or refused tool sends the issue to the owner (D14).
Without Figma, the design reference is a saved image or a description in the
issue. Role and command restrictions apply unchanged when a task uses MCP.

The Figma tools come from the official Figma HTTP server,
`https://mcp.figma.com/mcp`, under the alias `figma`: registered in the
project's `.mcp.json` (`"figma": {"type": "http", "url":
"https://mcp.figma.com/mcp"}` under `mcpServers`) or at user scope. The names
below hold only for that alias. Every agent definition keeps its built-in tool
allowlist and adds ToolSearch — these tools are deferred, so they are
discovered through it — plus these exact read tools:

- `mcp__figma__get_design_context`
- `mcp__figma__get_metadata`
- `mcp__figma__get_screenshot`
- `mcp__figma__get_variable_defs`
- `mcp__figma__get_code_connect_map`
- `mcp__figma__whoami`

`.claude/settings.json` permits those same reads. A definition that names a
tool the session lacks loses only that tool, so a project without Figma keeps
the lines. These files do not provision an account or override managed
settings, explicit deny rules or Figma permissions. OAuth credentials stay in
Claude Code's local credential storage, never in Git.

The main session gathers design context; `architect` inspects it when answering
a question; `developer` implements it; `reviewer` and `tester` read it when
their criteria require it. This does not introduce visual regression tests or
change who may edit repository files. The allowlists contain no Figma write tool
and no server-wide wildcard. They constrain this team's direct tool access, not
the OAuth account's rights or every possible external access path.

`tester` and `tester-process`, which carries `tester`'s tools (D21),
additionally hold the client-provided interactive browser tools
(`mcp__Claude_Browser__navigate`, `get_page_text`, `read_page`, `computer`,
`resize_window`, `tabs_context`) for the two judgements a spec cannot make:
comparing a rendered page with the approved design, and checking changed
behaviour on the deployed service. They come from the Claude desktop client,
not from this repository's configuration. `reviewer` and `tester-look` get no
browser.

**Whether a sub-agent actually receives them is not reliable** (D4). A
`tester` has been seen holding none of the six — `ToolSearch` with `select:`
on all six answered "No matching deferred tools found", absent rather than
deferred — while the main session of the same conversation drove them; and a
`tester` has been seen holding all six, with a real call answered, while the
copy of `tester.md` on the branch it verified listed none of them. So either
the definition in force was not the worktree's, or client-provided tools
arrive independently of the `tools:` line; the cause is not established. A
resumed agent re-reporting its tools is not a second observation — a
session's tool set is likely fixed when it starts — and a genuine one needs a
**fresh invocation**, after the main checkout carries the definition being
tested. The obvious way to confirm the question, asking the role that just
answered it, yields nothing.

What follows is operational. A role that needs a client-provided tool confirms
it with `ToolSearch` **from inside that role**, at the point it needs it, and
reports honestly when it is missing: the criterion is NOT VERIFIED and the page
was not seen. Neither "the main session can call it" nor "a sub-agent never
gets it" is a substitute for that check. Anything that must stay true later is
a test in the same pull request rather than a browser session performed once.

The main session's `/groom` skill calls one more client-provided tool,
`mcp__ccd_session_mgmt__set_session_title`, to name its chat after the issues it
grooms, and `/flow-init` calls `create_scheduled_task` to create the scheduled
tasks (`docs/tooling/scheduled-fires.md`). No agent needs them, so no allowlist
or permission rule names them; outside the desktop app the skills go on
without them.

## Activate on the development machine

1. Bring these configuration changes into the checkout used for the run,
   preserving unrelated work. A remote pull request alone does not update a
   running local Claude session.
2. From that checkout, run `claude --version` and `claude mcp list`.
   Open a new Claude Code session and approve the project's Figma MCP server
   if Claude requests project trust.
3. In Claude Code, open `/mcp`, select `figma` and authenticate with Figma.
   The account must be able to view the project's Figma file, which
   `docs/RESOURCES.md` names. The owner completes the browser OAuth flow;
   agents must not request a pasted access token.
4. Restart the session after changing agent definitions or MCP configuration.
   If using an IDE extension, restart its Claude session in the same checkout.
5. Run the verification below in that local session before declaring access
   restored. A different server alias, such as a plugin-provided name, has a
   different tool namespace; do not assume it matches `mcp__figma__...`.
   Diagnose duplicate or shadowed server definitions before changing them.

## Verify real access

Use the project's Figma file and one frame of it, both named in
`docs/RESOURCES.md`:

- In the main session, discover the allowed Figma tools with ToolSearch
  when they are deferred. Retrieve frame metadata and a screenshot.
- Start each of architect, developer, tester and reviewer in the foreground
  for a short, read-only access check: retrieve metadata for that same frame
  and return its actual node name and tool result. No code edits or review
  cycle is needed for this connection check.
- After foreground access works, verify any background execution mode actually
  used by the team. Behavior depends on the installed Claude Code version;
  do not infer background access from a successful parent call.
- Record per role: tool discovered, call attempted, result or exact error.
  A cached description or a link to the file is not a successful MCP read.

Do not run application tests, deployments or write to Figma for this check.

## Diagnose a failure at its source

| Observation | Next check |
| --- | --- |
| Server absent | Correct checkout, project trust, local/user scope or managed server policy |
| Server present, tool absent | Agent `tools`, tool namespace, ToolSearch and runtime version |
| Permission denied | Applicable allow/ask/deny rules and managed policy; do not bypass them |
| Authentication needed | Owner signs in through `/mcp` |
| File not accessible | Signed-in account and Figma file permissions |
| Parent works, child fails | Fresh child definition, allowlist and foreground/background mode |

## Other MCP servers

Their local registrations and credentials are not visible in this repository.
Inventory them in the actual Claude session before extending agent access.
Report only server aliases, connection states and required tool names; do not
dump settings, environment values, headers or tokens.

A server whose connection carries a credential — a read-only database server,
for one — is registered at **user** or **local** scope on the operator's
machine and never in `.mcp.json`, which is committed; a session on another
machine then does not have it. Its read-only nature is best decided by what it
connects as (a role that can only read), not by the server's own mode or an
allow rule; the owner registers it and adds its allow rule.

For each required service, retain the built-in role restrictions and add the
actual tools needed by that role to its allowlist. Add permission rules only
for the authorized operations. A GitHub reader, a browser tester and a database
operator need different capabilities; an unrelated server is not implicitly
required by a release. Do not remove all `tools` filters, use a blanket
`mcp__*` grant, enable bypassPermissions or change managed policy to fix
discovery. If an administrator blocks a server, report the policy and request
the appropriate administrative change.

## References

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Figma remote MCP setup](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Figma tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [`gh pr merge`](https://cli.github.com/manual/gh_pr_merge)

## Permissions for autonomous delivery

**The starting mode.** `.claude/settings.json` sets no
`permissions.defaultMode`, and must not: a project value can only be a
prompting mode, and it would outrank the user-level file (D5). Auto comes
from the user-level `~/.claude/settings.json`, where the owner sets
`"permissions": {"defaultMode": "auto"}`, once, by hand — a session does not
read or write its own permission settings. A scheduled session with no
`defaultMode` anywhere starts in Manual and stalls on its first prompt. A
person's session takes the mode picked in the app's own selector, remembered
per folder, and the user-level key covers a session that carries no such pick.

**What the project file allows.** Allow rules for the normal task-branch git
commands, the pull-request, checks and issue operations of `gh`, API reads,
the tag and its push, the delivery scripts under `.claude/scripts/` and their
tests, and one rule per non-empty command of `.claude/flow.json`, which
`/flow-init` adds (`{task}` written as `*`). Figma permissions are read-only. There is no blanket Bash or MCP permission and no
bypass mode. The rules remove routine command prompts; they are not proof of
authentication and do not enforce business scope. Every `gh` operation names
`--repo <project.repo>` explicitly, and reads of the API go through
`gh api --method GET repos/<project.repo>/...` with the method written out.
A tag is `git tag -a v<VERSION> <merge sha> -m "v<VERSION>"` and
`git push origin refs/tags/v<VERSION>`, made only when DELIVERY's conditions
after the deployment hold (D22). Recovery uses `delivery.rollback` and nothing
else; without it, recovery is a revert pull request through the queue.

**The merge.** `Bash(gh pr merge *)` is not granted. The one way to merge is
the delivery queue's `merge`, `node .claude/scripts/delivery-queue.mjs merge
<task> --token <token> --sha <sha>`, under its own rule
`Bash(node .claude/scripts/delivery-queue.mjs *)`: it checks the lock's token
and runs `gh pr merge <n> --repo <project.repo> --merge --match-head-commit
<sha>` itself (D16, D22). No direct push to the main branch and no force push
is authorised: the Bash guard refuses both (D26), and the repository ruleset
`/flow-init` creates refuses them on GitHub where the plan allows one — on a
private repository of a Free account the guard is the only mechanism.

**The unattended delivery cycle** adds to that set
(`.claude/scheduled/delivery-cycle.md`, whose rule block is the contract):
the delivery queue's script, which covers the merge; the task's own test
resources through `commands.taskTest` and `commands.taskDown`; the issue
operations it works the queue with — `gh issue list`, `view`, `comment`,
`edit`, `close`, and `gh issue create` with `--body-file` for a follow-up
issue a run files (D15), which carries no command substitution; and `date`
and `sleep`, the second for polling checks. The kit grants no `curl` against
`project.site`: a project whose deployed checks need one adds that exact rule
in the pull request that introduces the check, as every new command does
(D5). Like every rule here, the issue rules apply in an attended session and
inside sub-agents too.

**Stopping what a run starts.** A run stops the processes it starts itself — a
dev server raised for a check, a backgrounded suite — by the PID recorded at
its start, before the step that started it reports. Neither `kill <pid>` nor
the `kill -9 <pid>` that follows it is granted, here or in any settings file:
that pair is the one command the cycle's procedure tells the run to use
without an allow rule behind it, while `TaskStop`, which stops a task the run
holds only a task id for, is a tool that needs no rule (D6). An allow rule
takes a command away from the mode's classifier, so `Bash(kill *)` would
auto-approve `kill -9` against any PID on the machine and leave prose as the
only guard, and a PID cannot be written into a narrower rule. Each attempt is
put to the classifier on its own instead, once per attempt, with the PID in
the command; in Auto that decides without prompting, so it cannot stall a
fire, and a kill it does not allow is reported rather than retried another
way. What is granted around it is the reading: `ps -o pid,ppid,command`,
with `-ax`, or `-p <pid>` for one process, and no wider `ps` rule, since the
wider forms print a process's environment into the transcript; and
`curl -sS http://localhost:*` in both option orders, for the readiness check
that confirms a server the run started is up before the kill and gone after
it. `lsof` is neither run nor granted unattended, and no process the run did
not start is touched. An ask rule stalls an unattended session for hours, so
the cycle's procedure names every asked command as out of bounds.

**The Bash guard** (D9). `hooks.PreToolUse`, matcher `Bash`, runs
`node "${CLAUDE_PROJECT_DIR}/.claude/scripts/guard-bash.mjs"` before every
Bash call, in the main session and inside sub-agents, with a 10-second limit
of its own instead of a command hook's default of 600. A hook is not a
permission rule: the entry adds no allow, ask or deny rule, and the guard can
only refuse a call — exit 2, its one line on stderr shown to the model — or
step aside with exit 0 and leave the call to the rules above. It refuses:

- `git commit` in this repository — the one `CLAUDE_PROJECT_DIR` names, with
  all its worktrees — where the target directory's branch is `main`, or where
  a `node_modules` of the target worktree is a symlink;
- `lsof` fed into `kill`, `pkill` and `killall`;
- every merge that does not go through the delivery queue's `merge`:
  `gh pr merge` with any flags, `gh api` on `repos/{owner}/{repo}/pulls/{n}/merge`
  with any method, read as GitHub routes it, a GraphQL body carrying
  `mergePullRequest` or `enablePullRequestAutoMerge`, `gh pr create` or
  `gh pr edit` with an auto-merge option, with a token in front of it or
  without, and a command it cannot read to its end that names `gh` (D16);
- a `git push` whose refspec targets the main branch — `main`, `HEAD:main`,
  `refs/heads/main`, any of them after `+` — and any force push, `-f`,
  `--force` or `--force-with-lease` (D26);
- inside the `developer`, `tester` and `tester-process` sub-agents, any
  `lsof`; the read-only `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` passes it in
  the main session;
- inside any sub-agent, the outside review and Codex (D12):
  `outside-review.sh` and its helper `outside-review.mjs` run in any spelling
  it reads, `codex` itself, and a command it cannot read to its end that
  names either.

It tells a sub-agent by the `agent_id` field of the hook input, which the hooks
reference gives only to a sub-agent (or an agent team's teammate); `agent_type`
is there for a main session started with `claude --agent` too, so that session
is not refused. A refusal that begins `guard-bash refused this command` is
therefore `.claude/scripts/guard-bash.mjs`, not a prompt and not the mode's
classifier: nothing waits for an answer, and the line says what to do instead.
Any other command the guard cannot read to its end passes, and so does a guard
that fails — a missing `node`, a timeout and a crash are non-blocking hook
errors — so that the hook is loaded is confirmed with a harmless refused form,
such as `pkill -0` on a name no process carries, and not assumed. Undo: revert
the merge commit that brought the hook, which takes the `hooks` key out of
`.claude/settings.json` together with the tests that require it.

**The outside review's rule.** `Bash(sh .claude/scripts/outside-review.sh *)`,
one rule, so that the main session's outside review (D12) does not wait on
Auto mode's judgement. The script runs OpenAI's Codex CLI itself; `codex` is
not allow-listed, and neither is the helper the script runs. Like every rule
here it also applies to a sub-agent's Bash calls; the Bash guard above refuses
the script, the helper and `codex` inside any sub-agent, so "no sub-agent runs
Codex" (`CLAUDE.md`) is held by the guard for the spellings it reads. Out of
its reach, and still held by that line alone: a name built when the command
runs (a variable, a brace expansion, a glob), a renamed copy or a link,
`npx codex`, `sh -c`, `cat … | sh` and the rest of the indirection class, and
Codex reached outside Bash. Codex, its login and its allowance are described
in `docs/tooling/codex.md`.

Use project-root command forms matching the settings. Explicit task
restrictions, role separation, the repository ruleset and managed or local
deny and ask rules still apply.

Before the first unattended run from a new machine or checkout, the main
session checks that this trusted checkout has loaded the current definitions
and settings, `gh auth status` succeeds, the roles resolve and the required
read tools work. If an existing session cached old definitions, start a new
session. Local OAuth, workspace trust or managed restrictions cannot be changed
by a repository edit; report the actual access blocker rather than claiming the
run is unattended. No live merge or rollback is performed just to test
permissions.
