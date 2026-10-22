# AGENTS.md

Instructions for coding agents working in this repository. People and agents follow the same rules in [CONTRIBUTING.md](CONTRIBUTING.md); this file adds what agents need on top.

## Reviewer knowledge

Before you write or change any reviewer knowledge, read [.agents/skills/writing-reviewer-skills/SKILL.md](.agents/skills/writing-reviewer-skills/SKILL.md) and follow it. That covers:

- a built-in skill, `agents/<id>/config/skill.md`;
- the curator's skill reference, `agents/curator/skills/how-to-write-a-skill.md`;
- rules about skills in a reviewer's prompt, such as `agents/valkey-review/config/prompt.md`.

A pull request that changes reviewer knowledge is reviewed against that skill, including its checks before a pull request.

## Other tasks

- Adding a reviewer for a new project: follow [docs/landing-a-new-project.md](docs/landing-a-new-project.md).
- How the pieces fit together: [docs/architecture.md](docs/architecture.md). Security boundaries: [SECURITY.md](SECURITY.md).
