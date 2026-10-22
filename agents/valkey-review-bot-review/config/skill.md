# valkey-review-bot PR reviewer skill

Institutional memory for reviewing valkey-io/valkey-review-bot pull requests: the security model of the reviewers and the curator, the lists that must change together, and contracts between the receiver, the queues and the agents that the code does not spell out. General AWS CDK, Lambda and TypeScript knowledge is assumed. Where the code at the PR head disagrees with this file, the code wins: cite the code.

## Operating rules

- A pattern counts as evidence only after you confirm its "wrong when" condition in the diff, at a line you can cite. A matching "Skip unless" gate is a reason to look, not a finding.
- Confidence ladder: **high** = a cited source line plus a confirmed pattern, or a test that reproduces the failure; **medium** = a confirmed pattern at a cited line; **low** = a gate match or a suspicion without a confirmed condition. Post high and medium. Drop low.
- When a pattern's gate does not match the diff, skip it entirely. When several patterns apply, the one with the tighter gate wins. Do not pile on.
- Security patterns (IAM grants, tokens and brokers, processes that run pull request code, untrusted text) outrank everything else: every reviewer runs code from every pull request on every routed repository.
- Drop noise: formatting, renames, "consider refactoring", "add a test" without saying what it checks.

## Always-on checks

Run these regardless of diff shape. Each is one tool call; look for the exact string.

- DCO: every commit message needs a sign-off line (`CONTRIBUTING.md`).

  ```
  git ["log", "--format=%B", "<mergeBase>..<head>"]   -> each message contains "Signed-off-by:"
  ```

- Prompt and skill changes say which review behavior they change: when the diff touches `agents/*/config/*.md`, the pull request description names the behavior.

  ```
  git ["diff", "--name-only", "<mergeBase>..<head>", "--", "agents/"]   -> any path ending in "/config/prompt.md" or "/config/skill.md"
  ```

- Lockfile and manifest move together: a lockfile change without its `package.json` change, or the reverse, does not install the same way in CI (`npm ci`) as on the author's machine.

  ```
  git ["diff", "--name-only", "<mergeBase>..<head>"]   -> a "package-lock.json" path without the "package.json" in the same directory, or the reverse
  ```

## Do NOT flag

- `npm ls` reporting the optional `openai` peer of the Strands SDK (@strands-agents/sdk declares `openai` 6, the agents use `openai` 7): accepted; the lockfiles install with `npm ci`.
- `infra/` installing TypeScript 7 under the alias @typescript/native and pointing `typescript` at @typescript/typescript6: intended, because ts-jest and ts-node need a JavaScript compiler API that TypeScript 7 does not ship. The tsc binary there is TypeScript 7.
- The lifecycle switches `applyEdits`, `retireSkills` and `openPullRequests` defaulting to `false`, and the example configuration keeping them off: intended. Turning one on by default is a product decision for maintainers, not a fix.

## Patterns

### Reviewer id missing from a hand-kept list
The diff looks OK but is wrong when: a pull request adds, renames or removes a reviewer and misses one of the lists the type-check does not catch, or renames an id in a live deployment without saying what it replaces.
Reviewer memory: `REVIEWER_IDS` in `infra/lib/deployment-config.ts` is a closed `as const` list and `ReviewerId` is its union. The type-check of `infra/` flags a missing entry in the `skillsRegistries` and `upstreamRepos` objects in `parseDeploymentConfig`, the object `parseAgents` returns, and `REVIEWERS` in `infra/lib/app.ts`. It does not catch: `.dockerignore` (an allowlist; a missing entry fails only at `docker build`, which runs at deploy), both package loops in `.github/workflows/ci.yml`, the loop in `CONTRIBUTING.md`, the `npm` and `docker` entries in `.github/dependabot.yml`, `infra/deploy.config.example.json`, `fixture()` in `infra/test/helpers.ts`, the expected maps and per-reviewer loops in `infra/test/infra.test.ts` and `infra/test/deployment-config.test.ts`, the curator's `agents/curator/config/prompt.md` and `agents/curator/config/skill.md`, and the counts in `README.md`, `infra/README.md` and `docs/architecture.md`. `docs/landing-a-new-project.md` names them all. The id fixes the concerns table (`<id>_concerns` with `-` as `_`), the runtime name (`<id>_runtime`, at most 48 characters), the assets prefix and the broker's construct id, so a rename replaces all of them. Every id is always deployed and `skillsRegistries.<id>` is required, so a new id breaks every operator's existing deploy.config.json until a registry is added; the pull request and `infra/README.md` should say so.
Skip unless: the diff adds, renames or removes a reviewer, an agent package or a package directory.

### Reviewer role granted more than it needs
The diff looks OK but is wrong when: a grant reaches a reviewer role beyond its list below, or a pull request edits a pinned expectation in `infra/test/infra.test.ts` without the reason and without `SECURITY.md` and `docs/architecture.md` changing with it.
Reviewer memory: runtime roles come from `createRuntimeRole` and registry ARNs from `registryResources`. A reviewer role may call its models, get objects under its own prefix with `kms:Decrypt`, read its own registry, use the heartbeat table, invoke its own broker, write its own log groups and pull from the bootstrap image repository. Nothing else. `infra/test/infra.test.ts` pins this per reviewer: no `secretsmanager:` action, registry actions limited to `agent-registry:GetRegistryRecord` and `agent-registry:ListRegistryRecords`, no DynamoDB statement on a `ConcernsTable`. Only the curator role holds `agent-registry:UpdateRegistryRecordStatus`. A grant to "every reviewer" is a grant to code from every pull request on every routed repository; the image repository grant already reaches every image in the bootstrap repository.
Skip unless: the diff touches `infra/lib/grants.ts`, a stack's `PolicyStatement`, an `addToRolePolicy` or `grant*` call, or `infra/test/infra.test.ts`.

### Token permissions or broker checks widened
The diff looks OK but is wrong when: a new permission appears in `RECEIVER_TOKEN_PERMISSIONS` or `TOKEN_PERMISSIONS`, the broker's two checks are reordered or skipped, or the skills-repo broker takes its repository or App from the request.
Reviewer memory: the permission sets are constants: `RECEIVER_TOKEN_PERMISSIONS` (`pull_requests: write`, `issues: read`, `metadata: read`), `TOKEN_PERMISSIONS` (`pull_requests: write`, `metadata: read`) and `SKILLS_REPO_TOKEN_PERMISSIONS` (adds `contents: write`). A new permission in the first two lets pull request code use it on every routed repository. `createTokenBroker` refuses a repository that is not in `ALLOWED_REPOS_JSON` (built by `tokenBrokerRepos`, review routes only, curator-only routes excluded), then asks GitHub for the App's installation on the repository and refuses unless it is the caller's installation and its account owns the repository; both checks run, in that order, before any token is issued. The skills-repo broker takes its repository from `SKILLS_REPO` and its App from `SKILLS_REPO_APP_SECRET_NAME`, and only the curator role may invoke it.
Skip unless: the diff touches `webhook/src/broker.ts`, `webhook/src/token-broker.ts` or `webhook/src/skills-repo-broker.ts`.

### Token exposed to a process, a log or git config
The diff looks OK but is wrong when: a token goes into the clone's git config, a remote URL, a command line or a log line, or is shown to a model.
Reviewer memory: `gitAuthEnv` passes tokens per process through `GIT_CONFIG_COUNT`. `createTokenSource` refreshes five minutes before expiry.
Skip unless: the diff touches `webhook/src/github.ts`, `agents/common/src/github-auth.ts`, or code that runs `git` with credentials.

### Tool that runs pull request code outside the pattern
The diff looks OK but is wrong when: a new or changed tool uses a shell, installs, publishes, logs in or fetches, writes files in the checkout (formatters, `--fix`, `-w`), passes a credential-bearing variable after `buildChildEnv()`, or lists actions that differ between the tool description, the prompt's Build section and the policy.
Reviewer memory: the pattern is an argv array, a policy module with no imports that its own tests load directly (`build-policy.ts`, `make-policy.ts`), `runBounded` with an 8 minute and 1 MB limit, `buildChildEnv()` for the environment and `resolveInside` for the working directory. `buildChildEnv()` drops names that start with `AWS_`, `AMAZON_`, `GH_` or `GITHUB_` or contain `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `PRIVATE_KEY`. The build-policy tests compare the description, the prompt and the policy. A write in the checkout moves the lines the review anchors to.
Skip unless: the diff adds or changes a tool, a build wrapper or a policy module in a reviewer's tools directory, or touches `agents/common/src/tools/child-env.ts` or `agents/common/src/tools/spawn.ts`.

### Git or REST allowlist widened
The diff looks OK but is wrong when: a new git subcommand or REST path is added to an allowlist without being treated as a security change.
Reviewer memory: `checkGitArgs` and `checkGhApiPath` are the allowlists of the `git` and `gh_api_read` tools, and `gh_api_read` runs with the installation token.
Skip unless: the diff touches `checkGitArgs` or `checkGhApiPath`.

### Untrusted text reaching a prompt or log unfenced
The diff looks OK but is wrong when: text from a pull request, a comment or a model reaches a prompt outside an `untrusted-pr-content` block, a file path is written outside the blocks as anything but a JSON string, or model text is logged without `quoted`.
Reviewer memory: pull request and comment text goes inside `untrusted-pr-content` blocks, with nested tags defused. The curator fences feedback, skills and diffs between random markers, and logs model text only through `quoted` (`agents/curator/src/log-text.ts`), so it cannot start a line or pass for a `[maintenance]` report line.
Skip unless: the diff touches `renderPrOverview`, `mentionBlock`, `webhook/src/mention.ts`, the curator's first message, or a log line that prints text from GitHub or a model.

### Safety gate or state marker that fails open
The diff looks OK but is wrong when: `createSafetyGate` lets an error, a timeout or an unparsable verdict through as an allow, or the state comment can be found or forged without the App id check.
Reviewer memory: `createSafetyGate` denies on any error, timeout or unparsable verdict; a change that lets an error through as an allow is blocking. `findStateComment` checks the App id as well as `STATE_MARKER`, and `stripStateMarker` keeps model text from forging the marker.
Skip unless: the diff touches `createSafetyGate`, `findStateComment`, `stripStateMarker` or `STATE_MARKER`.

### Receiver gate taken without give-back
The diff looks OK but is wrong when: a new early return in `pullRequest` skips giving back what it took, which leaks a round or a pending marker, or the gates change order.
Reviewer memory: gate order matters: claim the idempotency key, take the pending marker (`markReviewPending`), take a round (`takeAutoReview`), then a budget slot (`takeReviewSlot`). A review that is not queued gives back what it took, newest first.
Skip unless: the diff touches `webhook/src/delivery.ts` or `webhook/src/store.ts`.

### Heartbeat or timeout tuning changed alone
The diff looks OK but is wrong when: `heartbeatRunKey` and the run key in `agents/common/src/run-agent.ts` stop producing the same string, `isFresh` is relaxed, or one of the tuned timeouts changes without the others.
Reviewer memory: `isFresh` and `CLOCK_SKEW_MS` exist because pull request code can write heartbeat records; a record counts as live only when a run could have written it. Lambda timeouts, the 16 minute visibility timeout, `RUN_BUDGET_MINUTES` and `HEARTBEAT_STALE_MINUTES` are tuned together (`docs/architecture.md`, section 3); changing one changes how often a long review is received before it dead-letters.
Skip unless: the diff touches `webhook/src/invoker.ts`, `webhook/src/watchdog.ts`, `webhook/src/review-envelope.ts`, `agents/common/src/run-agent.ts` or a timeout setting.

### Skill lifecycle write that loses or forges state
The diff looks OK but is wrong when: suppressed blocks are not kept byte for byte, code deprecates a registry record to "clean up", a maintenance write drops its conditions, or the skill size limits stop fitting together.
Reviewer memory: only the release check writes suppression markers, `parseSuppressed` decides what is well formed, and `submit_skill` must refuse text that adds, drops or changes a block. `DEPRECATED` is final in AWS Agent Registry: `upsertSkill` throws `SkillRetiredError` and changes nothing, so a deprecated record is lost for good. Maintenance writes are conditioned on the claim (`maintenance_id`) and on `graduated_record_name`; a write without the condition can act on a stale or forged message. Graduated skills load within `GRADUATED_SKILLS_MAX_CHARS`, and `submit_skill` accepts at most `GRADUATED_SKILL_MAX_CHARS`, half of it, so every skill fits.
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
Reviewer memory: the docs cite code names and numbers: `docs/architecture.md`, `infra/README.md`, `webhook/README.md`, `SECURITY.md` and `README.md`. The prompt tests pin text: the quoted first-message section names, the reply kinds, the shared "Mention-triggered reviews" section across reviewer prompts, the superseded-pieces paragraph, the tool tables, and no em dashes in prompts and skills.
Skip unless: the diff changes a default, a limit, a permission, a flow, a doc, or `agents/*/config/*.md`.
