import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeGitHub } from './support/fakes.mjs';

const { createThreadResolver } = await import('../src/resolver.ts');
const { grantKey } = await import('../src/resolve-grant.ts');

const REPO = 'example-org/valkey';
const INSTALLATION = 42;
const GRANT = 'g'.repeat(43);
const NOW = Date.parse('2026-10-31T10:00:00Z');
const installed = (id = INSTALLATION, login = 'example-org') => ({ status: 200, json: { id, account: { login } } });
const grantFor = (overrides = {}) => ({ repo: REPO, prNumber: 5, installationId: INSTALLATION, expiresAt: NOW / 1000 + 3600, ...overrides });

const APP = { __typename: 'Bot', login: 'review-bot' };
const user = (login) => ({ __typename: 'User', login });

/** A thread as the read returns it, on a pull request `contributor` opened. `total` is how many comments it has in all. */
const thread = (id, { resolved = false, number = 5, state = 'OPEN', repo = REPO, author = APP, replies = [], total } = {}) => {
  const nodes = [{ author }, ...replies.map((a) => ({ author: a }))];
  return {
    id, isResolved: resolved,
    pullRequest: { number, state, author: { login: 'contributor' }, repository: { nameWithOwner: repo } },
    comments: { totalCount: total ?? nodes.length, nodes },
  };
};

/** GraphQL that reads `nodes` and resolves every thread the mutation names. */
function threadsGraphql(nodes, mutations = []) {
  return (body) => {
    if (body.query.startsWith('query')) return { data: { nodes } };
    mutations.push(body);
    return { data: Object.fromEntries(Object.entries(body.variables).map(([alias, id]) => [alias, { thread: { id, isResolved: true } }])) };
  };
}

function setup({
  grants = { [grantKey(GRANT)]: grantFor() },
  github = { [`GET repos/${REPO}/installation`]: installed(), 'GET app': { status: 200, json: { slug: 'review-bot' } } },
  graphql = () => { throw new Error('unexpected GraphQL call'); },
  issueError,
} = {}) {
  const issued = [];
  const logs = [];
  const read = [];
  const api = fakeGitHub(github);
  const gql = fakeGitHub({ 'POST graphql': (body) => ({ status: 200, json: graphql(body) }) });
  const resolver = createThreadResolver({
    readGrant: async (key) => { read.push(key); return grants[key]; },
    appApi: async () => api,
    issueToken: async (request) => {
      issued.push(request);
      if (issueError) throw issueError;
      return { token: 'ghs_test', expiresAt: '2026-10-31T11:00:00Z' };
    },
    installationApi: () => gql,
    now: () => NOW,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });
  return { resolver, issued, logs, read, api };
}

test('resolves only the App\'s open threads on the grant\'s pull request that only the App and the author commented in, with a token it keeps', async () => {
  const mutations = [];
  const nodes = [
    thread('T_ok'),
    thread('T_done', { resolved: true }),
    thread('T_other_pr', { number: 6 }),
    thread('T_closed', { state: 'MERGED' }),
    thread('T_other_repo', { repo: 'example-org/valkey-glide' }),
    thread('T_person', { author: { __typename: 'User', login: 'review-bot' } }),
    thread('T_other_bot', { author: { __typename: 'Bot', login: 'coderabbitai' } }),
    null,
    thread('T_author_reply', { replies: [user('Contributor'), APP] }),
    thread('T_maintainer_reply', { replies: [user('maintainer')] }),
    thread('T_ghost_reply', { replies: [null] }),
    thread('T_other_bot_reply', { replies: [{ __typename: 'Bot', login: 'coderabbitai' }] }),
    thread('T_more_than_read', { total: 101 }),
  ];
  const { resolver, issued, logs, read } = setup({ graphql: threadsGraphql(nodes, mutations) });
  const ids = ['T_ok', 'T_done', 'T_other_pr', 'T_closed', 'T_other_repo', 'T_person', 'T_other_bot', 'T_unknown',
    'T_author_reply', 'T_maintainer_reply', 'T_ghost_reply', 'T_other_bot_reply', 'T_more_than_read'];
  const result = await resolver({ grant: GRANT, thread_ids: ids });
  assert.deepEqual(result, { resolved: ['T_ok', 'T_author_reply'] });
  assert.equal('token' in result, false);
  assert.deepEqual(read, [grantKey(GRANT)], 'the grant is looked up by its hash');
  assert.deepEqual(issued, [{
    installationId: INSTALLATION,
    repositoryNames: ['valkey'],
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  }]);
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].variables, { t0: 'T_ok', t1: 'T_author_reply' });
  assert.match(mutations[0].query, /t0: resolveReviewThread\(input: \{ threadId: \$t0 \}\)/);
  assert.match(logs.join('\n'), /11 of 13 thread\(s\) are not this App's open threads there with comments by the App and the author only/);
});

test('the caller cannot choose the repository or the pull request: they come from the grant', async () => {
  const mutations = [];
  const { resolver, issued } = setup({ graphql: threadsGraphql([thread('T_six', { number: 6 })], mutations) });
  // Fields a caller adds are ignored; the grant names pull request 5.
  const result = await resolver({ grant: GRANT, thread_ids: ['T_six'], repo: 'example-org/valkey-glide', pull_number: 6, installation_id: 7 });
  assert.deepEqual(result, { resolved: [] });
  assert.equal(issued[0].installationId, INSTALLATION);
  assert.deepEqual(issued[0].repositoryNames, ['valkey']);
  assert.equal(mutations.length, 0);
});

test('refuses a missing, unknown or expired grant, and bad thread ids, before any GitHub call', async () => {
  const { resolver, issued, api } = setup({ grants: { [grantKey(GRANT)]: grantFor({ expiresAt: NOW / 1000 - 1 }) } });
  assert.deepEqual(await resolver({ grant: GRANT, thread_ids: ['T'] }), { error: 'no valid grant' });
  assert.deepEqual(await resolver({ grant: 'h'.repeat(43), thread_ids: ['T'] }), { error: 'no valid grant' });
  for (const grant of [undefined, '', 'short', 'x'.repeat(201), 7]) {
    assert.deepEqual(await resolver({ grant, thread_ids: ['T'] }), { error: 'invalid grant' });
  }
  for (const thread_ids of [undefined, [], 'T', [1], [''], ['x'.repeat(201)], Array.from({ length: 51 }, (_, i) => `T${i}`)]) {
    assert.match((await resolver({ grant: GRANT, thread_ids })).error, /thread_ids must hold 1 to 50 thread ids/);
  }
  assert.deepEqual(issued, []);
  assert.deepEqual(api.calls, []);
});

test('refuses a grant whose installation is not the App\'s on the repository', async () => {
  for (const github of [
    { [`GET repos/${REPO}/installation`]: installed(99) },
    { [`GET repos/${REPO}/installation`]: installed(INSTALLATION, 'someone-else') },
    { [`GET repos/${REPO}/installation`]: { status: 404, json: {} } },
  ]) {
    const { resolver, issued } = setup({ github });
    assert.match((await resolver({ grant: GRANT, thread_ids: ['T'] })).error, /is not the App's installation on example-org\/valkey/);
    assert.deepEqual(issued, []);
  }
});

test('an installation without Contents write gets an error, and nothing is resolved', async () => {
  const { resolver, logs } = setup({ issueError: new Error('The permissions requested are not granted to this installation.') });
  const result = await resolver({ grant: GRANT, thread_ids: ['T'] });
  assert.match(result.error, /^cannot resolve threads: no token with contents: write/);
  assert.match(logs.join('\n'), /no token with contents: write/);
});

test('a partial mutation failure reports only the threads GitHub resolved', async () => {
  const graphql = (body) => body.query.startsWith('query')
    ? { data: { nodes: [thread('T1'), thread('T2')] } }
    : { data: { t0: { thread: { id: 'T1', isResolved: true } }, t1: null }, errors: [{ message: 'Something went wrong' }] };
  const { resolver, logs } = setup({ graphql });
  assert.deepEqual(await resolver({ grant: GRANT, thread_ids: ['T1', 'T2'] }), { resolved: ['T1'] });
  assert.match(logs.join('\n'), /1 failed: Something went wrong/);
});
