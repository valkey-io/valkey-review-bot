import { fetchAppSlug, fetchRepoInstallation, type GitHubApi } from './github.js';
import { grantKey, type ResolveGrant } from './resolve-grant.js';

/**
 * The thread resolver's checks. src/thread-resolver.ts wires them to the
 * App key in Secrets Manager and to the receiver's table.
 *
 * A review resolves its own review threads once their findings are
 * fixed. GitHub lets only a token with contents: write resolve a thread,
 * and code from the pull request under review can read the runtime's
 * tokens, so this function resolves them and never returns the token.
 *
 * Code from the pull request can also call this function. So the caller
 * names only threads: the repository, the pull request and the
 * installation come from the grant the queue worker writes for the run,
 * under a random value only that run is given (src/invoker.ts). A run
 * can then resolve threads only on the pull request it reviews, whose
 * author can already resolve every conversation on it. That code could
 * also have made the App post on another pull request, a forged state
 * comment included, which that pull request's own run would then read.
 * So only threads in which every comment is the App's or the pull
 * request author's are resolved: a person's reply stays in view.
 */

/** What resolving a review thread takes. The token never leaves this function. */
export const RESOLVE_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const;

/** Thread ids one call may name; one GraphQL `nodes` read takes 100. */
export const MAX_THREADS_PER_CALL = 50;

export interface ResolveRequest {
  readonly installationId: number;
  readonly repositoryNames: string[];
  readonly permissions: typeof RESOLVE_PERMISSIONS;
}

export interface ThreadResolverEvent {
  readonly grant?: unknown;
  readonly thread_ids?: unknown;
}

export type ThreadResolverResult = { resolved: string[] } | { error: string };

export interface ThreadResolverDeps {
  /** The grant stored under `key`, or undefined. */
  readonly readGrant: (key: string) => Promise<ResolveGrant | undefined>;
  /** GitHub REST authenticated as the App itself (JWT). */
  readonly appApi: () => Promise<GitHubApi>;
  /** An installation token, as @octokit/auth-app returns it. */
  readonly issueToken: (request: ResolveRequest) => Promise<{ token: string; expiresAt: string }>;
  /** GitHub as an installation token this function keeps. */
  readonly installationApi: (token: string) => GitHubApi;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

const THREADS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequestReviewThread {
      id
      isResolved
      pullRequest { number state author { login } repository { nameWithOwner } }
      comments(first: 100) { totalCount nodes { author { __typename login } } }
    }
  }
}`;

/** One mutation that resolves `count` threads, given as $t0, $t1, ... */
function resolveMutation(count: number): string {
  const ids = Array.from({ length: count }, (_, i) => `t${i}`);
  return `mutation(${ids.map((t) => `$${t}: ID!`).join(', ')}) {\n${
    ids.map((t) => `  ${t}: resolveReviewThread(input: { threadId: $${t} }) { thread { id isResolved } }`).join('\n')
  }\n}`;
}

type Author = { readonly __typename?: unknown; readonly login?: unknown } | null | undefined;

interface ThreadNode {
  readonly id?: unknown;
  readonly isResolved?: unknown;
  readonly pullRequest?: {
    readonly number?: unknown;
    readonly state?: unknown;
    readonly author?: { readonly login?: unknown } | null;
    readonly repository?: { readonly nameWithOwner?: unknown } | null;
  } | null;
  readonly comments?: { readonly totalCount?: unknown; readonly nodes?: readonly ({ readonly author?: Author } | null)[] } | null;
}

/**
 * True when the read returned every comment of the thread, the first is
 * the App bot's `login`, and each other is the App's or the pull request
 * author's.
 */
function onlyAppAndAuthor(t: ThreadNode, login: string): boolean {
  const nodes = t.comments?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0 || t.comments?.totalCount !== nodes.length) return false;
  const prAuthor = t.pullRequest?.author?.login;
  const isApp = (a: Author) => a?.__typename === 'Bot' && a.login === login;
  const isPrAuthor = (a: Author) => a?.__typename === 'User' && typeof a.login === 'string'
    && typeof prAuthor === 'string' && a.login.toLowerCase() === prAuthor.toLowerCase();
  return isApp(nodes[0]?.author) && nodes.every((c) => isApp(c?.author) || isPrAuthor(c?.author));
}

interface GraphqlResult {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { readonly message?: unknown }[];
}

async function graphql(api: GitHubApi, query: string, variables: Record<string, unknown>): Promise<GraphqlResult> {
  const { status, json } = await api('POST', 'graphql', { query, variables });
  if (status !== 200) throw new Error(`POST graphql returned ${status}`);
  return json as GraphqlResult;
}

function firstError(result: GraphqlResult): string {
  const message = result.errors?.[0]?.message;
  return typeof message === 'string' ? message : 'unknown error';
}

export function createThreadResolver(deps: ThreadResolverDeps): (event: ThreadResolverEvent) => Promise<ThreadResolverResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  // GraphQL names the App's bot by the App's slug.
  let slug: Promise<string> | null = null;
  const appSlug = (): Promise<string> => {
    slug ??= deps.appApi().then(fetchAppSlug).catch((err: unknown) => { slug = null; throw err; });
    return slug;
  };

  return async (event) => {
    const grant = event.grant;
    if (typeof grant !== 'string' || grant.length < 16 || grant.length > 200) return { error: 'invalid grant' };
    const ids = event.thread_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_THREADS_PER_CALL
      || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
      return { error: `thread_ids must hold 1 to ${MAX_THREADS_PER_CALL} thread ids` };
    }
    const g = await deps.readGrant(grantKey(grant));
    if (!g || g.expiresAt * 1000 < now()) {
      warn('[thread-resolver] refused: no grant, or an expired one');
      return { error: 'no valid grant' };
    }
    const { repo, prNumber, installationId } = g;
    const [owner, name] = repo.split('/');
    if (!owner || !name) return { error: 'the grant names no repository' };

    // As in src/broker.ts: GitHub resolves repository names inside the
    // installation a token is requested from.
    const installation = await fetchRepoInstallation(await deps.appApi(), repo);
    if (!installation || installation.id !== installationId || installation.account.toLowerCase() !== owner.toLowerCase()) {
      warn(`[thread-resolver] refused repo=${repo} installation=${installationId}: not the App's installation there`);
      return { error: `installation ${installationId} is not the App's installation on ${repo}` };
    }

    const login = await appSlug();
    let token: string;
    try {
      ({ token } = await deps.issueToken({ installationId, repositoryNames: [name], permissions: RESOLVE_PERMISSIONS }));
    } catch (err) {
      // An installation that does not grant Contents write: threads stay open.
      const msg = err instanceof Error ? err.message : String(err);
      warn(`[thread-resolver] repo=${repo} pr=${prNumber}: no token with contents: write: ${msg}`);
      return { error: `cannot resolve threads: no token with contents: write (${msg})` };
    }
    const api = deps.installationApi(token);

    // A thread in another repository can come back too: the token reads
    // public repositories. The checks below name the repository and the
    // pull request.
    const found = await graphql(api, THREADS_QUERY, { ids });
    const nodes = Array.isArray(found.data?.nodes) ? found.data.nodes as (ThreadNode | null)[] : [];
    const eligible: string[] = [];
    for (const t of nodes) {
      const pr = t?.pullRequest;
      if (t && typeof t.id === 'string' && t.isResolved === false
        && pr?.number === prNumber && pr.state === 'OPEN'
        && typeof pr.repository?.nameWithOwner === 'string' && pr.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()
        && onlyAppAndAuthor(t, login)) {
        eligible.push(t.id);
      }
    }
    if (eligible.length < ids.length) {
      warn(`[thread-resolver] repo=${repo} pr=${prNumber}: ${ids.length - eligible.length} of ${ids.length} thread(s) are not this App's open threads there with comments by the App and the author only${found.errors ? ` (${firstError(found)})` : ''}`);
    }
    if (eligible.length === 0) return { resolved: [] };

    const done = await graphql(api, resolveMutation(eligible.length), Object.fromEntries(eligible.map((id, i) => [`t${i}`, id])));
    const resolved = eligible.filter((_, i) => {
      const thread = (done.data?.[`t${i}`] as { thread?: { isResolved?: unknown } | null } | null | undefined)?.thread;
      return thread?.isResolved === true;
    });
    if (done.errors) warn(`[thread-resolver] repo=${repo} pr=${prNumber}: ${eligible.length - resolved.length} failed: ${firstError(done)}`);
    log(`[thread-resolver] resolved ${resolved.length} thread(s) repo=${repo} pr=${prNumber} installation=${installationId}`);
    return { resolved };
  };
}
