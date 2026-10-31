import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { boundedFetch, createOctokit } = await import('../src/github-auth.ts');

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

test('a GitHub request that gets no answer fails at the bound instead of holding the run', { timeout: 10_000 }, async (t) => {
  const url = await blackHole(t);
  const started = Date.now();
  await assert.rejects(boundedFetch(200)(`${url}/x`), (err) => err.name === 'TimeoutError');
  const octokit = createOctokit({ get: async () => 'token' }, 200);
  await assert.rejects(octokit.request(`GET ${url}/repos/o/r/pulls/1`));
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

test('a caller can still abort a bounded request', { timeout: 10_000 }, async (t) => {
  const url = await blackHole(t);
  const controller = new AbortController();
  const pending = boundedFetch(60_000)(`${url}/x`, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
});

/** An HTTP server: `handle(req, res)` answers, and every socket is closed when the test ends. */
async function httpServer(t, handle) {
  const sockets = new Set();
  const server = createHttpServer(handle);
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a body cut off by the bound fails the request instead of reading as an empty success', { timeout: 10_000 }, async (t) => {
  const url = await httpServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[{"id": 1}, ');
  });
  const octokit = createOctokit({ get: async () => 'token' }, 200);
  await assert.rejects(octokit.request(`GET ${url}/repos/o/r/pulls/1/files`), (err) => /timeout/i.test(err.message));
});

test('a bounded request still reads whole bodies, empty ones and the URL', { timeout: 10_000 }, async (t) => {
  const url = await httpServer(t, (req, res) => {
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 7 }));
  });
  const octokit = createOctokit({ get: async () => 'token' }, 2_000);
  const full = await octokit.request(`GET ${url}/item`);
  assert.deepEqual(full.data, { id: 7 });
  assert.equal(full.url, `${url}/item`);
  assert.equal((await octokit.request(`GET ${url}/empty`)).status, 204);
});
