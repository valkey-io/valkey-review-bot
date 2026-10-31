import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Octokit } from '@octokit/rest';

/**
 * GitHub credentials for one review run.
 *
 * The runtime never holds the GitHub App private key. It asks the token
 * broker (webhook/src/token-broker.ts) for an installation token limited
 * to the repository under review, and asks again shortly before that
 * token expires, so runs longer than the one-hour token lifetime keep
 * working.
 */

export interface TokenSource {
  /** A token valid for at least the next few minutes. */
  get(): Promise<string>;
}

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

/**
 * Bound on one call to the token broker. The broker's own timeout is 15
 * seconds (infra/lib/substrate-stack.ts); this covers that and a cold
 * start. The SDK sets no timeout of its own, and every GitHub request
 * waits on this call when the token is due.
 */
const BROKER_INVOKE_TIMEOUT_MS = 30_000;

/**
 * Bound on one GitHub request. GitHub ends an API request that takes it
 * more than 10 seconds, and gh_api_read gives a whole `gh api` call 30;
 * fetch sets no timeout of its own.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export function createTokenSource(opts: {
  brokerFunction: string;
  region: string;
  installationId: number;
  repo: string;
}): TokenSource {
  const lambda = new LambdaClient({
    region: opts.region,
    requestHandler: {
      connectionTimeout: BROKER_INVOKE_TIMEOUT_MS,
      requestTimeout: BROKER_INVOKE_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
  let current: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: opts.brokerFunction,
      Payload: Buffer.from(JSON.stringify({ installation_id: opts.installationId, repo: opts.repo })),
    }));
    if (resp.FunctionError) throw new Error(`token broker failed (${resp.FunctionError})`);
    const out = JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString('utf8')) as
      { token?: string; expires_at?: string; error?: string };
    if (!out.token || !out.expires_at) throw new Error(`token broker refused: ${out.error ?? 'no token returned'}`);
    current = { token: out.token, expiresAt: new Date(out.expires_at).getTime() };
    return out.token;
  }

  return {
    async get(): Promise<string> {
      if (current && current.expiresAt - Date.now() > REFRESH_BEFORE_EXPIRY_MS) return current.token;
      // One refresh at a time; concurrent callers share it.
      pending ??= fetchToken().finally(() => { pending = null; });
      return pending;
    },
  };
}

/** Statuses whose response has no body; a Response built with one throws. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * fetch that gives up after `timeoutMs`, as well as on the caller's own
 * signal. The bound covers the body too: it is read here, so a body cut
 * off by the bound or by a dropped connection fails the request.
 * @octokit/request would report a body it could not read as an empty
 * success, and a paginated listing would then skip that page.
 */
export function boundedFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const resp = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    const body = resp.body === null || NULL_BODY_STATUSES.has(resp.status) ? null : await resp.arrayBuffer();
    const buffered = new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    // Octokit reports the URL, and pagination reads it.
    Object.defineProperty(buffered, 'url', { value: resp.url });
    return buffered;
  };
}

/** Octokit that attaches a current token to every request and bounds each one. */
export function createOctokit(tokens: TokenSource, timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS): Octokit {
  const octokit = new Octokit({ request: { fetch: boundedFetch(timeoutMs) } });
  octokit.hook.before('request', async (options) => {
    options.headers.authorization = `token ${await tokens.get()}`;
  });
  return octokit;
}
