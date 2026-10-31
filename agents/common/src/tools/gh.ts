import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';
import type { StatusComment } from '../status-comment.js';
import type { TokenSource } from '../github-auth.js';
import type { ThreadResolver } from '../thread-resolver.js';
import {
  locationKey, openFindingKeys, previousFullReview, reviewStateSchema, renderReviewState, stripStateMarker, validateReviewState,
  type ReviewHeads, type ReviewState, type StateCommentWriter,
} from '../review-state.js';
import { runBounded } from './spawn.js';

/**
 * Endpoint shapes gh_api_read may GET, after the "repos/OWNER/REPO/"
 * prefix. The agent can explore the REST surface it needs for a review
 * without reaching anything else.
 */
const GH_API_READ_PATTERNS: ReadonlyArray<RegExp> = [
  /^pulls\/\d+$/,
  /^pulls\/\d+\/files(\?.*)?$/,
  /^pulls\/\d+\/reviews(\?.*)?$/,
  /^pulls\/\d+\/reviews\/\d+$/,
  /^pulls\/\d+\/comments(\?.*)?$/,
  /^pulls\/\d+\/commits(\?.*)?$/,
  /^issues\/\d+\/comments(\?.*)?$/,
  /^commits\/[a-f0-9]+$/,
  /^contents\/.+/,
  /^check-runs\/\d+$/,
  /^commits\/[a-f0-9]+\/check-runs(\?.*)?$/,
];

/**
 * Returns why `path` may not be read, or null. The path must name one of
 * `repos` ("owner/name", compared case-insensitively) and match an
 * allowed endpoint shape. "..", percent-encoding and backslashes are
 * refused outright: each can make the URL GitHub resolves differ from
 * the path checked here.
 */
export function checkGhApiPath(path: string, repos: readonly string[]): string | null {
  if (path.includes('..')) return 'the path must not contain "..".';
  if (path.includes('%')) return 'the path must not contain percent-encoded characters.';
  if (path.includes('\\')) return 'the path must not contain backslashes.';
  if (/[\s#]/.test(path)) return 'the path must not contain whitespace or "#".';
  const m = /^repos\/([^/?]+)\/([^/?]+)\/(.*)$/.exec(path);
  if (!m) return 'the path must start with repos/OWNER/REPO/.';
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  if (!repos.some((r) => r.toLowerCase() === repo)) {
    return `only these repositories can be read: ${[...new Set(repos)].join(', ')}.`;
  }
  if (!GH_API_READ_PATTERNS.some((r) => r.test(m[3]!))) return 'the endpoint is not on the allowlist.';
  return null;
}

/**
 * GitHub rejects comment and review bodies over 65,536 characters. The
 * tools stop a little short so the links the runtime appends still fit.
 */
export const MAX_GITHUB_TEXT_CHARS = 60_000;

function tooLong(what: string, text: string): string | null {
  return text.length > MAX_GITHUB_TEXT_CHARS
    ? `${what} is ${text.length} characters; the limit is ${MAX_GITHUB_TEXT_CHARS}. Shorten it and call again.`
    : null;
}

export type TerminalToolName = 'post_review' | 'skip_review';

/**
 * Tracks the one terminal call a run may make. post_review and
 * skip_review share a gate, so after either succeeds the other returns an
 * error without touching GitHub. Tool calls from one model turn run
 * concurrently, so a second call that arrives while the first is still
 * posting is refused too.
 */
export interface TerminalGate {
  /** Claim the gate before writing to GitHub. Returns an error message when it is taken. */
  acquire(tool: TerminalToolName): string | null;
  /**
   * Give the gate back after a call that wrote nothing, so the model can
   * retry. post_review also gives it back after a submission that may
   * have made the review without saying so; its next call looks for that
   * review before posting.
   */
  release(): void;
  /** Mark the run's review as done and tell the run loop. */
  complete(tool: TerminalToolName, result: string): void;
}

// Callbacks that some terminal gate will call. run-agent checks for its
// own callback after the agent's assembleTools returns, so an agent that
// does not pass onTerminal through fails before the model runs, instead
// of posting a review and then failing the run as unfinished.
const wiredCallbacks = new WeakSet<object>();

export function isTerminalCallbackWired(onTerminal: object): boolean {
  return wiredCallbacks.has(onTerminal);
}

// Thread resolvers some post_review got. run-agent checks for the run's,
// so an agent that drops it is noticed instead of leaving fixed threads
// open without a word.
const wiredResolvers = new WeakSet<object>();

export function isThreadResolverWired(threadResolver: object): boolean {
  return wiredResolvers.has(threadResolver);
}

export function createTerminalGate(onTerminal?: (tool: TerminalToolName, result: string) => void): TerminalGate {
  if (onTerminal) wiredCallbacks.add(onTerminal);
  let state: 'open' | 'busy' | TerminalToolName = 'open';
  return {
    acquire(tool) {
      if (state === 'open') {
        state = 'busy';
        return null;
      }
      if (state === 'busy') return `ERROR: nothing was posted. Another terminal call is still running; do not call ${tool} again.`;
      return `ERROR: nothing was posted. ${state} already completed this review; do not call ${tool} again.`;
    },
    release() {
      if (state === 'busy') state = 'open';
    },
    complete(tool, result) {
      state = tool;
      onTerminal?.(tool, result);
    },
  };
}

export interface GhToolsDeps {
  readonly tokens: TokenSource;
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  /**
   * Mention-triggered runs only. When present, the review summary body
   * replaces the status comment (the bot's single top-level comment on
   * the PR) instead of becoming a separate review body. Inline comments
   * still go through the normal review submission.
   */
  readonly statusComment?: StatusComment;
  /** Writes the sticky review-state comment; shared by post_review and skip_review. */
  readonly stateWriter: StateCommentWriter;
  /**
   * Shared by post_review and skip_review so only one of them succeeds per
   * run. When absent, each tool gets a gate of its own.
   */
  readonly terminalGate?: TerminalGate;
  /**
   * True once the model call limit stopped the review. The run loop then
   * asks for a terminal call, and the state it writes is recorded as a
   * partial review.
   */
  readonly callLimitReached?: () => boolean;
  /**
   * Resolves the run's own fixed threads, with the grant the queue worker
   * gave the run. Without it, threads stay open.
   */
  readonly threadResolver?: ThreadResolver;
}

/** Repositories gh_api_read may read: the PR's and the upstream the release branches come from. */
function readableRepos(ctx: PrContext): string[] {
  return [`${ctx.owner}/${ctx.repo}`, ...(ctx.upstreamRepo ? [ctx.upstreamRepo] : [])];
}

/**
 * The heads this run's state is written for. An automatic review is a
 * full review unless the model says it did not finish. An @mention run is
 * one only when the model says it reviewed the whole PR. A review the
 * call limit stopped is not, whatever the model says. A run that is not a
 * full review keeps the previous state's.
 */
function runHeads(deps: GhToolsDeps, fullReview: boolean | undefined): ReviewHeads {
  const { ctx } = deps;
  const full = !deps.callLimitReached?.() && (fullReview ?? Boolean(ctx.trigger));
  if (full) return { head: ctx.headSha, base: ctx.baseRef, fullReview: ctx.headSha, fullReviewBase: ctx.baseRef };
  const last = ctx.previousState ? previousFullReview(ctx.previousState.body) : null;
  return { head: ctx.headSha, base: ctx.baseRef, fullReview: last?.head ?? null, fullReviewBase: last?.base ?? null };
}

function checkState(deps: GhToolsDeps, state: ReviewState, heads: ReviewHeads): string | null {
  return validateReviewState(state, deps.ctx.releaseLines?.map((r) => r.branch) ?? null)
    ?? tooLong('The rendered review state', renderReviewState(state, heads));
}

/**
 * Render + write the state comment. A failure is reported, not thrown,
 * and does not stop the terminal call from completing. A write that
 * failed once is likely to fail again, and a run that ends without a
 * terminal tool is redelivered and reviewed a second time. The write may
 * also have reached GitHub even though the request reported an error.
 */
async function writeState(
  deps: GhToolsDeps,
  state: ReviewState,
  heads: ReviewHeads,
): Promise<{ url: string | null; error: string | null; userId: number | null }> {
  try {
    const { url, userId } = await deps.stateWriter.write(renderReviewState(state, heads));
    return { url, error: null, userId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[review-state] write failed: ${msg}`);
    return { url: null, error: msg, userId: null };
  }
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          originalStartLine
          comments(first: 100) { totalCount nodes { author { __typename login ... on Bot { databaseId } } pullRequestReview { databaseId } } }
        }
      }
    }
  }
}`;

/** At most this many pages of 100 review threads are read. */
const MAX_THREAD_PAGES = 10;

/** Thread ids sent to the thread resolver per call; see webhook/src/resolver.ts. */
const THREADS_PER_RESOLVE_CALL = 50;

/**
 * A review thread. `line` is where GitHub places it at the head, null
 * when it no longer can. GraphQL's startLine is left out: it keeps the
 * line the comment started on when the thread moves.
 */
interface ReviewThreadNode {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly comments: {
    readonly totalCount: number;
    readonly nodes: readonly {
      readonly author: { readonly __typename?: string; readonly login?: string; readonly databaseId?: number } | null;
      readonly pullRequestReview: { readonly databaseId: number | null } | null;
    }[];
  };
}

/**
 * True when the read returned every comment of the thread and each is
 * the App's or the pull request author's: the thread resolver refuses
 * any other (webhook/src/resolver.ts), so a person's reply stays in view.
 */
function onlyAppAndAuthor(t: ReviewThreadNode, botUserId: number, prAuthor: string): boolean {
  return t.comments.totalCount === t.comments.nodes.length && t.comments.nodes.every((c) => c.author?.databaseId === botUserId
    || (c.author?.__typename === 'User' && !!prAuthor && c.author.login?.toLowerCase() === prAuthor.toLowerCase()));
}


/** A finding's location: its `path:line` key, split. */
interface FindingLine {
  readonly key: string;
  readonly path: string;
  readonly line: number;
}

function findingLines(keys: Iterable<string>): FindingLine[] {
  return [...keys].map((key) => {
    const i = key.lastIndexOf(':');
    return { key, path: key.slice(0, i), line: Number(key.slice(i + 1)) };
  });
}

/** `path:line` keys of the findings that are, or are not, resolved. Findings without a line are left out. */
function findingKeys(state: ReviewState, resolved: boolean): Set<string> {
  const keys = new Set<string>();
  for (const f of state.findings) {
    if (f.resolved !== resolved) continue;
    const key = locationKey(f.location);
    if (key) keys.add(key);
  }
  return keys;
}

interface FindingSets {
  /** Keys open in the previous state. */
  readonly wasOpen: ReadonlySet<string>;
  readonly open: readonly FindingLine[];
  readonly resolved: ReadonlySet<string>;
  /** Every finding in this state, open or resolved, and their keys. */
  readonly named: readonly FindingLine[];
  readonly namedKeys: ReadonlySet<string>;
}

/** `path:line` of the last line a thread was posted on, which a finding's location names. */
function postedKey(t: ReviewThreadNode): string | null {
  return t.originalLine === null ? null : `${t.path}:${t.originalLine}`;
}

/**
 * Whether this run fixed the finding a thread is about. `taken` holds the
 * posted keys of all this App's threads on the PR: a line another thread
 * was posted on is that thread's. The thread is named by a finding on
 * the line it was posted on; failing that, by the one finding on the
 * other lines it was posted on (start line to line); failing that, by a
 * finding on the line it is on now. An open finding on any of those
 * leaves it alone. It qualifies when the finding naming it is resolved
 * now and was open before. A finding the previous state had open on the
 * posted line, and that this state names only on the line it is on now,
 * moved and counts too.
 */
function threadFixed(t: ReviewThreadNode, sets: FindingSets, taken: ReadonlySet<string>): boolean {
  const posted = postedKey(t);
  const now = t.line === null ? null : `${t.path}:${t.line}`;
  const own = (key: string) => key === posted || !taken.has(key);
  const from = t.originalStartLine ?? t.originalLine;
  const inPosted = (f: FindingLine) => posted !== null && from !== null && f.path === t.path
    && f.line >= from && f.line <= t.originalLine! && own(f.key);
  if (sets.open.some((f) => inPosted(f) || (f.key === now && own(f.key)))) return false;
  let key: string | null = null;
  if (posted !== null && sets.namedKeys.has(posted)) {
    key = posted;
  } else {
    const inside = [...new Set(sets.named.filter(inPosted).map((f) => f.key))];
    // Two findings on its lines, neither on the last: which one it is about is unclear.
    if (inside.length > 1) return false;
    key = inside[0] ?? (now !== null && sets.namedKeys.has(now) && own(now) ? now : null);
  }
  if (key === null || !sets.resolved.has(key)) return false;
  if (sets.wasOpen.has(key)) return true;
  return key === now && posted !== null && sets.wasOpen.has(posted) && !sets.namedKeys.has(posted);
}

/**
 * Resolves this App's open review threads whose finding this run fixed:
 * open in the previous state comment, resolved in this one (threadFixed).
 * A finding's `location` is the `path:line` its inline comment was posted
 * at. A thread that an open finding also names is left alone, and so are
 * a thread someone else started, a thread anyone but the App and the pull
 * request's author commented in, and the threads of `ownReviewId`, the
 * review this call posted.
 * A finding fixed in an earlier run is not looked at again, so a thread a
 * person reopened stays open. Threads are never reopened: a person who
 * resolves one has answered it.
 *
 * GitHub lets only a token with contents: write resolve a thread, which
 * the run's token is not, so the thread resolver resolves them, for the
 * pull request the run's grant names. Returns how many it resolved.
 * Errors are logged, never thrown: the review is complete either way. A failed resolve is not tried again: the next run
 * does not see the finding open, so the thread stays open.
 */
async function resolveFixedThreads(
  deps: GhToolsDeps,
  state: ReviewState,
  botUserId: number | null,
  ownReviewId: number | null,
): Promise<number> {
  const { ctx, octokit, threadResolver } = deps;
  if (!ctx.previousState || botUserId === null) return 0;
  const openKeys = findingKeys(state, false);
  const resolvedKeys = findingKeys(state, true);
  const namedKeys = new Set([...openKeys, ...resolvedKeys]);
  const wasOpen = openFindingKeys(ctx.previousState.body);
  // A thread qualifies only through a key open before that is resolved now, or one this state dropped.
  if (![...wasOpen].some((k) => resolvedKeys.has(k) || !namedKeys.has(k))) return 0;
  if (!threadResolver) {
    console.warn('[review-threads] this run has no resolve grant, so threads of fixed findings stay open');
    return 0;
  }
  const sets: FindingSets = {
    wasOpen,
    open: findingLines(openKeys),
    resolved: resolvedKeys,
    named: findingLines(namedKeys),
    namedKeys,
  };
  const ids: string[] = [];
  let resolved = 0;
  try {
    const threads: ReviewThreadNode[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const data: {
        repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ReviewThreadNode[] } } | null };
      } = await octokit.graphql(REVIEW_THREADS_QUERY, { owner: ctx.owner, repo: ctx.repo, number: ctx.prNumber, cursor });
      const pageThreads = data.repository.pullRequest?.reviewThreads;
      if (!pageThreads) break;
      threads.push(...pageThreads.nodes);
      if (!pageThreads.pageInfo.hasNextPage) break;
      cursor = pageThreads.pageInfo.endCursor;
    }
    const ours = threads.filter((t) => t.comments.nodes[0]?.author?.databaseId === botUserId);
    const taken = new Set(ours.map(postedKey).filter((k) => k !== null));
    for (const t of ours) {
      if (t.isResolved || (ownReviewId !== null && t.comments.nodes[0]?.pullRequestReview?.databaseId === ownReviewId)) continue;
      if (onlyAppAndAuthor(t, botUserId, ctx.author) && threadFixed(t, sets, taken)) ids.push(t.id);
    }
    for (let i = 0; i < ids.length; i += THREADS_PER_RESOLVE_CALL) {
      resolved += (await threadResolver.resolve(ids.slice(i, i + THREADS_PER_RESOLVE_CALL))).length;
    }
    if (resolved < ids.length) console.warn(`[review-threads] the thread resolver resolved ${resolved} of ${ids.length} thread(s); see its log`);
  } catch (err) {
    console.warn(`[review-threads] resolving fixed threads failed after ${resolved} of ${ids.length}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resolved > 0) console.log(`[review-threads] resolved ${resolved} thread(s) whose finding is fixed`);
  return resolved;
}

/** Result field for a failed state write, telling the model the review is still done. */
function stateError(error: string | null): { state_comment_error?: string } {
  return error ? { state_comment_error: `${error} (the review is complete; do not call post_review or skip_review again)` } : {};
}

/** Status-comment text for a mention run that ends without an inline comment or a reply. */
const NOTHING_NEW = 'Review complete. Nothing new met the bar for an inline comment.';

const fullReviewSchema = z.boolean().optional().describe(
  'On a mention-triggered run, true only if this run reviewed the whole PR at the current head, not just the area or the thread the request named. On an automatic review, false if you did not finish reviewing the whole PR. Leave it unset otherwise.',
);

/** Writes the state, then resolves the threads of findings it marks fixed, except those of `ownReviewId`. */
async function finishState(deps: GhToolsDeps, state: ReviewState, heads: ReviewHeads, ownReviewId: number | null = null) {
  const written = await writeState(deps, state, heads);
  // A state that did not reach GitHub does not show the finding fixed, so its thread stays open too.
  const threadsResolved = written.error === null ? await resolveFixedThreads(deps, state, written.userId, ownReviewId) : 0;
  return { ...written, threadsResolved };
}

/** A review comment's text, for comparing what was posted with what was sent. */
function sameText(a: string | null | undefined, b: string): boolean {
  return (a ?? '').replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();
}

/** True when the posted comments are the sent ones: the same paths and texts, as many of each. */
function sameComments(
  posted: readonly { readonly path: string; readonly body: string }[],
  sent: readonly { readonly path: string; readonly body: string }[],
): boolean {
  if (posted.length !== sent.length) return false;
  const left = [...posted];
  return sent.every((c) => {
    const i = left.findIndex((p) => p.path === c.path && sameText(p.body, c.body));
    if (i === -1) return false;
    left.splice(i, 1);
    return true;
  });
}

/**
 * The review this App made from `body` and `comments` at the head,
 * submitted at or after `since`, or null. It tells whether a review
 * submission that got no answer, or a server error, made the review
 * anyway. The comments are compared too: another run of the App can
 * review the same head at the same time.
 */
async function findOwnReview(
  deps: GhToolsDeps,
  since: string,
  body: string,
  comments: readonly { readonly path: string; readonly body: string }[],
): Promise<{ id: number; url: string } | null> {
  const { ctx, octokit } = deps;
  // An installation token's viewer is the App's bot account.
  const { viewer } = await octokit.graphql<{ viewer: { databaseId: number | null } }>('query { viewer { databaseId } }');
  if (viewer.databaseId === null) throw new Error('GitHub did not say which account the token belongs to');
  const pr = { owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 };
  const reviews = await octokit.paginate(octokit.pulls.listReviews, pr);
  // GitHub's submitted_at and `since` have the same form, so they compare as strings.
  const candidates = reviews.filter((r) => r.user?.id === viewer.databaseId && r.commit_id === ctx.headSha
    && (r.submitted_at ?? '') >= since && sameText(r.body, body));
  for (const r of candidates) {
    const posted = await octokit.paginate(octokit.pulls.listCommentsForReview, { ...pr, review_id: r.id });
    if (sameComments(posted, comments)) return { id: r.id, url: r.html_url };
  }
  return null;
}

function threadsResult(count: number): { threads_resolved?: number } {
  return count > 0 ? { threads_resolved: count } : {};
}

function withStateLink(text: string, stateUrl: string | null): string {
  return stateUrl ? `${text}\n\nCurrent review state: ${stateUrl}` : text;
}

export function buildGhApiReadTool(deps: GhToolsDeps) {
  const repos = readableRepos(deps.ctx);
  return tool({
    name: 'gh_api_read',
    description:
`Read from the GitHub REST API. Only GET is allowed, only for ${[...new Set(repos)].join(' and ')}, and only for these endpoint paths:

- repos/OWNER/REPO/pulls/NUMBER: PR object
- repos/OWNER/REPO/pulls/NUMBER/files: changed files + patch hunks (paginated)
- repos/OWNER/REPO/pulls/NUMBER/reviews: submitted reviews
- repos/OWNER/REPO/pulls/NUMBER/reviews/ID: single review
- repos/OWNER/REPO/pulls/NUMBER/comments: inline review comments
- repos/OWNER/REPO/pulls/NUMBER/commits: PR commits
- repos/OWNER/REPO/issues/NUMBER/comments: issue/PR comments
- repos/OWNER/REPO/commits/SHA: commit
- repos/OWNER/REPO/contents/PATH: file at ref
- repos/OWNER/REPO/commits/SHA/check-runs: CI status
- repos/OWNER/REPO/check-runs/ID: CI detail

Do NOT include a leading slash. Append query strings inline, e.g. \`repos/OWNER/REPO/pulls/12/files?page=2&per_page=100\`. Percent-encoding, "..", and backslashes are refused.`,
    inputSchema: z.object({
      path: z.string().describe('API path without leading slash, e.g. "repos/OWNER/REPO/pulls/12"'),
    }),
    callback: async (input: { path: string }) => {
      const path = input.path.replace(/^\/+/, '');
      const problem = checkGhApiPath(path, repos);
      if (problem) return `ERROR: path "${path}" cannot be read: ${problem}`;
      const token = await deps.tokens.get();
      const r = await runBounded('gh', ['api', path, '--method', 'GET'], {
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
        timeoutMs: 30_000,
        maxBytes: 2_000_000,
      });
      if (r.truncated) return `${r.out}\nThe response was cut at 2 MB. Ask for a smaller page with per_page and page.`;
      if (r.code !== 0) return `gh api failed (${r.code}): ${r.err}\n${r.out}`;
      return r.out;
    },
  });
}

/**
 * Post the review. Atomic: one call, summary body + N inline comments.
 * Mirrors POST /repos/:o/:r/pulls/:n/reviews exactly.
 */
export function buildPostReviewTool(deps: GhToolsDeps) {
  const gate = deps.terminalGate ?? createTerminalGate();
  if (deps.threadResolver) wiredResolvers.add(deps.threadResolver);
  // When a submission may have made the review without saying so, the
  // time it started. The next call looks for that review before it posts.
  let unanswered: string | null = null;
  return tool({
    name: 'post_review',
    description:
`Post the final PR review atomically. Exactly one successful call per invocation. After a successful post_review or skip_review, later calls return an error and post nothing.

Supply:
- \`body\`: on a mention-triggered run, the short reply to the requester. Otherwise leave it empty; the summary lives in \`state\`.
- \`comments\`: an array of inline comments. Each item: { path, line, side?, body }. \`line\` is 1-indexed in the RIGHT file (side: "RIGHT" default). Use \`start_line\` + \`line\` for multi-line comments. Anchor only to lines present in the PR diff.
- \`state\`: the full current review state. The runtime renders it into the PR's single review-state comment and rewrites that comment on every run. It then resolves each of your open threads whose finding was open in the previous state and \`state\` marks resolved.
- \`full_review\`: on a mention-triggered run, true only if you reviewed the whole PR at this head. On an automatic review, false if you did not finish it.

\`body\` and each comment body may be at most ${MAX_GITHUB_TEXT_CHARS} characters.

The review is posted as event="COMMENT". REQUEST_CHANGES and APPROVE are not available to the reviewer: block/approve decisions belong to humans. If you have no inline comments, call \`skip_review\` instead. Exception: on a mention-triggered run with a reply for the requester, call this tool with \`comments: []\` and the reply in \`body\`.

The review is anchored at the PR head SHA already loaded in the workspace context (${deps.ctx.headSha}). You do not pass it.`,
    inputSchema: z.object({
      body: z.string(),
      comments: z.array(z.object({
        path: z.string(),
        line: z.number().int().positive(),
        side: z.enum(['LEFT', 'RIGHT']).optional(),
        start_line: z.number().int().positive().optional(),
        start_side: z.enum(['LEFT', 'RIGHT']).optional(),
        body: z.string(),
      })).default([]),
      state: reviewStateSchema,
      full_review: fullReviewSchema,
    }),
    callback: async (input) => {
      const heads = runHeads(deps, input.full_review);
      const invalid = tooLong('`body`', input.body)
        ?? input.comments.map((c, i) => tooLong(`comments[${i}].body`, c.body)).find((e) => e !== null)
        ?? checkState(deps, input.state, heads);
      if (invalid) return `ERROR: nothing was posted. ${invalid}`;
      const taken = gate.acquire('post_review');
      if (taken) return taken;

      // Mention-triggered runs: the summary replaces the status comment
      // (the bot's existing top-level comment), so the PR gets one comment
      // instead of an ack plus a separate review body. Inline comments
      // still need a review object; it is submitted with an empty body.
      const summaryInStatusComment = deps.statusComment !== undefined;
      const reviewBody = summaryInStatusComment ? '' : input.body.trim();
      let review: { id: number; url: string } | null = null;
      // GitHub rejects an empty-body, zero-comment review, and with
      // nothing to anchor there is nothing a review object would add.
      if ((input.comments.length > 0 || reviewBody) && unanswered !== null) {
        try {
          review = await findOwnReview(deps, unanswered, reviewBody, input.comments);
        } catch (err) {
          gate.release();
          return `ERROR: nothing was posted. An earlier post_review may have posted the review, and checking for it failed: ${err instanceof Error ? err.message : String(err)}. Call post_review again with the same input.`;
        }
        if (review) console.log(`[post_review] review ${review.id} from an earlier call is on the PR; not posting it again`);
      }
      if ((input.comments.length > 0 || reviewBody) && !review) {
        // Second precision: GitHub's submitted_at has no milliseconds.
        const startedAt = `${new Date(Date.now() - 1000).toISOString().slice(0, 19)}Z`;
        try {
          const resp = await deps.octokit.pulls.createReview({
            owner: deps.ctx.owner,
            repo: deps.ctx.repo,
            pull_number: deps.ctx.prNumber,
            commit_id: deps.ctx.headSha,
            event: 'COMMENT',
            body: reviewBody,
            comments: input.comments,
          });
          review = { id: resp.data.id, url: resp.data.html_url };
        } catch (err) {
          gate.release();
          const e = err as { status?: number; message?: string; response?: { data?: { errors?: unknown } } } | null;
          // The request reached GitHub, and no answer came (the request
          // bound, or a dropped connection) or GitHub failed on it. GitHub
          // stops a request after 10 seconds and can make the review
          // anyway. An error with no status never left the runtime.
          if (e?.status !== undefined && (!e.response || e.status >= 500)) {
            unanswered ??= startedAt;
            const what = e.response ? `GitHub answered ${e.status}` : 'GitHub did not answer';
            return `ERROR: ${what} (${e.message ?? String(err)}), so the review may have been posted anyway. Call post_review again with the same input: it first looks for this review on the PR, and posts it only if it is not there.`;
          }
          const errors = e?.response?.data?.errors;
          return `ERROR status=${e?.status ?? '?'}: nothing was posted. ${e?.message ?? String(err)}${errors ? `\n${JSON.stringify(errors)}` : ''}`;
        }
      }
      unanswered = null;

      // A failed state write is only reported; see writeState.
      const state = await finishState(deps, input.state, heads, review?.id ?? null);
      if (deps.statusComment) {
        const reply = stripStateMarker(input.body).trim()
          || (input.comments.length > 0 ? `Review complete. See the ${input.comments.length} inline comment(s).` : NOTHING_NEW);
        await deps.statusComment.finish(withStateLink(reply, state.url));
      }
      const result = JSON.stringify({
        ok: true,
        review_id: review?.id ?? null,
        url: review?.url ?? null,
        state_comment_url: state.url,
        ...threadsResult(state.threadsResolved),
        ...stateError(state.error),
      });
      gate.complete('post_review', result);
      return result;
    },
  });
}

/**
 * End the review without inline comments. The state comment is still
 * written, so the PR shows the current verdict.
 */
export function buildSkipTool(deps: GhToolsDeps) {
  const gate = deps.terminalGate ?? createTerminalGate();
  return tool({
    name: 'skip_review',
    description:
`End the review without inline comments. Call this when nothing in this run warrants an inline comment. Do NOT use this as cover for missing findings. After a successful post_review or skip_review, later calls return an error and post nothing.

Posts no review, but still writes \`state\` to the PR's review-state comment, so the PR shows the current verdict (for example "ready for human review", or open findings carried over from an earlier run). It then resolves each of your open threads whose finding was open in the previous state and \`state\` marks resolved.`,
    inputSchema: z.object({
      reason: z.string().min(1).describe('One-sentence rationale. Logged, and on a mention-triggered run shown to the requester.'),
      state: reviewStateSchema,
      full_review: fullReviewSchema,
    }),
    callback: async (input) => {
      const heads = runHeads(deps, input.full_review);
      const invalid = tooLong('`reason`', input.reason) ?? checkState(deps, input.state, heads);
      if (invalid) return `ERROR: nothing was posted. ${invalid}`;
      const taken = gate.acquire('skip_review');
      if (taken) return taken;
      // A failed state write is only reported; see writeState.
      const state = await finishState(deps, input.state, heads);
      // Mention-triggered runs: someone asked and is watching the status
      // comment, and a silent exit would leave it on "still working".
      if (deps.statusComment) {
        await deps.statusComment.finish(withStateLink(`${NOTHING_NEW} (${stripStateMarker(input.reason).trim()})`, state.url));
      }
      const result = JSON.stringify({
        ok: true,
        skipped: true,
        reason: input.reason,
        pr: `${deps.ctx.owner}/${deps.ctx.repo}#${deps.ctx.prNumber}`,
        state_comment_url: state.url,
        ...threadsResult(state.threadsResolved),
        ...stateError(state.error),
      });
      gate.complete('skip_review', result);
      return result;
    },
  });
}
