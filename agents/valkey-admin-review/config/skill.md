# valkey-admin reviewer skill

Repository knowledge for reviewing valkey-io/valkey-admin pull requests. The repository hazards in the system prompt come first; this adds the patterns behind them, each with the condition that makes it apply. Facts here were checked against `main`. Where the code at the PR head disagrees, the code wins: cite the code, not this file.

## WebSocket origin, sessions and connection ownership

Skip unless the PR touches `apps/server/src/index.ts`, `apps/server/src/websocket-origin.ts`, `apps/server/src/session.ts`, or adds a WebSocket action.

- `isAllowedWebSocketOrigin` refuses an upgrade without an `Origin` header. An origin listed in `VALKEY_ADMIN_ALLOWED_WS_ORIGINS` is accepted. In Electron mode the origin must look local (`null`, `file://` or a loopback URL) and the `token` query parameter must match `ELECTRON_WS_TOKEN` through `tokensMatch` (`timingSafeEqual`); with no token set the check fails closed. In Web mode a configured list is exclusive; without one, only the same origin as the `Host` header passes. Wrong when a change accepts a missing origin, compares tokens with `===`, or lets a loopback origin in without the token.
- `ensureSession` issues the `vk_sid` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` only behind https, `SESSION_TTL_MS` of 24 hours). A session owns the `connectionIds` that `authorizeConnection` added after a successful connect. Wrong when a handler authorizes a connection before the connect succeeds, or for a connection the request did not create.
- In the `ws.on("message")` handler, every action except `connectPending` and `discoveryEndpointPending` (the `exempt` check) must name a `connectionId` that `isConnectionAuthorized` accepts, and a `clusterId` must be that connection's cluster (a db-less node id falls back to any client of that node, through `isNodeId` and `toNodeId`). A handler that reads a connection or cluster from somewhere other than the checked `connectionId` skips this.
- A connection is torn down (`teardownConnection`) only when `getWatcherCount` is 0 and `hasAuthorizedSession` is false: when a session expires, or `CONNECTION_TEARDOWN_DELAY_MS` after its last socket closes. Wrong when a change tears down a connection another session still owns, or keeps one alive for an expired session.
- Broadcasts go only to sockets whose session owns one of the target's connections: `refreshAllClusterRegistries` checks `isConnectionAuthorized` per socket, and `safeSend` is the send helper. A new broadcast over `wss.clients` without that filter leaks one session's cluster data to another.
- Tests to expect next to such changes: `apps/server/src/__tests__/session.test.ts`, `websocket-origin.test.ts`, `connection-id-ownership.test.ts`, and `apps/server/src/__integration__/session-authorization.integration.test.ts`.

## Deployment modes, bind hosts and the Electron shell

Skip unless the PR touches `apps/frontend/electron.main.js`, `apps/frontend/preload.js`, `apps/server/src/metrics-orchestrator.ts`, a default of an environment variable, `docker/` or `examples/k8s/`.

- The server listens on `bindHost`: `SERVER_BIND_HOST`, else `0.0.0.0` under K8 and `127.0.0.1` otherwise. Collectors get `METRICS_BIND_HOST` with the same rule. The Docker images set `SERVER_BIND_HOST=0.0.0.0` on purpose. A new default that binds all interfaces outside K8 exposes an unauthenticated server.
- `isWebMode`, `isKubernetes` and `isElectron` come from `DEPLOYMENT_MODE` at import time. Tests that need a mode set it before importing (`orchestrator-k8s-register.test.ts`).
- Electron: `startServer` forks the bundled server from `process.resourcesPath` only when `app.isPackaged`, with `DEPLOYMENT_MODE` `Electron` and the per-launch `ELECTRON_WS_TOKEN`; the token reaches the renderer through `additionalArguments` and `preload.js`. Unpackaged, the window loads `http://localhost:5173` and opens DevTools.
- The renderer runs with `nodeIntegration: false` and `contextIsolation: true`. `contextBridge.exposeInMainWorld` exposes only `valkeyAdminRuntime`, `secureStorage` and `electronNavigation`. Wrong when a change exposes `ipcRenderer` itself, a generic IPC channel, file or process access, or a handler that takes a path or URL from the renderer. `setWindowOpenHandler` hands every new-window URL to `shell.openExternal`. A change that lets text from Valkey or a connection form reach that path should keep it to `http:` and `https:` links.
- The Content-Security-Policy is set twice: by `helmet` in `apps/server/src/index.ts` for the web build and in `onHeadersReceived` in `electron.main.js` for the app. A change to what the UI loads or connects to needs both.

## Credentials and their storage

Skip unless the PR touches `apps/frontend/src/utils/secureStorage.ts`, the connection slice or forms, `apps/frontend/src/state/purgeUnencryptedPasswords.ts`, connection code in `apps/server/src/connection.ts`, `startMetricsServer`, or a log line near connection details.

- `encryptForStorage` returns `{ ok: false }` when there is no bridge or no keystore (`secure-storage:encrypt` fails closed). The caller keeps the password in memory for the live connection, does not persist it, and shows `PASSWORD_NOT_STORED_WARNING` in Electron only. Web never persists a real password. Wrong when a fallback stores the plaintext or a base64 of it.
- `purgeUnencryptedPasswords` removes cleartext passwords that older builds saved, from state (`stripUnencryptedPasswords`) and from `LOCAL_STORAGE.VALKEY_CONNECTIONS`.
- `secure-storage:decrypt` returns its input when decryption fails. Code that treats the result as a password must not send ciphertext to Valkey as one.
- `startMetricsServer` hands each collector its node's credentials in `VALKEY_USERNAME` and `VALKEY_PASSWORD`, and its own key in `ORCHESTRATOR_AUTH_KEY_ENV` (`ORCHESTRATOR_KEY`), set after the `...process.env` spread so the orchestrator's own key never reaches a child. Collector stdout is ignored and stderr is logged. Wrong when a change logs the child environment, a `ConnectionDetails` object or a connection string, or moves the key before the spread.
- IAM: `authType` is `password`, `iam` (ElastiCache, `ServiceType.Elasticache` with a region and replication group) or `gcp-iam` (`mintGcpAccessToken`, refreshed by `registerGcpTokenRefresh`). Tokens are credentials too.

## Collector registration and orchestrator auth

Skip unless the PR touches `apps/server/src/metrics-orchestrator.ts`, `common/src/orchestrator-auth.ts`, `apps/metrics/src/utils/orchestrator-auth.js` or `apps/metrics/src/index.js`.

- `POST /orchestrator/register` and `POST /orchestrator/ping` check the `ORCHESTRATOR_AUTH_HEADER` credential with `verifyOrchestratorAuthCredential` against `resolveCollectorKey(nodeId)`, each under its own `ORCHESTRATOR_AUTH_DOMAIN` so a registration credential cannot be replayed as a ping, inside `ORCHESTRATOR_AUTH_WINDOW_ENV` (default `ORCHESTRATOR_AUTH_DEFAULT_WINDOW_MS`, 60 seconds).
- A spawned collector's key comes from `generateOrchestratorAuthKey` and lives in `collectorKeys` for its node only; `forgetCollectorKey` runs wherever a `metricsServerMap` entry is removed. Only K8 falls back to the shared key. Wrong when a key outlives its entry, or one node's key is accepted for another.
- `handleRegister` verifies before it changes anything. The credential covers the `metricsServerUri` the collector advertises, which the server then calls, and `isUsableMetricsUri` and `isPinnedMetricsHost` limit where it may point. Registration is accepted only for a node with a `metricsServerMap` entry, or, in K8, a node of a discovered cluster. A check that loosens who may register also changes where the server sends requests.
- `/orchestrator/*` has its own rate limit (`orchestratorLimiter`, `ORCHESTRATOR_RATE_LIMIT_MAX_ENV`, default `ORCHESTRATOR_RATE_LIMIT_DEFAULT_MAX`) because every collector calls from the same address.

## Send Command restrictions

Skip unless the PR touches `common/src/command-restrictions.ts`, `apps/server/src/actions/command.ts`, `apps/server/src/send-command.ts` or `apps/frontend/src/components/send-command/`.

- `BLOCKED_COMMANDS` are refused by the server (`findBlockedCommand` in `sendRequested`) and the UI; `CONFIRM_COMMANDS` only ask the user in the UI (`CommandConfirmDialog`). `matchesRestriction` compares the leading tokens upper-cased, so arguments after the pattern do not matter.
- `SELECT`, `AUTH`, `HELLO`, `RESET` and `QUIT` are blocked because every Send Command call runs on the shared connection the rest of the app uses. A new command that changes connection state (protocol, database, name, auth, `CLIENT` settings) belongs there too.
- `sendValkeyRunCommand` runs `customCommand` on exactly what `parseCommandArgs` returns. Wrong when the server checks one parse and sends another, or a new feature sends user text to `customCommand` without `findBlockedCommand`.
- The blocked and confirmed commands are listed in a table in `docs-site/src/content/docs/features/send-command.md`; a change to either list updates it.

## Id spaces and reply shapes

Skip unless the PR touches `common/src/connection-id.ts`, `common/src/reply-id.ts`, the metrics actions in `apps/server/src/actions/`, or slices and selectors keyed by an id.

- `buildConnectionId(host, port, db)` is `sanitizeUrl` of host-port plus `-db<N>`; `toNodeId` strips only a trailing `-db<digits>` and is idempotent; `isNodeId` tells a node id from a connection id. `clients` is keyed by connection id; `metricsServerMap` and `collectorKeys` by node id.
- Metrics replies carry exactly one arm of `AggregateReplyId` (`{ clusterId }` or `{ nodeId }`) or `NodeReplyId` for monitor; none carries `{ connectionId }`. The frontend keys that state by `targetId`, which is `clusterId ?? nodeId`. A standalone reply holds one `NodeResult` whose `nodeId` is the reply's.
- Wrong when an id is built with a template string instead of `buildConnectionId`, a db suffix leaks into a metrics key, or a reply sets both arms.

## Cluster fan-out and retries

Skip unless the PR touches `apps/server/src/actions/config.ts`, `node-fanout.ts`, `retry-runner.ts`, `monitorAction.ts` or `common/src/node-results.ts`.

- `runNodeAttempt` is one bounded attempt (`PER_NODE_TIMEOUT_MS`, 5000) that never rejects; `toOutcome` classifies; `runWithRetry` retries with `retryDelay` (Fibonacci) up to `DEFAULT_RETRY_MAX_RETRIES` and reports each node transition through a required callback. Keep scheduling policy out of `node-fanout.ts`.
- A timed-out attempt can still land, so every operation run through `runWithRetry` must be safe to repeat. Wrong when a non-idempotent operation (one that appends, increments or toggles) goes through it.
- `config.ts` keeps one session per target id. A new `updateConfig` for the same target aborts the one in flight, whose aggregate reply is suppressed and whose monitor rider is skipped. `abortConfigSessionsForSocket` runs when the socket closes. Wrong when a superseded session's results still drive a reply or a monitor toggle.
- The aggregate `NodeResultsReply` has `outcome` `fulfilled`, `failed` or `not_attempted`; `not_attempted` nodes (no registered collector) are never retried or counted as failures. On the wire only `updateConfigFulfilled` and `updateConfigFailed` exist.
- `enableClusterSlotStats` and monitor start and stop do not use `runWithRetry` (`docs/adr/20260713-cluster-fan-out-retry-failed-nodes.md`). That is the documented state, not a regression.

## Key browser and binary values

Skip unless the PR touches `apps/server/src/keys-browser.ts`, `apps/server/src/actions/keys.ts` or `apps/frontend/src/components/key-browser/`.

- Values are read with `Decoder.Bytes` so binary data is detected rather than mangled. `updateStringKey` refuses to overwrite a binary value, and string and JSON adds use `NX` so an existing key is never replaced. Maintainers ask for the same guard on every update path: an edit that writes back fields or elements decoded to text can corrupt binary ones it did not touch.
- Scans go through `buildScanCommandArgs` (`SCAN` with `MATCH` and `COUNT`). `KEYS` is a confirm command because it blocks the server. Wrong when a new feature walks the keyspace with `KEYS` or an unbounded loop on the request path.
- JSON keys need the JSON module; `checkJsonModuleAvailability` probes it with a fallback for servers that restrict `COMMAND`.

## Frontend conventions

Skip unless the PR touches `apps/frontend/src/`.

- Data flow is component, intent action, epic (`apps/frontend/src/state/epics/`), slice, named selector. Maintainers flag `useEffect` that fetches or chains actions, anonymous `useSelector` calls, and transport or Valkey details inside components (`CONTRIBUTING.md`, `.agents/skills/rx-js/SKILL.md`). These are minor findings unless they cause a bug.
- Colors come from the semantic tokens in `apps/frontend/src/css/index.css`, classes compose with `cn`, and a new token gets light and dark values. Raw Tailwind palette classes are flagged.
- Maintainers ask to reuse the components in `apps/frontend/src/components/ui/` (for example `Badge`), to inline a component or helper used once, and to keep a value's `undefined` and `null` meanings apart.

## Packaging, dependencies and workflows

Skip unless the PR touches a `package.json`, a lockfile, `docker/`, `.github/workflows/`, `mac_build/` or `linux_build/`.

- The root `package.json` lists the workspaces (`common`, `apps/frontend`, `apps/server`, `apps/metrics`) and the root `package-lock.json` is what CI installs. Its `build` section configures electron-builder: `extraResources` copies the server and collector bundles that `npm run build:electron` writes, the collector's `config.yml`, and the GLIDE platform packages into the app's resources. A new native or externalized dependency of the server or collector needs an entry there, or the desktop app fails while the web build works.
- `apps/metrics` has the repository's only lifecycle script, a `pretest` that builds `common`. Any new `pre*`, `post*`, `prepare` or `install` script, in any `package.json`, is a security finding for maintainers to approve explicitly.
- `common/scripts/sync-version.mjs` writes `common/src/version.ts` from the root `version`, so a version bump changes both.
- Pull request workflows run on `pull_request`, and labeling uses two workflows (`labeler.yml`, then `labeler-apply.yml` on `workflow_run`) to avoid `pull_request_target`. Write permissions belong to the labeling, reviewer assignment, release and image jobs only. Actions are pinned by commit SHA. A move to `pull_request_target`, a new write permission or secret in a job that checks out pull request code, or an unpinned action is a security finding.

## Docs and hygiene

Skip unless the PR changes behavior a user or operator sees.

- `AGENTS.md` asks for docs in the same change: `README.md`, `TROUBLESHOOTING.md`, `CONTRIBUTING.md`, and `docs-site/src/content/docs/` (`configuration/`, `deployment/`, `features/`, `reference/`). A new or renamed environment variable without its row in `docs-site/src/content/docs/configuration/` is a finding.
- Architecture decisions live in `docs/adr/`. A change that reverses one should say so.
- Commits on `main` carry a DCO `Signed-off-by` line. The PR template asks for a description and a screenshot or video of before and after.
