# Issue tracker: GitHub

This repo's issues and PRDs live in GitHub issues. All operations use the `gh` CLI.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filter comments with `jq`, and fetch labels at the same time.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, add `--label` and `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

**Always pass the repo explicitly** (`-R samuelchanx/zcode-acp`).
This clone has two GitHub remotes — `origin` (samuelchanx/zcode-acp, the
project tracker) and `upstream` (william0wang/zcode-acp, someone else's) —
and `gh` prefers the `upstream` remote when both exist, so bare `gh issue …`
commands land on the wrong tracker silently (observed 2026-09-30: a spec
issue was published upstream by accident). **Never create issues on
upstream** (ruling 2026-09-30). The fork's issue tracker is the project
tracker (enabled 2026-09-30) and carries the five canonical triage labels;
samuelchanx owns it, so labels and edits work without permission issues.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
