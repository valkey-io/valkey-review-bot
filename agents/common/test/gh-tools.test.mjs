import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { buildPostReviewTool, buildSkipTool, checkGhApiPath, createTerminalGate, isTerminalCallbackWired, MAX_GITHUB_TEXT_CHARS } = await import('../src/tools/gh.ts');
const { renderReviewState } = await import('../src/review-state.ts');

const ctx = {
  owner: 'valkey-io', repo: 'valkey', prNumber: 7, headSha: 'abc123', baseRef: 'unstable', trigger: 'opened',
  author: 'contributor',
  previousState: null,
  upstreamRepo: 'valkey-io/valkey',
  releaseLines: [{ branch: '9.0', lastCommit: '2026-09-01' }, { branch: '8.1', lastCommit: '2026-08-01' }],
};

/** This App's bot account, as the state comment write reports it. */
const BOT_ID = 282604435;

const state = (overrides = {}) => ({
  status: 'needs_work',
  summary: 'One open finding.',
  risk: 'low',
  risk_reason: 'Only the error path changes.',
  findings: [{ location: 'src/server.c:10', summary: 'Leak on error.', blocking: true, resolved: false }],
  backport: { verdict: 'not_needed', branches: [], reason: 'New code.' },
  direction: '',
  ...overrides,
});

function harness({ createReview, stateWrite, statusComment, graphql, listReviews, reviewComments, resolve, noResolver, callLimitReached, ctx: ctxOverrides } = {}) {
  const reviews = [];
  const stateBodies = [];
  const terminal = [];
  const resolveCalls = [];
  const deps = {
    ctx: { ...ctx, ...ctxOverrides },
    tokens: { get: async () => 'token' },
    ...(noResolver ? {} : {
      threadResolver: {
        resolve: resolve ?? (async (ids) => {
          resolveCalls.push({ ids });
          return ids;
        }),
      },
    }),
    callLimitReached,
    octokit: {
      pulls: {
        createReview: createReview ?? (async (args) => {
          reviews.push(args);
          return { data: { id: reviews.length, html_url: `https://github.com/r/${reviews.length}` } };
        }),
        listReviews: listReviews ?? (async () => { throw new Error('this test reads no reviews'); }),
        listCommentsForReview: async ({ review_id }) => (reviewComments ?? (() => [comment]))(review_id),
      },
      paginate: async (method, args) => method(args),
      graphql: graphql ?? (async () => { throw new Error('this test reads no review threads'); }),
    },
    stateWriter: {
      write: stateWrite ?? (async (body) => {
        stateBodies.push(body);
        return { id: 99, url: 'https://github.com/state', userId: BOT_ID };
      }),
    },
    statusComment,
    terminalGate: createTerminalGate((tool, result) => terminal.push({ tool, result })),
  };
  return { post: buildPostReviewTool(deps), skip: buildSkipTool(deps), reviews, stateBodies, terminal, resolveCalls };
}

const comment = { path: 'src/server.c', line: 10, body: 'This leaks `buf` when `read` fails.' };

test('a successful post_review is terminal, and a second one posts nothing', async () => {
  const h = harness();
  const first = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.equal(JSON.parse(first).ok, true);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.stateBodies.length, 1);
  assert.deepEqual(h.terminal.map((t) => t.tool), ['post_review']);
  assert.equal(h.terminal[0].result, first);

  const second = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(second, /^ERROR: nothing was posted\. post_review already completed/);
  const skip = await h.skip.invoke({ reason: 'nothing new', state: state() });
  assert.match(skip, /^ERROR: nothing was posted\./);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.stateBodies.length, 1);
  assert.equal(h.terminal.length, 1);
});

test('a failed post_review is not terminal and can be retried', async () => {
  let fail = true;
  const reviews = [];
  const h = harness({
    createReview: async (args) => {
      if (fail) throw Object.assign(new Error('Unprocessable Entity'), { status: 422, response: { data: { errors: ['line not in diff'] } } });
      reviews.push(args);
      return { data: { id: 1, html_url: 'https://github.com/r/1' } };
    },
  });
  const failed = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(failed, /^ERROR status=422: nothing was posted/);
  assert.match(failed, /line not in diff/);
  assert.equal(h.terminal.length, 0);
  assert.equal(h.stateBodies.length, 0);

  fail = false;
  assert.equal(JSON.parse(await h.post.invoke({ body: '', comments: [comment], state: state() })).ok, true);
  assert.equal(reviews.length, 1);
  assert.equal(h.terminal.length, 1);
});

test('concurrent terminal calls post once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reviews = [];
  const h = harness({
    createReview: async (args) => {
      reviews.push(args);
      await gate;
      return { data: { id: 1, html_url: 'https://github.com/r/1' } };
    },
  });
  const first = h.post.invoke({ body: '', comments: [comment], state: state() });
  const second = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(second, /still running/);
  release();
  assert.equal(JSON.parse(await first).ok, true);
  assert.equal(reviews.length, 1);
  assert.equal(h.terminal.length, 1);
});

test('an invalid state or oversized text posts nothing and keeps the gate open', async () => {
  const h = harness();
  const ready = state({ status: 'ready_for_human_review' });
  assert.match(await h.post.invoke({ body: '', comments: [comment], state: ready }), /^ERROR: nothing was posted\..*blocking finding/);
  const huge = 'x'.repeat(MAX_GITHUB_TEXT_CHARS + 1);
  assert.match(await h.post.invoke({ body: huge, comments: [comment], state: state() }), /`body` is 60001 characters/);
  assert.match(await h.post.invoke({ body: '', comments: [comment, { ...comment, body: huge }], state: state() }), /comments\[1\]\.body is 60001 characters/);
  assert.match(await h.skip.invoke({ reason: huge, state: state() }), /`reason` is 60001 characters/);
  const longState = state({ summary: huge });
  assert.match(await h.skip.invoke({ reason: 'r', state: longState }), /rendered review state is \d+ characters/);
  const badBranch = state({ backport: { verdict: 'needed', branches: ['7.2'], reason: 'Old bug.' } });
  assert.match(await h.skip.invoke({ reason: 'r', state: badBranch }), /"7\.2".*9\.0, 8\.1/);
  assert.equal(h.reviews.length, 0);
  assert.equal(h.stateBodies.length, 0);
  assert.equal(h.terminal.length, 0);

  assert.equal(JSON.parse(await h.skip.invoke({ reason: 'Nothing new.', state: state() })).skipped, true);
  assert.deepEqual(h.terminal.map((t) => t.tool), ['skip_review']);
});

const failingStateWrite = async () => { throw new Error('Bad credentials'); };

test('skip_review still completes the review when only the state comment write fails', async () => {
  const finished = [];
  const h = harness({ stateWrite: failingStateWrite, statusComment: { finish: async (body) => { finished.push(body); } } });
  const raw = await h.skip.invoke({ reason: 'Nothing new.', state: state() });
  const result = JSON.parse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.state_comment_url, null);
  assert.match(result.state_comment_error, /Bad credentials.*do not call post_review or skip_review again/);
  assert.deepEqual(h.terminal, [{ tool: 'skip_review', result: raw }]);
  // The requester still gets an answer, without a link to a state comment that was not written.
  assert.deepEqual(finished, ['Review complete. Nothing new met the bar for an inline comment. (Nothing new.)']);

  assert.match(await h.skip.invoke({ reason: 'again', state: state() }), /^ERROR: nothing was posted\. skip_review already completed/);
  assert.match(await h.post.invoke({ body: '', comments: [comment], state: state() }), /^ERROR: nothing was posted\. skip_review already completed/);
  assert.equal(h.reviews.length, 0);
  assert.equal(h.terminal.length, 1);
});

test('post_review still completes the review when only the state comment write fails', async () => {
  const posted = harness({ stateWrite: failingStateWrite });
  const raw = await posted.post.invoke({ body: '', comments: [comment], state: state() });
  const result = JSON.parse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.review_id, 1);
  assert.match(result.state_comment_error, /Bad credentials.*do not call post_review or skip_review again/);
  assert.equal(posted.reviews.length, 1);
  assert.deepEqual(posted.terminal, [{ tool: 'post_review', result: raw }]);
  assert.match(await posted.post.invoke({ body: '', comments: [comment], state: state() }), /^ERROR: nothing was posted\. post_review already completed/);
  assert.equal(posted.reviews.length, 1);

  // With no inline comments and no body there is no review object; the call still completes.
  const stateOnly = harness({ stateWrite: failingStateWrite });
  const bare = JSON.parse(await stateOnly.post.invoke({ body: '', comments: [], state: state() }));
  assert.equal(bare.ok, true);
  assert.equal(bare.review_id, null);
  assert.match(bare.state_comment_error, /Bad credentials/);
  assert.equal(stateOnly.reviews.length, 0);
  assert.deepEqual(stateOnly.terminal.map((t) => t.tool), ['post_review']);
});

test('a successful state write leaves no state_comment_error', async () => {
  const h = harness();
  assert.equal('state_comment_error' in JSON.parse(await h.skip.invoke({ reason: 'r', state: state() })), false);
  const other = harness();
  assert.equal('state_comment_error' in JSON.parse(await other.post.invoke({ body: '', comments: [comment], state: state() })), false);
});

test('on mention runs the reply replaces the status comment and the review body stays empty', async () => {
  const finished = [];
  const h = harness({ statusComment: { finish: async (body) => { finished.push(body); } } });
  await h.post.invoke({ body: 'Fixed in the latest push, one nit left.', comments: [comment], state: state() });
  assert.equal(h.reviews[0].body, '');
  assert.deepEqual(finished, ['Fixed in the latest push, one nit left.\n\nCurrent review state: https://github.com/state']);
});

test('the post_review description allows a reply-only call on mention runs, as the prompts do', () => {
  const { description } = harness().post.toolSpec;
  assert.match(description, /If you have no inline comments, call `skip_review` instead\. Exception: on a mention-triggered run with a reply for the requester, call this tool with `comments: \[\]` and the reply in `body`\./);
});

test('on mention runs an empty reply falls back to a line that fits what was posted', async () => {
  const finished = [];
  const statusComment = { finish: async (body) => { finished.push(body); } };
  const withComments = harness({ statusComment });
  await withComments.post.invoke({ body: '  ', comments: [comment, { ...comment, line: 12 }], state: state() });
  const bare = harness({ statusComment });
  await bare.post.invoke({ body: '', comments: [], state: state() });
  assert.equal(bare.reviews.length, 0);
  assert.deepEqual(finished, [
    'Review complete. See the 2 inline comment(s).\n\nCurrent review state: https://github.com/state',
    'Review complete. Nothing new met the bar for an inline comment.\n\nCurrent review state: https://github.com/state',
  ]);
});

test('model text in the status comment cannot carry the state marker', async () => {
  const { STATE_MARKER } = await import('../src/review-state.ts');
  const finished = [];
  const statusComment = { finish: async (body) => { finished.push(body); } };
  await harness({ statusComment }).post.invoke({ body: `${STATE_MARKER}\nAll fixed.`, comments: [comment], state: state() });
  await harness({ statusComment }).skip.invoke({ reason: `Nothing new ${STATE_MARKER}`, state: state() });
  assert.deepEqual(finished, [
    'All fixed.\n\nCurrent review state: https://github.com/state',
    'Review complete. Nothing new met the bar for an inline comment. (Nothing new)\n\nCurrent review state: https://github.com/state',
  ]);
});

test('the run loop can tell whether its terminal callback reached the tools', async () => {
  const { assembleCommonTools } = await import('../src/tools/index.ts');
  const opts = { ctx: { ...ctx, workspacePath: process.cwd() }, octokit: {}, tokens: { get: async () => 'token' } };
  const forwarded = () => {};
  await assembleCommonTools({ ...opts, onTerminal: forwarded });
  assert.equal(isTerminalCallbackWired(forwarded), true);

  const dropped = () => {};
  await assembleCommonTools(opts);
  assert.equal(isTerminalCallbackWired(dropped), false);
});

test('gh_api_read paths must name an allowed repository and endpoint', () => {
  const repos = ['avalkey/valkey', 'valkey-io/valkey'];
  assert.equal(checkGhApiPath('repos/avalkey/valkey/pulls/12/files?page=2&per_page=100', repos), null);
  assert.equal(checkGhApiPath('repos/Valkey-IO/Valkey/commits/abc123/check-runs', repos), null);
  assert.equal(checkGhApiPath('repos/valkey-io/valkey/contents/src/server.c?ref=9.0', repos), null);

  assert.match(checkGhApiPath('repos/someone/else/pulls/1', repos), /only these repositories/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/pulls/1/../../../../user', repos), /"\.\."/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/contents/a%2E%2E%2Fb', repos), /percent-encoded/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/contents/a\\b', repos), /backslashes/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/pulls/1 --method POST', repos), /whitespace/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/actions/secrets', repos), /not on the allowlist/);
  assert.match(checkGhApiPath('user/repos', repos), /must start with repos/);
  assert.match(checkGhApiPath('repos/{owner}/{repo}/pulls/1', repos), /only these repositories/);
});

/** A GraphQL fake with this PR's review threads, in pages. Resolving goes through the thread resolver, not GraphQL. */
function threadsApi(pages) {
  const cursors = [];
  const graphql = async (query, vars) => {
    if (query.includes('resolveReviewThread')) throw new Error('the run token cannot resolve threads');
    cursors.push(vars.cursor ?? null);
    const index = vars.cursor ? Number(vars.cursor) : 0;
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
            nodes: pages[index],
          },
        },
      },
    };
  };
  return { graphql, cursors };
}

/**
 * A review thread. `author` is the first comment's Bot databaseId; a
 * person's comment reads as {}. `review` is the id of the review that
 * comment came with.
 */
const thread = (id, {
  path = 'src/server.c', line = 10, originalLine = 10, originalStartLine = null,
  isResolved = false, author = BOT_ID, review = 1000, replies = [], total,
} = {}) => {
  // A number is a bot's databaseId; a string is a person's login ('person' for someone else).
  const by = (who) => (typeof who === 'number' ? { __typename: 'Bot', login: 'some-bot', databaseId: who } : { __typename: 'User', login: who });
  const nodes = [
    { author: by(author), pullRequestReview: { databaseId: review } },
    ...replies.map((who) => ({ author: by(who), pullRequestReview: { databaseId: review } })),
  ];
  return { id, isResolved, path, line, originalLine, originalStartLine, comments: { totalCount: total ?? nodes.length, nodes } };
};

const finding = (location, resolved, blocking = true) => ({ location, summary: `About ${location}.`, blocking, resolved });

/** The state comment an earlier run wrote with these findings. */
const previousWith = (findings) => ({
  id: 5,
  body: renderReviewState(state({ findings }), { head: 'abc123', base: 'unstable', fullReview: 'abc123', fullReviewBase: 'unstable' }),
});

test('a finding this run fixed resolves its own open thread through the thread resolver, and only that one', async () => {
  const api = threadsApi([[
    thread('fixed'),
    thread('outdated', { path: 'src/old.c', line: null, originalLine: 4 }),
    thread('moved', { path: 'src/moved.c', line: 30, originalLine: 12 }),
    thread('person', { author: 'person' }),
    thread('other-bot', { author: 999 }),
    thread('already', { isResolved: true }),
    thread('still-open', { path: 'src/a.c', line: 5, originalLine: 5 }),
    thread('both', { path: 'src/b.c', line: 7, originalLine: 3 }),
    thread('no-finding', { line: 11, originalLine: 11 }),
  ]]);
  const previousState = previousWith([
    finding('src/server.c:10', false),
    finding('src/old.c:4', false, false),
    finding('src/moved.c:30', false),
    finding('src/a.c:5', false),
    finding('src/b.c:3', false),
    finding('src/b.c:7', false),
  ]);
  const h = harness({ graphql: api.graphql, ctx: { previousState } });
  const result = JSON.parse(await h.skip.invoke({
    reason: 'Re-checked the fixes.',
    state: state({
      findings: [
        finding('src/server.c:10', true),
        finding('src/old.c:4', true, false),
        finding('src/moved.c:30', true),
        finding('src/a.c:5', false),
        finding('src/b.c:3', true),
        finding('src/b.c:7', false),
        finding('', true),
      ],
    }),
  }));
  assert.deepEqual(h.resolveCalls, [{ ids: ['fixed', 'outdated', 'moved'] }]);
  assert.equal(result.threads_resolved, 3);
  assert.equal(result.ok, true);
});

test('a thread the PR author replied in is resolved once its finding is fixed; anyone else\'s reply keeps it open', async () => {
  const api = threadsApi([[
    thread('author-reply', { path: 'src/a.c', line: 5, originalLine: 5, replies: ['contributor'] }),
    thread('maintainer-reply', { path: 'src/b.c', line: 6, originalLine: 6, replies: ['maintainer'] }),
    thread('other-bot-reply', { path: 'src/c.c', line: 7, originalLine: 7, replies: [999] }),
    thread('too-long', { path: 'src/d.c', line: 8, originalLine: 8, total: 101 }),
    thread('alone', { path: 'src/e.c', line: 9, originalLine: 9 }),
  ]]);
  const at = ['src/a.c:5', 'src/b.c:6', 'src/c.c:7', 'src/d.c:8', 'src/e.c:9'];
  const h = harness({ graphql: api.graphql, ctx: { previousState: previousWith(at.map((l) => finding(l, false))) } });
  await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: at.map((l) => finding(l, true)) }) });
  assert.deepEqual(h.resolveCalls, [{ ids: ['author-reply', 'alone'] }]);
});

test('a run without a grant, or a resolver that resolves less than it was sent, says so in the log', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const previousState = previousWith([finding('src/server.c:10', false)]);
    const fixedNow = state({ status: 'ready_for_human_review', findings: [finding('src/server.c:10', true)] });
    const ungranted = harness({ graphql: threadsApi([[thread('fixed')]]).graphql, noResolver: true, ctx: { previousState } });
    const result = JSON.parse(await ungranted.skip.invoke({ reason: 'r', state: fixedNow }));
    assert.equal(result.ok, true);
    assert.equal(result.threads_resolved, undefined);
    const refused = harness({ graphql: threadsApi([[thread('fixed')]]).graphql, resolve: async () => [], ctx: { previousState } });
    await refused.skip.invoke({ reason: 'r', state: fixedNow });
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => w.includes('this run has no resolve grant, so threads of fixed findings stay open')));
  assert.ok(warnings.some((w) => w.includes('the thread resolver resolved 0 of 1 thread(s)')));
});

test('a thread is not resolved for a finding that belongs to another thread', async () => {
  const run = async (threads, before, after) => {
    const h = harness({ graphql: threadsApi([threads]).graphql, ctx: { previousState: previousWith(before) } });
    await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: after }) });
    return h.resolveCalls.flatMap((c) => c.ids);
  };
  const minor = (location, resolved) => finding(location, resolved, false);
  // T moved onto the line U was posted on; U's finding is fixed, T's was dropped.
  assert.deepEqual(await run(
    [thread('T', { path: 'src/a.c', originalLine: 90, line: 100 }), thread('U', { path: 'src/a.c', originalLine: 100, line: 100 })],
    [finding('src/a.c:100', false), finding('src/a.c:90', false)],
    [finding('src/a.c:100', true)],
  ), ['U']);
  // An inner thread's open finding does not block the fixed multi-line thread around it.
  assert.deepEqual(await run(
    [thread('W', { path: 'src/a.c', originalStartLine: 100, originalLine: 110, line: 110 }), thread('I', { path: 'src/a.c', originalLine: 105, line: 105 })],
    [finding('src/a.c:110', false), minor('src/a.c:105', false)],
    [finding('src/a.c:110', true), minor('src/a.c:105', false)],
  ), ['W']);
  // Two fixed findings inside a multi-line thread, neither on its last line: which one it is about is unclear.
  assert.deepEqual(await run(
    [thread('W', { path: 'src/a.c', originalStartLine: 100, originalLine: 110, line: 110 })],
    [finding('src/a.c:102', false), finding('src/a.c:105', false)],
    [finding('src/a.c:102', true), finding('src/a.c:105', true)],
  ), []);
});

test('a thread a person reopened is not resolved again by a later run', async () => {
  const api = threadsApi([[thread('reopened')]]);
  const h = harness({ graphql: api.graphql, ctx: { previousState: previousWith([finding('src/server.c:10', true)]) } });
  const result = JSON.parse(await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: [finding('src/server.c:10', true)] }) }));
  assert.deepEqual(h.resolveCalls, []);
  assert.deepEqual(api.cursors, [], 'nothing changed, so no thread is read');
  assert.equal(result.threads_resolved, undefined);
});

test('post_review resolves fixed threads too, page by page', async () => {
  const api = threadsApi([[thread('page-1', { line: 99, originalLine: 99 })], [thread('page-2')]]);
  const previousState = previousWith([finding('src/server.c:10', false)]);
  const h = harness({ graphql: api.graphql, ctx: { previousState } });
  const result = JSON.parse(await h.post.invoke({
    body: '',
    comments: [{ path: 'src/a.c', line: 5, body: 'Still leaks.' }],
    state: state({ findings: [finding('src/server.c:10', true), finding('src/a.c:5', false)] }),
  }));
  assert.deepEqual(api.cursors, [null, '1']);
  assert.deepEqual(h.resolveCalls, [{ ids: ['page-2'] }]);
  assert.equal(result.threads_resolved, 1);
});

test('no thread is read or resolved when no finding went from open to fixed, or when the state did not reach GitHub', async () => {
  const api = threadsApi([[thread('fixed')]]);
  const fixedNow = state({ findings: [finding('src/server.c:10', true), finding('src/a.c:5', false)] });

  const first = harness({ graphql: api.graphql, ctx: { previousState: null } });
  await first.skip.invoke({ reason: 'r', state: fixedNow });
  const stillOpen = harness({ graphql: api.graphql, ctx: { previousState: previousWith([finding('src/server.c:10', false)]) } });
  await stillOpen.skip.invoke({ reason: 'r', state: state({ findings: [finding('src/server.c:10', false), finding('', true)] }) });
  const failed = harness({
    graphql: api.graphql,
    ctx: { previousState: previousWith([finding('src/server.c:10', false)]) },
    stateWrite: async () => { throw new Error('GitHub 502'); },
  });
  await failed.skip.invoke({ reason: 'r', state: fixedNow });

  assert.deepEqual(api.cursors, []);
  assert.deepEqual([...first.resolveCalls, ...stillOpen.resolveCalls, ...failed.resolveCalls], []);
});

test('a GitHub or thread resolver error while resolving threads does not fail the review', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(line);
  const previousState = previousWith([finding('src/server.c:10', false)]);
  const fixedNow = state({ findings: [finding('src/server.c:10', true), finding('src/a.c:5', false)] });
  try {
    const listing = harness({ graphql: async () => { throw new Error('secondary rate limit'); }, ctx: { previousState } });
    const resolver = harness({
      graphql: threadsApi([[thread('fixed')]]).graphql,
      resolve: async () => { throw new Error('thread resolver failed (Unhandled)'); },
      ctx: { previousState },
    });
    for (const h of [listing, resolver]) {
      const result = JSON.parse(await h.skip.invoke({ reason: 'r', state: fixedNow }));
      assert.equal(result.ok, true);
      assert.equal(result.threads_resolved, undefined);
      assert.deepEqual(h.terminal.map((t) => t.tool), ['skip_review']);
    }
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => w.includes('[review-threads] resolving fixed threads failed after 0 of 0: secondary rate limit')));
  assert.ok(warnings.some((w) => w.includes('[review-threads] resolving fixed threads failed after 0 of 1: thread resolver failed')));
});

test('a finding on any line of a multi-line comment names its thread', async () => {
  const api = threadsApi([[
    thread('start', { path: 'src/a.c', line: 185, originalStartLine: 183, originalLine: 185 }),
    thread('middle', { path: 'src/b.c', line: 2472, originalStartLine: 2468, originalLine: 2472 }),
    thread('end', { path: 'src/c.c', line: 9, originalStartLine: 5, originalLine: 9 }),
    thread('outside', { path: 'src/d.c', line: 22, originalStartLine: 20, originalLine: 22 }),
  ]]);
  const at = ['src/a.c:183', 'src/b.c:2471', 'src/c.c:9', 'src/d.c:19'];
  const h = harness({ graphql: api.graphql, ctx: { previousState: previousWith(at.map((l) => finding(l, false))) } });
  await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: at.map((l) => finding(l, true)) }) });
  assert.deepEqual(h.resolveCalls, [{ ids: ['start', 'middle', 'end'] }]);
});

test('a multi-line thread is not resolved for another thread\'s finding inside its lines', async () => {
  const api = threadsApi([[
    thread('wide-reopened', { path: 'src/a.c', line: 110, originalStartLine: 100, originalLine: 110 }),
    thread('inside', { path: 'src/a.c', line: 105, originalLine: 105 }),
  ]]);
  const previousState = previousWith([finding('src/a.c:110', true), finding('src/a.c:105', false)]);
  const h = harness({ graphql: api.graphql, ctx: { previousState } });
  await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: [finding('src/a.c:110', true), finding('src/a.c:105', true)] }) });
  assert.deepEqual(h.resolveCalls, [{ ids: ['inside'] }]);
});

test('reopened threads and still-open findings stay put however the lines line up', async () => {
  const run = async (threads, before, after) => {
    const h = harness({ graphql: threadsApi([threads]).graphql, ctx: { previousState: previousWith(before) } });
    await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: after }) });
    return h.resolveCalls.flatMap((c) => c.ids);
  };
  const wide = (id, extra = {}) => thread(id, { path: 'src/a.c', originalStartLine: 100, originalLine: 110, line: 110, ...extra });
  const inside = thread('inside', { path: 'src/a.c', originalLine: 105, line: 105 });
  // Another thread's finding inside a reopened multi-line thread is dropped.
  assert.deepEqual(await run([wide('wide'), inside], [finding('src/a.c:110', true), finding('src/a.c:105', false)], [finding('src/a.c:110', true)]), []);
  // The reopened thread's finding is on its start line; another thread's finding inside it is fixed.
  assert.deepEqual(await run([wide('wide'), inside], [finding('src/a.c:100', true), finding('src/a.c:105', false)], [finding('src/a.c:100', true), finding('src/a.c:105', true)]), ['inside']);
  // A reopened thread moved from line 10 to 12; a finding on line 12 is dropped.
  const moved = thread('moved', { originalLine: 10, line: 12 });
  assert.deepEqual(await run([moved], [finding('src/server.c:10', true), finding('src/server.c:12', false)], [finding('src/server.c:10', true)]), []);
  // A thread moved up, its finding moved with it and still open; another thread's finding inside it is fixed.
  const up = thread('up', { path: 'src/u.c', originalStartLine: 316, originalLine: 328, line: 287 });
  const z = thread('z', { path: 'src/u.c', originalLine: 320, line: 279 });
  const zFinding = (resolved) => ({ ...finding('src/u.c:320', resolved), blocking: false });
  assert.deepEqual(await run([up, z], [finding('src/u.c:328', false), zFinding(false)], [{ ...finding('src/u.c:287', false), blocking: false }, zFinding(true)]), ['z']);
});

test('a moved multi-line thread resolves when its finding is fixed, whatever is open past its lines', async () => {
  const w = thread('w', { path: 'src/w.c', originalStartLine: 2130, originalLine: 2141, line: 2163 });
  const h = harness({
    graphql: threadsApi([[w]]).graphql,
    ctx: { previousState: previousWith([finding('src/w.c:2141', false), finding('src/w.c:2150', false)]) },
  });
  await h.skip.invoke({ reason: 'r', state: state({ findings: [finding('src/w.c:2141', true), finding('src/w.c:2150', false)] }) });
  assert.deepEqual(h.resolveCalls, [{ ids: ['w'] }]);
});

test('a reopened thread stays open when another fixed finding names the line it is on now', async () => {
  const api = threadsApi([[
    thread('fixed-now', { path: 'src/a.c', originalLine: 100, line: 110 }),
    thread('reopened', { path: 'src/a.c', originalLine: 90, line: 100 }),
  ]]);
  const previousState = previousWith([finding('src/a.c:100', false), finding('src/a.c:90', true)]);
  const h = harness({ graphql: api.graphql, ctx: { previousState } });
  await h.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: [finding('src/a.c:100', true), finding('src/a.c:90', true)] }) });
  assert.deepEqual(h.resolveCalls, [{ ids: ['fixed-now'] }]);
});

test('a finding moved from the line its comment was posted on to the line it is on now still resolves its thread', async () => {
  const api = threadsApi([[thread('moved', { path: 'src/networking.c', originalLine: 4778, line: 4790 })]]);
  const previousState = previousWith([finding('src/networking.c:4778', false)]);

  const moved = harness({ graphql: api.graphql, ctx: { previousState } });
  await moved.skip.invoke({ reason: 'r', state: state({ status: 'ready_for_human_review', findings: [finding('src/networking.c:4790', true)] }) });
  assert.deepEqual(moved.resolveCalls, [{ ids: ['moved'] }]);

  // The old entry is still open beside a new resolved one: the finding is not fixed.
  const kept = harness({ graphql: api.graphql, ctx: { previousState } });
  await kept.skip.invoke({ reason: 'r', state: state({ findings: [finding('src/networking.c:4778', false), finding('src/networking.c:4790', true)] }) });
  assert.deepEqual(kept.resolveCalls, []);
});

test('post_review does not resolve the threads it has just posted', async () => {
  // createReview in the harness returns review id 1 for the first review.
  const api = threadsApi([[
    thread('old', { path: 'src/a.c', line: 10, originalLine: 10 }),
    thread('new', { path: 'src/a.c', line: 10, originalStartLine: 8, originalLine: 10, review: 1 }),
  ]]);
  const h = harness({ graphql: api.graphql, ctx: { previousState: previousWith([finding('src/a.c:10', false)]) } });
  await h.post.invoke({
    body: '',
    comments: [{ path: 'src/a.c', start_line: 8, line: 10, body: 'The fix brings a new bug.' }],
    state: state({ findings: [finding('src/a.c:10', true), finding('src/a.c:8-10', false)] }),
  });
  assert.deepEqual(h.resolveCalls, [{ ids: ['old'] }]);
});

/** GraphQL for the review lookup: the token's account is the bot. */
const viewerApi = async (query) => {
  if (query.includes('viewer')) return { viewer: { databaseId: BOT_ID } };
  throw new Error(`unexpected query ${query}`);
};

const posted = (overrides = {}) => ({
  id: 77, user: { id: BOT_ID }, commit_id: 'abc123', submitted_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  html_url: 'https://github.com/r/77', ...overrides,
});

test('a review GitHub answered 5xx for, or did not answer, is looked for before it is posted again', async () => {
  for (const failure of [
    Object.assign(new Error('Server Error'), { status: 502, response: { data: {} } }),
    Object.assign(new Error('The operation was aborted due to timeout'), { status: 500 }),
  ]) {
    let calls = 0;
    const h = harness({
      createReview: async () => { calls++; throw failure; },
      graphql: viewerApi,
      listReviews: async () => [
        posted({ id: 70, user: { id: 999 } }),
        posted({ id: 71, commit_id: 'old' }),
        posted({ id: 72, submitted_at: '2020-01-01T00:00:00Z' }),
        posted(),
      ],
    });
    const failed = await h.post.invoke({ body: '', comments: [comment], state: state() });
    assert.match(failed, /^ERROR: GitHub (answered 502|did not answer) \(.+\), so the review may have been posted anyway\. Call post_review again with the same input/);
    assert.doesNotMatch(failed, /nothing was posted/);
    assert.equal(h.terminal.length, 0);

    const result = JSON.parse(await h.post.invoke({ body: '', comments: [comment], state: state() }));
    assert.equal(calls, 1, 'not posted twice');
    assert.equal(result.review_id, 77);
    assert.equal(result.url, 'https://github.com/r/77');
    assert.equal(h.stateBodies.length, 1);
    assert.deepEqual(h.terminal.map((t) => t.tool), ['post_review']);
  }
});

test('another run\'s review of the same head is not taken for the one that got no answer', async () => {
  let fail = true;
  let looked = 0;
  const reviews = [];
  const h = harness({
    createReview: async (args) => {
      if (fail) throw Object.assign(new Error('Server Error'), { status: 502, response: { data: {} } });
      reviews.push(args);
      return { data: { id: 6, html_url: 'https://github.com/r/6' } };
    },
    graphql: viewerApi,
    listReviews: async () => { looked++; return [posted({ id: 500 })]; },
    reviewComments: (id) => (id === 500 ? [{ path: 'src/other.c', body: 'From a mention run.' }] : []),
  });
  await h.post.invoke({ body: '', comments: [comment], state: state() });
  fail = false;
  const result = JSON.parse(await h.post.invoke({ body: '', comments: [comment], state: state() }));
  assert.equal(looked, 1, 'looked for it first');
  assert.equal(reviews.length, 1, 'this run\'s review is posted');
  assert.equal(result.review_id, 6);
});

test('a review that is not on the PR after a lost answer is posted on the next call', async () => {
  let fail = true;
  let looked = 0;
  const reviews = [];
  const h = harness({
    createReview: async (args) => {
      if (fail) throw Object.assign(new Error('Server Error'), { status: 504, response: { data: {} } });
      reviews.push(args);
      return { data: { id: 5, html_url: 'https://github.com/r/5' } };
    },
    graphql: viewerApi,
    listReviews: async () => { looked++; return [posted({ user: { id: 999 } })]; },
  });
  await h.post.invoke({ body: '', comments: [comment], state: state() });
  fail = false;
  const result = JSON.parse(await h.post.invoke({ body: '', comments: [comment], state: state() }));
  assert.equal(looked, 1, 'looked for it first');
  assert.equal(reviews.length, 1);
  assert.equal(result.review_id, 5);
});

test('a review submission that never left, or a failed lookup, posts nothing', async () => {
  const neverSent = harness({ createReview: async () => { throw new Error('token broker failed (Unhandled)'); } });
  assert.match(await neverSent.post.invoke({ body: '', comments: [comment], state: state() }), /^ERROR status=\?: nothing was posted\. token broker failed/);

  let calls = 0;
  const lookupFails = harness({
    createReview: async () => { calls++; throw Object.assign(new Error('Server Error'), { status: 502, response: { data: {} } }); },
    graphql: viewerApi,
    listReviews: async () => { throw new Error('secondary rate limit'); },
  });
  await lookupFails.post.invoke({ body: '', comments: [comment], state: state() });
  const second = await lookupFails.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(second, /^ERROR: nothing was posted\. An earlier post_review may have posted the review, and checking for it failed: secondary rate limit/);
  assert.equal(calls, 1);
  assert.equal(lookupFails.terminal.length, 0);
});

test('on mention runs a review found after a lost answer still gets the reply', async () => {
  const finished = [];
  const h = harness({
    createReview: async () => { throw Object.assign(new Error('Server Error'), { status: 502, response: { data: {} } }); },
    graphql: viewerApi,
    listReviews: async () => [posted()],
    statusComment: { finish: async (text) => { finished.push(text); }, note: () => {} },
  });
  await h.post.invoke({ body: 'Yes: buf leaks when read fails.', comments: [comment], state: state() });
  await h.post.invoke({ body: 'Yes: buf leaks when read fails.', comments: [comment], state: state() });
  assert.equal(finished.length, 1);
  assert.match(finished[0], /^Yes: buf leaks when read fails\./);
});

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const OLD = '1111111111222222222233333333334444444444';
const headsOf = (body) => JSON.parse(body.split('\n').at(-1).replace('<!-- valkey-reviewer:heads ', '').replace(' -->', ''));
const headsComment = (heads) => ({ id: 5, body: `old\n<!-- valkey-reviewer:heads ${JSON.stringify(heads)} -->` });

test('the state records the head and base a full review last covered', async () => {
  const previousState = headsComment({ head: OLD, base: 'unstable', full_review: OLD, full_review_base: 'unstable' });

  const automatic = harness({ ctx: { headSha: HEAD, trigger: 'push', previousState } });
  await automatic.skip.invoke({ reason: 'r', state: state() });
  assert.deepEqual(headsOf(automatic.stateBodies[0]), { head: HEAD, base: 'unstable', full_review: HEAD, full_review_base: 'unstable', open_locations: ['src/server.c:10'] });
  assert.doesNotMatch(automatic.stateBodies[0], /partial/);

  const focused = harness({ ctx: { headSha: HEAD, trigger: null, previousState } });
  await focused.skip.invoke({ reason: 'r', state: state() });
  assert.deepEqual(headsOf(focused.stateBodies[0]), { head: HEAD, base: 'unstable', full_review: OLD, full_review_base: 'unstable', open_locations: ['src/server.c:10'] });
  assert.match(focused.stateBodies[0], /after a partial review; the last full review was at 1111111111\./);

  const summonedFull = harness({ ctx: { headSha: HEAD, trigger: null, previousState } });
  await summonedFull.post.invoke({ body: 'Reviewed it all.', comments: [], state: state(), full_review: true });
  assert.equal(headsOf(summonedFull.stateBodies[0]).full_review, HEAD);

  const first = harness({ ctx: { headSha: HEAD, trigger: null, previousState: null } });
  await first.skip.invoke({ reason: 'r', state: state(), full_review: false });
  assert.deepEqual(headsOf(first.stateBodies[0]), { head: HEAD, base: 'unstable', full_review: null, full_review_base: null, open_locations: ['src/server.c:10'] });
  assert.match(first.stateBodies[0], /no full review has run yet/);
});

test('a focused run after a new base does not pass for a full review against it', async () => {
  const previousState = headsComment({ head: HEAD, base: 'unstable', full_review: HEAD, full_review_base: 'unstable' });
  const h = harness({ ctx: { headSha: HEAD, baseRef: '9.0', trigger: null, previousState } });
  await h.skip.invoke({ reason: 'r', state: state() });
  assert.deepEqual(headsOf(h.stateBodies[0]), { head: HEAD, base: '9.0', full_review: HEAD, full_review_base: 'unstable', open_locations: ['src/server.c:10'] });
  assert.match(h.stateBodies[0], /after a partial review; the last full review was at abcdef0123 against `unstable`\./);

  const automatic = harness({ ctx: { headSha: HEAD, baseRef: '9.0', trigger: 'base_changed', previousState } });
  await automatic.skip.invoke({ reason: 'r', state: state() });
  assert.deepEqual(headsOf(automatic.stateBodies[0]), { head: HEAD, base: '9.0', full_review: HEAD, full_review_base: '9.0', open_locations: ['src/server.c:10'] });
});

test('an automatic review the call limit stopped, or the model says it did not finish, is recorded as partial', async () => {
  const previousState = headsComment({ head: OLD, base: 'unstable', full_review: OLD, full_review_base: 'unstable' });
  const stopped = harness({ ctx: { headSha: HEAD, trigger: 'push', previousState }, callLimitReached: () => true });
  await stopped.skip.invoke({ reason: 'r', state: state(), full_review: true });
  assert.equal(headsOf(stopped.stateBodies[0]).full_review, OLD, 'the runtime knows better than the model');
  assert.match(stopped.stateBodies[0], /after a partial review; the last full review was at 1111111111\./);

  const unfinished = harness({ ctx: { headSha: HEAD, trigger: 'push', previousState }, callLimitReached: () => false });
  await unfinished.skip.invoke({ reason: 'r', state: state(), full_review: false });
  assert.equal(headsOf(unfinished.stateBodies[0]).full_review, OLD);
});
