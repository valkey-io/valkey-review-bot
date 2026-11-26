# valkey-admin PR reviewer skill

Institutional memory for reviewing valkey-io/valkey-admin pull requests: the security boundary of the server, contracts between the server, the collectors and the frontend that the code does not spell out, and what maintainers keep asking for. Generic TypeScript, React and Node knowledge is assumed. Where the code at the PR head disagrees with this file, the code wins: cite the code.

## Operating rules

- A pattern counts as evidence only after you confirm its "wrong when" condition in the diff, at a line you can cite. A matching "Skip unless" gate is a reason to look, not a finding.
- Confidence ladder: **high** = a cited source line plus a confirmed pattern, or a test that reproduces the failure; **medium** = a confirmed pattern at a cited line; **low** = a gate match or a suspicion without a confirmed condition. Post high and medium. Drop low.
- When a pattern's gate does not match the diff, skip it entirely. When several patterns apply, the one with the tighter gate wins. Do not pile on.
- The security patterns (WebSocket, sessions, credentials, collector auth, Electron, workflows) outrank everything else. Frontend convention findings are minor unless they cause a bug.
- Drop noise: formatting and lint (`eslint` runs in CI), renames, "consider refactoring", "add a test" without saying what it checks.

## Always-on checks

Run these regardless of diff shape. Each is one tool call; look for the exact string.

- DCO: every commit message needs a sign-off line.

  ```
  git ["log", "--format=%B", "<mergeBase>..<head>"]   -> each message contains "Signed-off-by:"
  ```

- Lifecycle scripts: a new `pre*`, `post*`, `prepare` or `install` script in any `package.json` is a security finding for maintainers to approve explicitly. The only existing one is the `pretest` in `apps/metrics`.

  ```
  git ["diff", "<mergeBase>..<head>", "--", "package.json", "*/package.json"]   -> added lines with "\"pre", "\"post", "\"prepare\"" or "\"install\"" as a key
  ```

- Workflows: a move to `pull_request_target`, an unpinned action, or a new write permission or secret in a job that checks out pull request code is a security finding.

  ```
  git ["diff", "<mergeBase>..<head>", "--", ".github/workflows/"]   -> added "pull_request_target", "uses: ...@v" or "permissions:" lines
  ```

## Do NOT flag

- `enableClusterSlotStats` and monitor start and stop not using `runWithRetry`: documented in `docs/adr/20260713-cluster-fan-out-retry-failed-nodes.md`.
- Monitor's `NodeReplyId` carrying both `clusterId` and `nodeId` in its cluster form: intended. The one-arm rule is for `AggregateReplyId`.
- The CPU, memory and stats (`setData`) replies keyed by `connectionId`: intended; only the aggregate replies use `AggregateReplyId`.
- `docker/Dockerfile.app` setting `SERVER_BIND_HOST=0.0.0.0`, and a standalone collector (the K8 sidecar or the `Dockerfile.metrics` image) binding `0.0.0.0` from `apps/metrics/src/index.js`: intended for containers.
- Existing type errors on `main`: report only errors the PR adds.
- `updateHashKey`, `updateListKey`, `updateSetKey`, `updateZSetKey` and `updateJsonKey` having no binary guard: existing state. Flag only a change that makes it worse (see "Binary values written back as text").

## Patterns

### WebSocket origin check loosened
The diff looks OK but is wrong when: a change accepts a missing `Origin`, compares the Electron token with `===`, or lets a loopback origin in without the token.
Reviewer memory: `isAllowedWebSocketOrigin` refuses an upgrade without an `Origin` header and accepts an origin listed in `VALKEY_ADMIN_ALLOWED_WS_ORIGINS` first, even in Electron mode. In Electron mode any other origin must look local (`null`, `file://` or an http(s) loopback URL) and the `token` query parameter must match `ELECTRON_WS_TOKEN` through `tokensMatch` (`timingSafeEqual`); with no token set the check fails closed. Outside Electron mode (Web, K8 or an unset `DEPLOYMENT_MODE`) a configured list is exclusive, and without one only an origin matching the `Host` header passes.
Skip unless: the diff touches `apps/server/src/websocket-origin.ts` or the upgrade handling in `apps/server/src/index.ts`.

### Action handler that skips connection ownership
The diff looks OK but is wrong when: a new or changed `ws.on("message")` action reads a connection or cluster from anything other than a checked `connectionId`, or takes neither id and does no scoping of its own.
Reviewer memory: every action except `connectPending` and `discoveryEndpointPending` (the `exempt` check) that carries a `connectionId` must have it accepted by `isConnectionAuthorized`; an action with a `clusterId` but no `connectionId` is rejected; an action with neither is not checked at all. A `clusterId` must be that connection's cluster (a db-less node id falls back to any client of that node, through `isNodeId` and `toNodeId`). Expect tests next to such changes in `apps/server/src/__tests__/session.test.ts`, `connection-id-ownership.test.ts` and `apps/server/src/__integration__/session-authorization.integration.test.ts`.
Skip unless: the diff adds or changes a WebSocket action, or touches `apps/server/src/session.ts`.

### Session authorizes the wrong connection
The diff looks OK but is wrong when: a handler calls `authorizeConnection` before the connect succeeds, or for a connection the request did not create.
Reviewer memory: `ensureSession` issues the `vk_sid` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` only behind https). `SESSION_TTL_MS` defaults to 24 hours. A session owns only the `connectionIds` that `authorizeConnection` added after a successful connect.
Skip unless: the diff touches `apps/server/src/session.ts` or the connect path in `apps/server/src/connection.ts`.

### Teardown of a connection another session owns
The diff looks OK but is wrong when: a change tears down a connection another session still owns, or keeps one alive for an expired session.
Reviewer memory: `teardownConnection` runs only when `getWatcherCount` is 0 and `hasAuthorizedSession` is false. Triggers: an explicit `closeConnection` (after `revokeConnection`), a session expiry, the delay after a watching socket closes, and an immediate sweep of unwatched, unowned connections whenever any socket closes. `CONNECTION_TEARDOWN_DELAY_MS` defaults to 10000.
Skip unless: the diff touches `teardownConnection`, `revokeConnection`, socket close handling or session expiry.

### Broadcast without the ownership filter
The diff looks OK but is wrong when: a new broadcast iterates `wss.clients` without checking `isConnectionAuthorized` per socket, which leaks one session's cluster data to another.
Reviewer memory: `refreshAllClusterRegistries` is the reference: it filters per socket and sends through `safeSend`.
Skip unless: the diff adds a loop over `wss.clients` or a new push to more than one socket.

### All-interfaces default outside K8
The diff looks OK but is wrong when: a new default makes the server or a spawned collector bind all interfaces outside K8, which exposes an unauthenticated server.
Reviewer memory: the server listens on `bindHost`: `SERVER_BIND_HOST`, else `0.0.0.0` under K8 and `127.0.0.1` otherwise. Collectors spawned by the orchestrator get `METRICS_BIND_HOST` by the same rule (`metrics-orchestrator.ts`). `docker/Dockerfile.server` does not set `SERVER_BIND_HOST`. `isWebMode`, `isKubernetes` and `isElectron` are read from `DEPLOYMENT_MODE` at import time, so tests set the mode before importing (`orchestrator-k8s-register.test.ts`).
Skip unless: the diff changes a bind host, a default of an environment variable, `docker/` or `examples/k8s/`.

### Electron bridge or navigation widened
The diff looks OK but is wrong when: a change exposes `ipcRenderer` itself, a generic IPC channel, file or process access, or a handler that takes a path or URL from the renderer; or lets text from Valkey or a connection form reach `shell.openExternal` with a scheme other than `http:` or `https:`.
Reviewer memory: the renderer runs with `nodeIntegration: false` and `contextIsolation: true`, and `contextBridge.exposeInMainWorld` exposes only `valkeyAdminRuntime`, `secureStorage` and `electronNavigation`. `setWindowOpenHandler` hands every new-window URL to `shell.openExternal`. When `app.isPackaged`, `startServer` forks the bundled server from `process.resourcesPath` with `DEPLOYMENT_MODE` `Electron` and a per-launch `ELECTRON_WS_TOKEN`, which reaches the renderer through `additionalArguments` and `preload.js`; unpackaged, the window loads `http://localhost:5173` and opens DevTools.
Skip unless: the diff touches `apps/frontend/electron.main.js` or `apps/frontend/preload.js`.

### Content-Security-Policy changed in one place
The diff looks OK but is wrong when: a change to what the UI loads or connects to updates one policy and not the others.
Reviewer memory: the policy is set in three places: `helmet` in `apps/server/src/index.ts` (web build), `onHeadersReceived` in `apps/frontend/electron.main.js` (app), and a `<meta http-equiv="Content-Security-Policy">` tag in `apps/frontend/index.html` (both builds).
Skip unless: the diff touches any of those three, or adds an external origin the UI loads or connects to.

### Password persisted without a keystore
The diff looks OK but is wrong when: a fallback stores the plaintext password or a base64 of it, or code sends the result of a failed decrypt to Valkey as a password.
Reviewer memory: `encryptForStorage` returns `{ ok: false }` when there is no bridge or no keystore (`secure-storage:encrypt` fails closed); the caller keeps the password in memory for the live connection, does not persist it, and shows `PASSWORD_NOT_STORED_WARNING` in Electron only. Web never persists a real password. `secure-storage:decrypt` returns its input when decryption fails. `purgeUnencryptedPasswords` runs once at startup (`store.ts`) and, only in Electron on a host with no OS keystore, removes cleartext passwords older builds saved, from state (`stripUnencryptedPasswords`) and from `LOCAL_STORAGE.VALKEY_CONNECTIONS`.
Skip unless: the diff touches `apps/frontend/src/utils/secureStorage.ts`, the connection slice or forms, or `apps/frontend/src/state/purgeUnencryptedPasswords.ts`.

### Credentials leaking to logs or child processes
The diff looks OK but is wrong when: a change logs the child environment, a `ConnectionDetails` object or a connection string, or moves the collector key before the `...process.env` spread.
Reviewer memory: `startMetricsServer` hands each collector its node's credentials in `VALKEY_USERNAME` and `VALKEY_PASSWORD`, and its own key in `ORCHESTRATOR_AUTH_KEY_ENV` (`ORCHESTRATOR_KEY`), set after the spread so the orchestrator's own key never reaches a child. Collector stdout is ignored and stderr is logged. IAM tokens are credentials too: `authType` is `password`, `iam` (ElastiCache, `ServiceType.Elasticache` with a region and replication group) or `gcp-iam` (`mintGcpAccessToken`, refreshed by `registerGcpTokenRefresh`).
Skip unless: the diff touches `startMetricsServer`, connection code in `apps/server/src/connection.ts`, or a log line near connection details.

### Collector credential accepted too broadly
The diff looks OK but is wrong when: a collector key outlives its `metricsServerMap` entry, one node's key is accepted for another, `handleRegister` changes state before verifying, or a loosened registration check changes where the server sends requests.
Reviewer memory: `POST /orchestrator/register` and `POST /orchestrator/ping` check the `ORCHESTRATOR_AUTH_HEADER` credential with `verifyOrchestratorAuthCredential` against `resolveCollectorKey(nodeId)`, each under its own `ORCHESTRATOR_AUTH_DOMAIN` so a registration credential cannot be replayed as a ping. `ORCHESTRATOR_AUTH_WINDOW_ENV` defaults to `ORCHESTRATOR_AUTH_DEFAULT_WINDOW_MS`, 60 seconds. A spawned collector's key comes from `generateOrchestratorAuthKey` and lives in `collectorKeys` for its node only; `forgetCollectorKey` runs wherever a single `metricsServerMap` entry is deleted (`stopMetricsServer`, the metrics close path in `connection.ts`), and `stopAllMetricsServers` clears `collectorKeys` with the map. Only K8 falls back to the shared key. The credential covers the `metricsServerUri` the collector advertises, which `isUsableMetricsUri` and `isPinnedMetricsHost` limit. Registration is accepted only for a node with a `metricsServerMap` entry, or, in K8, a node of a discovered cluster. `/orchestrator/*` has its own rate limit (`orchestratorLimiter`) because every collector calls from the same address; `ORCHESTRATOR_RATE_LIMIT_MAX_ENV` defaults to `ORCHESTRATOR_RATE_LIMIT_DEFAULT_MAX`.
Skip unless: the diff touches `apps/server/src/metrics-orchestrator.ts`, `common/src/orchestrator-auth.ts`, `apps/metrics/src/utils/orchestrator-auth.js` or `apps/metrics/src/index.js`.

### Send Command bypassing the blocked list
The diff looks OK but is wrong when: the server checks one parse and sends another, a new feature sends user text to `customCommand` without `findBlockedCommand`, or a new command that changes connection state is not blocked.
Reviewer memory: `BLOCKED_COMMANDS` are refused by the server (`findBlockedCommand` in `sendRequested`) and the UI; `CONFIRM_COMMANDS` only ask the user (`CommandConfirmDialog`). `matchesRestriction` compares the leading tokens upper-cased. `SELECT`, `AUTH`, `HELLO`, `RESET` and `QUIT` are blocked because every Send Command call runs on the shared connection the rest of the app uses; protocol, database, name, auth and `CLIENT` settings changes belong there too. `sendValkeyRunCommand` runs `customCommand` on exactly what `parseCommandArgs` returns. Both lists are documented in a table in `docs-site/src/content/docs/features/send-command.md`, which changes with them.
Skip unless: the diff touches `common/src/command-restrictions.ts`, `apps/server/src/actions/command.ts`, `apps/server/src/send-command.ts` or `apps/frontend/src/components/send-command/`.

### Ids built or mixed by hand
The diff looks OK but is wrong when: an id is built with a template string instead of `buildConnectionId`, a db suffix leaks into a metrics key, or an `AggregateReplyId` reply sets both `clusterId` and `nodeId`.
Reviewer memory: `buildConnectionId(host, port, db)` is `sanitizeUrl` of host-port plus `-db<N>`; `toNodeId` strips only a trailing `-db<digits>` and is idempotent; `isNodeId` tells a node id from a connection id. `clients` is keyed by connection id; `metricsServerMap` and `collectorKeys` by node id. The config, hotkeys, commandlogs and bigkeys replies carry exactly one arm of `AggregateReplyId` (`{ clusterId }` or `{ nodeId }`) and no `{ connectionId }`; their slices key state by `targetId`, which is `clusterId ?? nodeId`. Monitor replies carry a `NodeReplyId`, and the monitor slice keys state per node by `nodeId`. A standalone config reply (`NodeResultsReply`) holds at most one `NodeResult`, whose `nodeId` is the reply's; a node that was not attempted leaves `nodeResults` empty and is listed in `notAttemptedNodeIds`.
Skip unless: the diff touches `common/src/connection-id.ts`, `common/src/reply-id.ts`, the metrics actions in `apps/server/src/actions/`, or slices and selectors keyed by an id.

### Non-idempotent work through the retry runner
The diff looks OK but is wrong when: an operation that appends, increments or toggles goes through `runWithRetry`, or a superseded config session's results still drive a reply or a monitor toggle.
Reviewer memory: `runNodeAttempt` is one bounded attempt that never rejects (`PER_NODE_TIMEOUT_MS`, 5000), and a timed-out attempt can still land, so everything run through `runWithRetry` must be safe to repeat. `runWithRetry` retries failed nodes and reports each node transition through a required callback; it waits `retryDelay` (Fibonacci, capped at 30 seconds) between tries, and `DEFAULT_RETRY_MAX_RETRIES` defaults to 6. A caller can pass `maxRetries` and `delaysMs`; the config feature does so from `CONFIG_RETRY_MAX_RETRIES` and `CONFIG_RETRY_DELAYS_MS`. Scheduling policy stays out of `node-fanout.ts`. `config.ts` keeps one session per target id: a new `updateConfig` for the same target aborts the one in flight, whose aggregate reply is suppressed and whose monitor rider is skipped, and `abortConfigSessionsForSocket` runs when the socket closes. The aggregate `NodeResultsReply` has `outcome` `fulfilled`, `failed` or `not_attempted`; `not_attempted` nodes (no registered collector) are never retried or counted as failures. On the wire it uses `updateConfigFulfilled` (for `fulfilled`) and `updateConfigFailed` (for `failed` and `not_attempted`), and each node transition is pushed live as `updateConfigNodeStatus`.
Skip unless: the diff touches `apps/server/src/actions/config.ts`, `node-fanout.ts`, `retry-runner.ts`, `monitorAction.ts` or `common/src/node-results.ts`.

### Binary values written back as text
The diff looks OK but is wrong when: an edit writes back fields or elements that were decoded to text, which corrupts binary ones it did not touch, or an add path can overwrite an existing key.
Reviewer memory: string values are read with `Decoder.Bytes` and checked with a strict UTF-8 decode (`decodeToStringValue`), so binary strings are escaped and flagged `isBinary`; hash, set, list, zset, stream and JSON elements use the default text decoder and get no binary detection. Only `updateStringKey` has a binary guard. String and JSON adds use `NX`, so they never overwrite an existing key; maintainers ask for add paths to stay protected.
Skip unless: the diff touches `apps/server/src/keys-browser.ts`, `apps/server/src/actions/keys.ts` or `apps/frontend/src/components/key-browser/`.

### Keyspace walked without SCAN
The diff looks OK but is wrong when: a new feature walks the keyspace with `KEYS` or an unbounded loop on the request path.
Reviewer memory: scans go through `buildScanCommandArgs` (`SCAN` with `MATCH` and `COUNT`); `KEYS` is a confirm command because it blocks the server. JSON keys need the JSON module, which `checkJsonModuleAvailability` probes with a fallback for servers that restrict `COMMAND`.
Skip unless: the diff adds a keyspace walk or touches `apps/server/src/keys-browser.ts`.

### Frontend data flow outside epics
The diff looks OK but is wrong when: a component fetches or chains actions in `useEffect`, calls `useSelector` with an anonymous selector, or holds transport or Valkey details. These are minor findings unless they cause a bug.
Reviewer memory: data flows component, intent action, epic (`apps/frontend/src/state/epics/`), slice, named selector (`CONTRIBUTING.md`, `.agents/skills/rx-js/SKILL.md`). Colors come from the semantic tokens in `apps/frontend/src/css/index.css`, classes compose with `cn`, and a new token gets light and dark values; raw Tailwind palette classes are flagged. Maintainers ask to reuse the components in `apps/frontend/src/components/ui/` (for example `Badge`), to inline a component or helper used once, and to keep a value's `undefined` and `null` meanings apart.
Skip unless: the diff touches `apps/frontend/src/`.

### Dependency missing from the desktop package
The diff looks OK but is wrong when: a new native or externalized dependency of the server or collector has no `extraResources` entry, so the desktop app fails while the web build works; or a version bump changes the root `version` without `common/src/version.ts`.
Reviewer memory: the root `package.json` lists the workspaces (`common`, `apps/frontend`, `apps/server`, `apps/metrics`), and the root `package-lock.json` is what the app workflows and Docker images install (`npm ci`); the docs site builds from `docs-site/package-lock.json`. Its `build` section configures electron-builder: `extraResources` copies the server and collector bundles that `npm run build:electron` writes, the collector's `config.yml` and the GLIDE platform packages. `common/scripts/sync-version.mjs` writes `common/src/version.ts` from the root `version`.
Skip unless: the diff touches a `package.json`, a lockfile, `docker/`, `mac_build/` or `linux_build/`.

### Workflow permissions widened
The diff looks OK but is wrong when: a job that checks out pull request code gains a write permission or a secret, or labeling moves off its two-workflow split.
Reviewer memory: pull request workflows run on `pull_request`, and labeling uses `labeler.yml` then `labeler-apply.yml` on `workflow_run` to avoid `pull_request_target`. Write permissions belong only to the labeling, reviewer assignment, CodeQL (`security-events`), docs site (`pages`, `id-token`), release and image jobs. Actions are pinned by commit SHA.
Skip unless: the diff touches `.github/workflows/`.

### Behavior change without docs
The diff looks OK but is wrong when: a new or renamed environment variable has no heading of its own (with its default and where it is read) on the matching page under `docs-site/src/content/docs/configuration/` (`server.md`, `metrics.md`, `frontend.md`, `shared.md`), or a change reverses a decision in `docs/adr/` without saying so.
Reviewer memory: `AGENTS.md` asks for docs in the same change: `README.md`, `TROUBLESHOOTING.md`, `CONTRIBUTING.md`, and `docs-site/src/content/docs/` (`configuration/`, `deployment/`, `features/`, `reference/`). The PR template asks for a description and a screenshot or video of before and after.
Skip unless: the PR changes behavior a user or operator sees, or adds an environment variable.
