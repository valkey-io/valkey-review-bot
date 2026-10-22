---
name: writing-reviewer-skills
description: Writes, restructures and checks the knowledge the review agents load. That covers built-in skills in agents/<id>/config/skill.md, the curator's skill reference and skill-related rules in reviewer prompts. Use when creating or editing any config/skill.md, landing a new reviewer, or reviewing a pull request that changes reviewer knowledge, even if the request only says "update the reviewer" or "add what maintainers keep asking for".
---

# Writing reviewer skills

A reviewer's `config/skill.md` is appended to its system prompt on every review, and every sentence in it becomes something the reviewer may assert on a pull request. A wrong or vague line costs more than a missing one. This file is the standard for writing and changing that knowledge. `agents/curator/skills/how-to-write-a-skill.md` is the curator's runtime reference for graduated registry skills; keep the two consistent when either changes.

## Where the knowledge comes from

Write only what the reviewer would get wrong without it: contracts the code does not spell out, decisions recorded elsewhere, and what maintainers repeat in review. Source every claim from the project itself:

- the code at the upstream default branch (read it; do not rely on memory or general knowledge);
- the project's own guides (`AGENTS.md`, `CONTRIBUTING.md`, ADRs, release and backport docs);
- recent maintainer review comments on merged pull requests.

A skill written from general model knowledge does not improve reviews and often makes them worse. Leave out anything a competent reviewer derives from reading the surrounding code for a few minutes, and anything generic about the language or framework.

## Required layout of a built-in skill

Follow the layout `agents/valkey-review/config/skill.md` uses, in this order. Omit a section only when it would be empty.

1. **Title and one scope paragraph.** What the skill covers and what it assumes. No narration about the file itself.
2. **Operating rules.** The evidence rule (a pattern is evidence only after its "wrong when" condition is confirmed at a cited line), the confidence ladder (high, medium, low; post high and medium, drop low), "skip a pattern whose gate does not match", "the tighter gate wins", and the noise classes this project's reviewers should drop. Keep this near the top: early text is followed more reliably than late text.
3. **Always-on checks.** Deterministic checks that run on every pull request. Write each as one reviewer tool call and the exact string to look for, in a fenced block. The reviewer has no shell, so no pipes.
4. **Do NOT flag.** Intended behavior that reads like a bug, each with the exact identifier and the reason. Without it, reviewers fire patterns on compatibility shims and documented exceptions.
5. **Patterns.** One `###` heading per invariant, each with exactly these three lines:

   ```
   ### <specific pattern name>
   The diff looks OK but is wrong when: <what looks fine in the diff but breaks the invariant>
   Reviewer memory: <the invariant and the facts behind it that the code does not make obvious>
   Skip unless: <the file, function or identifier that must appear in the diff>
   ```

   Every pattern has a `Skip unless:` gate. A pattern without a gate fires on every pull request. Make gates of overlapping patterns mutually exclusive, or merge the patterns.

## Writing rules

- **Exact names in backticks.** Every file path, function, type, constant, config key and command, spelled as in the code. `scripts/skill-facts.mjs` looks up every backticked name upstream; a misspelled, paraphrased or invented name reads as stale.
- **Placeholders only in fenced blocks.** An angle-bracket placeholder or an invented example name in backticks in prose would be looked up and reported absent.
- **Defaults in one sentence with their name:** "`<name>` defaults to <value>."
- **No pull request numbers, issue numbers, maintainer names or logins.** The pattern is the signal; identities and numbers rot.
- **No time-sensitive wording** ("now", "recently", "as of", "no longer", "since the rewrite"). State the current invariant. History that still matters for older release lines goes in the reviewer memory as a fact about those lines.
- **Reasons over capitals.** Say why a rule exists instead of writing ALWAYS or NEVER.
- **Require evidence, not ritual.** Ask for a cited line and a confirmed condition. Do not add mandatory exhaustive checklists; they slow every review and displace the reviewer's own judgement.
- **Consistent terms.** Use the project's names for its concepts, the same way every time.

## Length

Target 80 to 250 lines for a built-in skill. Above 500 lines instructions get buried and are ignored. A long skill earns its length only through dense, project-specific memory across many areas. When a section grows, split the pattern or cut what the reviewer would get right anyway.

## Checks before a pull request

Run all of these and name the upstream ref you checked in the pull request.

1. Cited names exist upstream:

   ```sh
   node scripts/skill-facts.mjs --file agents/<id>/config/skill.md --repo <owner>/<repo>
   ```

   It exits 0 when clean and 2 when names are absent.
2. Claims match the code. Have a reviewer with no prior context check each factual claim against the upstream default branch, citing `file:line` for each one it confirms, and fix or remove the rest. `skill-facts` only proves the names exist, not that the sentences about them are true.
3. Structure. Each pattern has its three lines, the confidence ladder is near the top, and the forbidden wording above is absent.
4. Tests of the reviewer package pass (`npm test` in `agents/<id>`), and `agnix .` passes for this repository's agent files, including this skill.
5. Ask a maintainer of the reviewed project to read the patterns as claims the reviewer will make, and to say where one is wrong or needs a carve-out.

## After it ships

- After each upstream GA release the curator checks the skill's names against the release and may correct published text. Text an upstream release superseded is kept inside `<!-- suppressed: ... -->` blocks for backports to older lines. Never write, edit or remove those markers by hand; code generates them and `submit_skill` refuses changes to them.
- Stale-skill fixes go through the skill lifecycle or a maintainer, never as silent rewrites.
- When a maintainer corrects the reviewer, add the correction as a pattern, a reviewer-memory fact or a Do NOT flag entry, and generalize it rather than adding a one-off rule.
