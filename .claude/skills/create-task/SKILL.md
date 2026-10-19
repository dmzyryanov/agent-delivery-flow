---
name: create-task
description: Files work as GitHub issues, one or several at once. Gathers the context while the conversation still holds it, checks for a duplicate, writes each issue from the templates opening with `## Problem`, labels and files it, links it to its epic and the issues it depends on, and retells it to the owner in the owner's language. Use for /create-task and whenever an issue is about to be filed — "заведи задачу", "создай задачу", "запиши в бэклог", "создай issue".
---

# Create task

Filing turns what was said in chat — an idea, a defect, external feedback, a
part of a split or a child of an epic — into an issue that `/groom` can take up
later with no one remembering the conversation. It is mode `plan`
(`docs/DELIVERY.md`): no branch, worktree, commit or pull request. Talk to the
owner in `project.ownerLanguage` from `.claude/flow.json` (Russian by
default); write issue text in English, as the existing issues are. A question
for the owner goes in the message text, never only in a UI box. With several
issues at once, as after external feedback or a split, each goes through every
step. Filing approves nothing and starts no delivery.

`R` below is the repository `node .claude/scripts/flow-config.mjs project.repo`
prints, `owner/name`, written out in every `gh` command.

## 1. Gather the context

Collect it now, while the conversation still holds it: what was said, by whom,
when, the examples and links. In a few days nobody will remember it, and the
owner does not read issue text. Ask the owner only for what neither the
conversation, the repository nor GitHub can give: one message, numbered, each
question with a recommendation.

## 2. Look for a duplicate

Before writing, search the open issues for the same problem
(`gh issue list --repo R --state open --search "<words>" --json number,title,labels --limit 200`,
and without `--search` when the words find nothing). Where one already covers
it, propose extending that issue instead — a comment, or its description
rewritten as `/groom` step 4 does — and file nothing new for it unless the
owner says so. If that issue already carries `state:ready`, say so in the
proposal: a wider description is what the delivery cycle delivers.

## 3. Write the description

Start from `.github/ISSUE_TEMPLATE/`: `idea.md` for an idea or a chore,
`bug.md` for a bug, `epic.md` for an epic. Keep the template's sections and
order, drop its front matter and placeholder comments, and leave a section the
conversation cannot answer for `/groom`. Answer `Design needed` only when it
is known: `no` waives the delivery cycle's design gate. An epic is filed here
only when the owner asks for one by name; a big goal goes to `/decompose`,
which files the epic and its children together (D25).

The description opens with `## Problem`, four labelled lines in plain words for
a reader who was not in the conversation:

- **What is wrong:** the problem now, who meets it and where, an example.
- **Where it came from:** the source and its date — the owner's idea in chat,
  external feedback, a scheduled run, a production incident, a retrospective,
  a split at grooming, `/decompose` — with a link or reference.
- **If we do it:** what changes for users or for the owner.
- **If we don't:** the cost of leaving it: who suffers, whether it grows.
  "Nothing much" when that is the honest answer.

Fetch `origin` and check every factual claim against `origin/main`: files,
quoted sentences, decisions, numbers. Cite code and docs by a quoted sentence,
not a line number, and mark inference as such. What only the owner can decide
goes under `## Questions for the owner`, numbered, each with a recommendation.

Each of several issues states its own origin in full, never "see #N": it is
read alone. Cross-links are lines of their own: `Depends on #<n>` where one
needs another delivered first, one line per issue or several numbers on one
line (`Depends on #12, #14`); `Epic: #<n>` for a child of an epic;
`Related: #<n>` otherwise. Never a closing keyword before an issue number —
`close`, `fix` or `resolve` in any form (`Closes #<n>`, `Fixed #<n>`,
`Resolves #<n>`): a pull request or a commit carrying one closes the issue when
it reaches the main branch, before anyone has verified it, and text from an
issue is often copied into one.

## 4. Label and file

One `type:` label — `type:idea`, `type:chore` or `type:bug`, and `type:epic`
only for an epic — and one `area:` label: `area:backend`, `area:frontend`,
`area:infra` or `area:docs`. A full-stack issue carries `area:frontend`, which
brings the delivery cycle's design gate; its `## Touches`, written at
grooming, names every area it touches. Never `state:grooming` or `state:needs-owner`, which only grooming
sets — `/groom` and the scheduled grooming — nor `state:ready`;
`state:deferred` only when the owner says the work is for later, and `prio:*`
only on the owner's explicit word, one `prio:` label at most (D1, D13,
D14, D22). An epic carries no `state:` label at all.

Write each description to a file in the scratchpad with the Write tool and, in
a later call — never in the same parallel batch as that Write, which gives no
order — file it, with a short English title as the existing issues have:

```sh
gh issue create --repo R --title "<title>" --body-file <file> --label "type:<type>,area:<area>"
```

It prints the new issue's URL, whose last part is its number. With several,
file the one others depend on first, so that each `Depends on #<n>` names an
issue that exists; then add the links an issue filed earlier still lacks, its
description updated as `/groom` step 4 does.

**A child of an epic.** It carries its `Epic: #<epic>` line, and the epic
lists it. Read the epic's description
(`gh issue view <epic> --repo R --json body --jq .body`), write it to a file
in the scratchpad with `- [ ] #<new> <title>` added under `## Children` in
delivery order, and replace it in a later call:

```sh
gh issue edit <epic> --repo R --body-file <file>
```

Then check with `gh issue view <epic> --repo R --json body` that the line is
there. Never change the boxes others ticked.

## 5. Report

One message, in the owner's language. Per issue: `#<n> <title>`, its link,
then the owner's context block taken from its `## Problem`: **Проблема**,
**Откуда**, **Если сделаем**, **Если не сделаем** (in another language:
Problem, Where from, If we do it, If we don't), one or two lines each, in
plain words, with no file paths or decision numbers, inference marked. For a
child of an epic, the epic it joined. Under it, in one line, the questions
left for the owner, if any, written out in the message; `/groom` takes them
up.
