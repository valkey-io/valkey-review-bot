import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const { awsClientConfig, sqsClientConfig } = await import('../src/aws-clients.ts');

/** A TCP server that accepts every connection and never answers. `connections` counts them. */
async function blackHole(t) {
  const sockets = new Set();
  let connections = 0;
  const server = createServer((socket) => { connections++; sockets.add(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, connections: () => connections };
}

function sqsAt(url, config) {
  return new SQSClient({
    ...config,
    endpoint: url,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

test('an AWS call that gets no answer fails at the bound after one retry instead of holding the delivery', { timeout: 15_000 }, async (t) => {
  const { url, connections } = await blackHole(t);
  const started = Date.now();
  await assert.rejects(
    sqsAt(url, awsClientConfig(200)).send(new SendMessageCommand({ QueueUrl: `${url}/000000000000/q`, MessageBody: '{}' })),
    (err) => err.name === 'TimeoutError' && err.$metadata?.attempts === 2,
  );
  // Two attempts of 200 ms, and the SDK's backoff between them.
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  assert.equal(connections(), 2);
});

test('the receiver\'s SQS client sends a message that gets no answer once', { timeout: 15_000 }, async (t) => {
  const { url, connections } = await blackHole(t);
  await assert.rejects(
    sqsAt(url, sqsClientConfig(200)).send(new SendMessageCommand({ QueueUrl: `${url}/000000000000/q`, MessageBody: '{}' })),
    (err) => err.name === 'TimeoutError' && err.$metadata?.attempts === 1,
  );
  assert.equal(connections(), 1, 'a second send would queue the review twice');
});
