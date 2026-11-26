# valkey-review-bot PR reviewer skill

Institutional memory for reviewing valkey-io/valkey-review-bot pull requests: the security model of the reviewers and the curator, the lists that must change together, and contracts between the receiver, the queues and the agents that the code does not spell out. General AWS CDK, Lambda and TypeScript knowledge is assumed. Where the code at the PR head disagrees with this file, the code wins: cite the code.

## Operating rules

- A pattern counts as evidence only after you confirm its "wrong when" condition in the diff, at a line you can cite. A matching "Skip unless" gate is a reason to look, not a finding.
- Confidence ladder: **high** = a cited source line plus a confirmed pattern, or a test that reproduces the failure; **medium** = a confirmed pattern at a cited line; **low** = a gate match or a suspicion without a confirmed condition. Post high and medium. Drop low.
- When a pattern's gate does not match the diff, skip it entirely. When several patterns apply, the one with the tighter gate wins. Do not pile on.
- Security patterns (IAM grants, tokens and brokers, processes that run pull request code, untrusted text) outrank everything else: with `allowBuild` on, the default, a reviewer runs code from any pull request on any repository routed to it, and that code can use the reviewer's role and its token broker.
- Drop noise: formatting, renames, "consider refactoring", "add a test" without saying what it checks.

## Always-on checks

Run these regardless of diff shape. Each is one tool call; look for the exact string.

- DCO: every commit message needs a sign-off line (`CONTRIBUTING.md`).

  ```
  git ["log", "--format=%B", "<mergeBase>..<head>"]   -> each message contains "Signed-off-by:"
  ```

- Prompt and skill changes say which review behavior they change: when the diff touches `agents/*/config/*.md`, the pull request description names the behavior.

  ```
  git ["diff", "--name-only", "<mergeBase>..<head>", "--", "agents/"]   -> any path ending in "/config/prompt.md", "/config/skill.md" or "/config/skill-check.md"
  ```

- Lockfile and manifest move together: a change to `dependencies`, `devDependencies`, `optionalDependencies` or `overrides` in a `package.json` needs the matching `package-lock.json` change in the same directory, or `npm ci` in CI fails on the out-of-sync lockfile. A lockfile-only change (a transitive or in-range bump, as Dependabot opens) is fine, and so is a `package.json` change to other fields such as `scripts`.

  ```
  git ["diff", "--name-only", "<mergeBase>..<head>"]   -> a "package.json" path without the "package-lock.json" in the same directory
  git ["diff", "<mergeBase>..<head>", "--", "<dir>/package.json"]   -> whether a dependency field changed
  ```

## Do NOT flag

- `npm ls` reporting the optional `openai` peer of the Strands SDK (@strands-agents/sdk declares `openai` 6, the agents use `openai` 7): accepted; the lockfiles install with `npm ci`.
- `infra/` installing TypeScript 7 under the alias @typescript/native and pointing `typescript` at @typescript/typescript6: intended, because ts-jest and ts-node need a JavaScript compiler API that TypeScript 7 does not ship. The tsc binary there is TypeScript 7.
- The lifecycle switches `applyEdits`, `retireSkills` and `openPullRequests` defaulting to `false`, and the example configuration keeping them off: intended. Turning one on by default is a product decision for maintainers, not a fix.

## Patterns

### Reviewer id missing from a hand-kept list
The diff looks OK but is wrong when: a pull request adds, renames or removes a reviewer and misses one of the lists the type-check does not catch, or renames an id in a live deployment without saying what it replaces.
Reviewer memory: `REVIEWER_IDS` in `infra/lib/deployment-config.ts` is a closed `as const` list and `ReviewerId` is its union. The type-check of `infra/` flags a missing entry in the `skillsRegistries` and `upstreamRepos` objects in `parseDeploymentConfig`, the object `parseAgents` returns, and `REVIEWERS` in `infra/lib/app.ts`. It does not catch: `.dockerignore` (an allowlist; a missing entry fails only at `docker build`, which runs at deploy), both package loops in `.github/workflows/ci.yml`, the loop in `CONTRIBUTING.md`, the `npm` and `docker` entries in `.github/dependabot.yml`, `infra/deploy.config.example.json`, `fixture()` in `infra/test/helpers.ts`, the expected maps and per-reviewer loops in `infra/test/infra.test.ts` and `infra/test/deployment-config.test.ts`, the shared-sections check in `agents/valkey-review/test/prompt.test.mjs`, which reads each reviewer prompt by path, the curator's `agents/curator/config/prompt.md` and `agents/curator/config/skill.md`, and the counts in `README.md`, `infra/README.md` and `docs/architecture.md`. `docs/landing-a-new-project.md` names them all. The id fixes the concerns table (`<id>_concerns` with `-` as `_`), the runtime name (`<id>_runtime`, at most 48 characters), the assets prefix and the broker's construct id, so a rename replaces all of them. Every id is always deployed and `skillsRegistries.<id>` is required, so a new id breaks every operator's existing deploy.config.json until a registry is added; the pull request and `infra/README.md` should say so.
Skip unless: the diff adds, renames or removes a reviewer, an agent package or a package directory.

### Reviewer role granted more than it needs
The diff looks OK but is wrong when: a grant reaches a reviewer role beyond its list below, or a pull request edits a pinned expectation in `infra/test/infra.test.ts` without the reason and without `SECURITY.md`, `docs/architecture.md` and the grants in `infra/README.md` (Stacks section) changing with it.
Reviewer memory: runtime roles come from `createRuntimeRole` and registry ARNs from `registryResources`. A reviewer role may call its models, `s3:GetObject` under its own prefix, `kms:Decrypt` on the whole substrate key (which also encrypts the concerns tables), read its own registry, `GetItem`/`PutItem`/`UpdateItem` on any item of the heartbeat table, invoke its own broker, write its own runtime log groups and pull from the bootstrap image repository. Nothing else. `infra/test/infra.test.ts` pins this per reviewer: no `secretsmanager:` action, registry actions limited to `agent-registry:GetRegistryRecord` and `agent-registry:ListRegistryRecords`, no DynamoDB statement on a `ConcernsTable`. Only the curator role holds `agent-registry:UpdateRegistryRecordStatus`. A grant to "every reviewer" is a grant to code from every pull request on every routed repository; the image repository grant already reaches every image in the bootstrap repository.
Skip unless: the diff touches `infra/lib/grants.ts`, `infra/lib/bedrock-arns.ts`, a stack's `PolicyStatement`, an `addToPrincipalPolicy`, `addToRolePolicy` or `grant*` call, or `infra/test/infra.test.ts`.

### Token permissions or broker checks widened
The diff looks OK but is wrong when: a new permission appears in `RECEIVER_TOKEN_PERMISSIONS` or `TOKEN_PERMISSIONS`, the broker's two checks are reordered or skipped, or the skills-repo broker takes its repository or App from the request.
Reviewer memory: the permission sets are constants: `RECEIVER_TOKEN_PERMISSIONS` (`pull_requests: write`, `issues: read`, `metadata: read`), `TOKEN_PERMISSIONS` (`pull_requests: write`, `metadata: read`) and `SKILLS_REPO_TOKEN_PERMISSIONS` (adds `contents: write`). A new permission in `TOKEN_PERMISSIONS` reaches the reviewer runtimes, which run pull request code, on every repository routed to that reviewer. `RECEIVER_TOKEN_PERMISSIONS` tokens stay in the receiver Lambda, but they are not limited to one repository, so a new permission there covers every repository of the installation. `createTokenBroker` refuses a repository that is not in `ALLOWED_REPOS_JSON` (built by `tokenBrokerRepos`, review routes only, curator-only routes excluded), then asks GitHub for the App's installation on the repository and refuses unless it is the caller's installation and its account owns the repository; both checks run, in that order, before any token is issued. The skills-repo broker takes its repository from `SKILLS_REPO` and its App from `SKILLS_REPO_APP_SECRET_NAME`, and only the curator role may invoke it.
Skip unless: the diff touches `webhook/src/broker.ts`, `webhook/src/token-broker.ts`, `webhook/src/skills-repo-broker.ts`, `RECEIVER_TOKEN_PERMISSIONS`, `createInstallationTokens` or `fetchRepoInstallation` in `webhook/src/github.ts`, or `tokenBrokerRepos` in `infra/lib/deployment-config.ts`.

### Token exposed to a process, a log or git config
The diff looks OK but is wrong when: a token goes into the clone's git config, a remote URL, a command line or a log line, or is shown to a model.
Reviewer memory: `gitAuthEnv` passes tokens per process through `GIT_CONFIG_COUNT`. `createTokenSource` refreshes five minutes before expiry.
Skip unless: the diff touches `webhook/src/github.ts`, `agents/common/src/github-auth.ts`, `agents/common/src/workspace.ts` (`gitAuthEnv`), `agents/common/src/tools/gh.ts` (`gh_api_read`), `agents/curator/src/skills-repo-token.ts`, or other code that runs `git` or `gh` with credentials.

### Tool that runs pull request code outside the pattern
The diff looks OK but is wrong when: a new or changed tool uses a shell, installs, publishes, logs in or fetches, rewrites tracked source files from a build or test action (formatters, `--fix`, `-w`, `--write`), passes a credential-bearing variable after `buildChildEnv()`, or lists actions that differ between the tool description, the prompt's Build section and the policy.
Reviewer memory: the pattern is an argv array, a policy module with no imports that its own tests load directly (`build-policy.ts`, `make-policy.ts`), `runBounded` with an 8 minute and 1 MB limit, `buildChildEnv()` for the environment and `resolveInside` for the working directory. `buildChildEnv()` drops names that start with `AWS_`, `AMAZON_`, `GH_` or `GITHUB_` or contain `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `PRIVATE_KEY`. valkey-glide-review's `build-policy.test.mjs` compares the tool description and the prompt's Build section with the policy. valkey-review's `make-policy.test.mjs` compares only the prompt's Targets and Vars lines with the policy, and `make.ts` builds its description from the same constants. A rewrite of tracked source moves the lines the review anchors to. Build outputs are expected, and the harness write and edit tools in `agents/common/src/tools/harness.ts`, offered when `ALLOW_WRITE` is on (`allowWrite`, default true), are a deliberate exception.
Skip unless: the diff adds or changes a tool, a build wrapper or a policy module in a reviewer's tools directory or in `agents/common/src/tools/` (including `child-env.ts`, `spawn.ts`, `git.ts`, `harness.ts` and `index.ts`).

### Git or REST allowlist widened
The diff looks OK but is wrong when: a git subcommand, a REST path or a readable repository is added, or a forbidden git option is removed, without being treated as a security change.
Reviewer memory: `checkGitArgs` and `checkGhApiPath` are the allowlists of the `git` and `gh_api_read` tools, and `gh_api_read` runs with the installation token.
Skip unless: the diff touches `agents/common/src/tools/git.ts` (`GIT_READONLY_SUBCOMMANDS`, `FORBIDDEN_LONG_OPTIONS`, `FORBIDDEN_SHORT_OPTIONS`, `LISTING_OPTIONS`, `SAFE_DIFF_OPTIONS`, `checkGitArgs`, `gitEnv`) or `agents/common/src/tools/gh.ts` (`GH_API_READ_PATTERNS`, `readableRepos`, `checkGhApiPath`).

### Untrusted text reaching a prompt or log unfenced
The diff looks OK but is wrong when: text that a PR author or another GitHub user wrote reaches the PR overview outside an `untrusted-pr-content` block, or a new prompt path adds comment text without the push-permission check and `createSafetyGate` that the @mention request passes; a new file path is written into a prompt outside the blocks as anything but a JSON string, as `mentionBlock` in `agents/common/src/run-agent.ts` and `quotePath` in `webhook/src/mention.ts` do; or the curator logs model text, or strings from a table or a request, without `quoted` (`agents/curator/src/log-text.ts`; `ops/src/decay.ts` has its own copy).
Reviewer memory: in the PR overview (`renderPrOverview`), pull request and comment text goes inside `untrusted-pr-content` blocks, and any opening or closing tag of that name inside it is defused. The @mention instruction is the exception: `mentionBlock` adds it unfenced, after the push-permission check and `createSafetyGate`. The App's quoted comment in a thread reply, the base branch and the App's own state comment are unfenced by design. The state comment's finding locations are the one exception to the JSON-string rule: `findingLine` in `agents/common/src/review-state.ts` folds them onto one line and replaces backticks. The reviewer runtime does not use `quoted`: `agents/common/src/run-agent.ts` logs up to 400 raw characters of the final model text when a review ends without a terminal tool, and 200 characters of each tool input. The curator fences feedback, skills and diffs between random markers, and logs model text only through `quoted` (`agents/curator/src/log-text.ts`), so it cannot start a line or pass for a `[maintenance]` report line.
Skip unless: the diff touches `renderPrOverview`, `mentionBlock`, `webhook/src/mention.ts`, the curator's first message, or a log line that prints text from GitHub or a model.

### Safety gate or state marker that fails open
The diff looks OK but is wrong when: `createSafetyGate` lets an error, a timeout or an unparsable verdict through as an allow, or the state comment can be found or forged without the App id check.
Reviewer memory: `createSafetyGate` denies on any error, timeout or unparsable verdict; a change that lets an error through as an allow is blocking. `findStateComment` checks the App id as well as `STATE_MARKER`, and `stripStateMarker` keeps model text from forging the marker.
Skip unless: the diff touches `createSafetyGate`, `findStateComment`, `stripStateMarker` or `STATE_MARKER`.

### Receiver gate taken without give-back
The diff looks OK but is wrong when: a new early return in `pullRequest` skips giving back what it took, which leaks a round or a pending marker, or the gates change order.
Reviewer memory: gate order matters: claim the idempotency key, take the pending marker (`markReviewPending`), take a round (`takeAutoReview`), then a budget slot (`takeReviewSlot`). A review that is not queued gives back its round, its pending marker and its idempotency key, newest first (the `taken` stack in `pullRequest`). A budget slot that was taken is not given back: a failed send still uses it.
Skip unless: the diff touches `webhook/src/delivery.ts` or `webhook/src/store.ts`.

### Heartbeat or timeout tuning changed alone
The diff looks OK but is wrong when: `heartbeatRunKey` and the run key in `agents/common/src/run-agent.ts` stop producing the same string, `isFresh` is relaxed, or one of the tuned timeouts changes without the others.
Reviewer memory: `isFresh` and `CLOCK_SKEW_MS` exist because pull request code can write heartbeat records; a record counts as live only when a run could have written it. The 15 minute worker Lambda timeout (`WORKER_TIMEOUT`), the 16 minute visibility timeout (`QUEUE_VISIBILITY`), `RUN_BUDGET_MINUTES` (default 90, `webhook/src/config.ts`) and `REVIEW_MAX_RECEIVES` (8, one above the ceil(90 / 16) + 1 = 7 receives of a healthy long review) are tuned together (`docs/architecture.md`, section 3): changing one changes how often a long review is received before it dead-letters. `HEARTBEAT_STALE_MINUTES` (default 12) must stay above the longest quiet stretch of a live run.
Skip unless: the diff touches `webhook/src/invoker.ts`, `webhook/src/watchdog.ts`, `webhook/src/review-envelope.ts`, `agents/common/src/run-agent.ts`, `webhook/src/config.ts`, or the timeout, visibility or receive constants in `infra/lib/webhook-stack.ts`.

### Skill lifecycle write that loses or forges state
The diff looks OK but is wrong when: suppressed blocks are not kept byte for byte, code deprecates a registry record to "clean up", a maintenance write drops its conditions, or the skill size limits stop fitting together.
Reviewer memory: only the release check writes suppression markers, `parseSuppressed` decides what is well formed, and `submit_skill` must refuse text that adds, drops or changes a block. `DEPRECATED` is final in AWS Agent Registry: `upsertSkill` throws `SkillRetiredError` and changes nothing, so a deprecated record is lost for good. Maintenance writes that change a skill's state are conditioned on the claim (`maintenance_id`) and on `graduated_record_name` (a `repo_check` run on the claim alone). The release write is conditioned on `maintenance_id` alone, and the writes after an applied edit on `revised_at` and `graduated_record_name`. A write that drops its condition can act on a stale or forged message. Graduated skills load within `GRADUATED_SKILLS_MAX_CHARS`, and `submit_skill` accepts at most `GRADUATED_SKILL_MAX_CHARS`, half of it, so every skill fits.
Skip unless: the diff touches `agents/curator/src/`, `agents/common/src/skill-check/`, `agents/common/src/graduated-skills.ts`, `agents/common/src/skills-registry.ts` or `ops/src/`.

### Node or TypeScript setup broken
The diff looks OK but is wrong when: a `tsconfig.json` drops `node` from `compilerOptions.types`, or code in `webhook/` or `ops/` uses an API Node 24 lacks.
Reviewer memory: TypeScript 7 loads the Node type package (@types/node) only when `compilerOptions.types` names it, and every package's `tsconfig.json` does (`node`, plus `jest` in `infra/`). The Lambdas run `NODEJS_24_X` (bundled with `target: 'node24'`); the agent images run Node 26 (`NODE_MAJOR` in the reviewer Dockerfiles, the `node:26` base image in the curator's).
Skip unless: the diff touches a `tsconfig.json`, a `package.json`, a lockfile, a Dockerfile, or code under `webhook/` or `ops/`.

### Configuration key without its check, row or default
The diff looks OK but is wrong when: a new configuration key lacks a parser check in `parseDeploymentConfig`, a row in `infra/README.md` with its default and range, or, for lifecycle and round settings, its default spelled out in the example; or an example route breaks the test that requires a repository under your-org and `threadReplyReview` set to `true`.
Reviewer memory: real account IDs, App IDs, registry IDs and secret values never go in git: the real configuration, deploy.config.json in `infra/`, is ignored, and CI runs a scrump secret scan on every tracked file except the lockfiles.
Skip unless: the diff touches `infra/lib/deployment-config.ts` or `infra/deploy.config.example.json`.

### Behavior change without docs
The diff looks OK but is wrong when: a change to a default, a limit, a permission or a flow does not update the docs that cite it in the same pull request.
Reviewer memory: the docs cite code names and numbers: `docs/architecture.md`, `infra/README.md`, `webhook/README.md`, `SECURITY.md` and `README.md`. The agents' tests pin prompt text. `prompt.test.mjs` pins the quoted first-message section names, the reply kinds, the shared "Mention-triggered reviews" section across reviewer prompts and the superseded-pieces paragraph. The tool tables are pinned by the reviewers' `assemble-tools.test.mjs` and by the curator's `get-skill.test.mjs` and `check-run.test.mjs`. Each reviewer's build or make policy test requires no em dashes in its own prompt.md and skill.md.
Skip unless: the diff changes a default, a limit, a permission, a flow, a doc, or `agents/*/config/*.md`.
