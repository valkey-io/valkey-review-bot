import assert from 'node:assert/strict';
import test from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import './support/ts-resolve.mjs';

const { createThreadResolver } = await import('../src/thread-resolver.ts');

/** Answers every Lambda call with `answer(input)`, recording the inputs. */
function stubLambda(t, answer) {
  const inputs = [];
  const original = LambdaClient.prototype.send;
  LambdaClient.prototype.send = async function (command) {
    inputs.push(command.input);
    return answer(command.input);
  };
  t.after(() => { LambdaClient.prototype.send = original; });
  return inputs;
}

const payloadOf = (input) => JSON.parse(Buffer.from(input.Payload).toString('utf8'));
const answer = (body) => ({ Payload: Buffer.from(JSON.stringify(body)) });

test('the client presents the run\'s grant and names only threads', async (t) => {
  const inputs = stubLambda(t, () => answer({ resolved: ['T1', 7, 'T2'] }));
  const resolver = createThreadResolver({ functionName: 'thread-resolver', grant: 'g'.repeat(43), region: 'us-east-1' });
  assert.deepEqual(await resolver.resolve(['T1', 'T2']), ['T1', 'T2']);
  assert.equal(inputs[0].FunctionName, 'thread-resolver');
  assert.deepEqual(payloadOf(inputs[0]), { grant: 'g'.repeat(43), thread_ids: ['T1', 'T2'] });
});

test('a refusal or a failed resolver throws, so the caller logs it', async (t) => {
  let reply = answer({ error: 'no valid grant' });
  stubLambda(t, () => reply);
  const resolver = createThreadResolver({ functionName: 'thread-resolver', grant: 'g'.repeat(43), region: 'us-east-1' });
  await assert.rejects(resolver.resolve(['T1']), /thread resolver refused: no valid grant/);
  reply = { FunctionError: 'Unhandled', Payload: Buffer.from('{}') };
  await assert.rejects(resolver.resolve(['T1']), /thread resolver failed \(Unhandled\)/);
  reply = answer({});
  await assert.rejects(resolver.resolve(['T1']), /thread resolver refused: no result returned/);
});
