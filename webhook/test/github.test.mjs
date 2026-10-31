import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { createAppAuth } from '@octokit/auth-app';

const {
  boundedRequest, createAppSecretSource, createInstallationTokens, fetchReviewComment, githubApi, parseAppSecret,
  RECEIVER_TOKEN_PERMISSIONS,
} = await import('../src/github.ts');

test('parseAppSecret reads the three fields', () => {
  assert.deepEqual(parseAppSecret(JSON.stringify({ webhook_secret: 'w', private_key: 'k', app_id: 123456 })), {
    webhookSecret: 'w', privateKey: 'k', appId: '123456',
  });
  assert.deepEqual(parseAppSecret('{}'), {});
});

test('a malformed secret is reported without any of its content', () => {
  const secret = '{"webhook_secret":"hunter2-very-secret",';
  assert.throws(() => parseAppSecret(secret), (err) => {
    assert.equal(err.message, 'GitHub App secret is not valid JSON');
    assert.ok(!err.message.includes('hunter2'));
    return true;
  });
  assert.throws(() => parseAppSecret(undefined), /not valid JSON/);
  assert.throws(() => parseAppSecret('"just a string"'), /not a JSON object/);
});

test('the secret is cached for five minutes', async () => {
  let fetches = 0;
  let now = 0;
  const source = createAppSecretSource(async () => { fetches++; return JSON.stringify({ webhook_secret: `s${fetches}` }); }, () => now);
  assert.equal((await source.get()).webhookSecret, 's1');
  now = 4 * 60_000;
  assert.equal((await source.get()).webhookSecret, 's1');
  now = 5 * 60_000 + 1;
  assert.equal((await source.get()).webhookSecret, 's2');
  assert.equal(fetches, 2);
});

test('refresh refetches at most once a minute', async () => {
  let fetches = 0;
  let now = 0;
  const source = createAppSecretSource(async () => { fetches++; return JSON.stringify({ webhook_secret: `s${fetches}` }); }, () => now);
  await source.get();
  now = 30_000;
  assert.equal((await source.refresh()).webhookSecret, 's1', 'fetched 30 s ago: cached copy');
  now = 61_000;
  assert.equal((await source.refresh()).webhookSecret, 's2');
  assert.equal((await source.get()).webhookSecret, 's2', 'the refreshed copy is the cached one');
  assert.equal((await source.refresh()).webhookSecret, 's2');
  assert.equal(fetches, 2);
});

test('githubApi sends an authenticated JSON request with a timeout', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  };
  const api = githubApi('tok', fakeFetch);
  assert.deepEqual(await api('POST', 'repos/o/r/issues/1/comments', { body: 'hi' }), { status: 201, json: { id: 1 } });
  const { url, init } = requests[0];
  assert.equal(url, 'https://api.github.com/repos/o/r/issues/1/comments');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, '{"body":"hi"}');
  assert.ok(init.signal instanceof AbortSignal);
});

test('githubApi tolerates an empty body', async () => {
  const api = githubApi('tok', async () => new Response(null, { status: 204 }));
  assert.deepEqual(await api('GET', 'x'), { status: 204, json: {} });
});

test('fetchReviewComment returns the comment author, anchor and body', async () => {
  const api = async () => ({ status: 200, json: { body: 'b', user: { login: 'u' }, path: 'p.c', line: null, original_line: 3 } });
  assert.deepEqual(await fetchReviewComment(api, 'o/r', 1), { body: 'b', author: 'u', path: 'p.c', line: 3 });
  assert.equal(await fetchReviewComment(async () => ({ status: 404, json: {} }), 'o/r', 1), undefined);
});

test('receiver tokens ask for exactly the permissions the receiver uses, never contents', async () => {
  const requests = [];
  const secrets = { get: async () => ({ appId: '1', privateKey: 'k' }), refresh: async () => ({ appId: '1', privateKey: 'k' }) };
  const tokens = createInstallationTokens(secrets, async (r) => {
    requests.push(r);
    return { token: `t${requests.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  });
  assert.equal(await tokens(42), 't1');
  assert.equal(await tokens(42), 't1');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].permissions, { pull_requests: 'write', issues: 'read', metadata: 'read' });
  assert.equal(requests[0].installationId, 42);
  assert.equal('contents' in RECEIVER_TOKEN_PERMISSIONS, false);
});

test('githubApi fails a call whose body is cut off instead of reading it as empty', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id": 1'));
      controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    },
  });
  const api = githubApi('tok', async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(api('GET', 'repos/o/r/installation'), (err) => err.name === 'TimeoutError');
});

/** A TCP server that accepts every connection and never answers. */
async function blackHole(t) {
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the App token exchange gives up at the bound instead of holding the delivery', { timeout: 10_000 }, async (t) => {
  const url = await blackHole(t);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const auth = createAppAuth({ appId: 1, privateKey, installationId: 7, request: boundedRequest(200).defaults({ baseUrl: url }) });
  const started = Date.now();
  await assert.rejects(auth({ type: 'installation' }), (err) => err.status === 500 && /timeout/i.test(err.message));
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

const testKey = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** An HTTP server that answers the token exchange with `respond(res)`. */
async function tokenServer(t, respond) {
  const sockets = new Set();
  const server = createHttpServer((req, res) => respond(res));
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a token exchange whose body is cut off fails instead of returning no token', { timeout: 10_000 }, async (t) => {
  const privateKey = testKey();
  const partial = (res) => {
    res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
    res.write('{"token":"ghs_partial');
  };
  const stalls = await tokenServer(t, partial);
  const dropped = await tokenServer(t, (res) => { partial(res); setTimeout(() => res.socket.destroy(), 20); });
  for (const url of [stalls, dropped]) {
    const auth = createAppAuth({ appId: 1, privateKey, installationId: 7, request: boundedRequest(300).defaults({ baseUrl: url }) });
    await assert.rejects(auth({ type: 'installation' }));
  }
});

test('a token exchange with a whole body still returns its token', { timeout: 10_000 }, async (t) => {
  const url = await tokenServer(t, (res) => {
    res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ token: 'ghs_whole', expires_at: '2030-01-01T00:00:00Z', permissions: {}, repository_selection: 'all' }));
  });
  const auth = createAppAuth({ appId: 1, privateKey: testKey(), installationId: 7, request: boundedRequest(1000).defaults({ baseUrl: url }) });
  const result = await auth({ type: 'installation' });
  assert.equal(result.token, 'ghs_whole');
  assert.equal(result.expiresAt, '2030-01-01T00:00:00Z');
});
