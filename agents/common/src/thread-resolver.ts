import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/**
 * Resolves this App's review threads on the pull request under review,
 * through the thread resolver (webhook/src/thread-resolver.ts). GitHub
 * lets only a token with contents: write resolve a thread, and code from
 * the pull request can read the run's tokens, so the resolver keeps that
 * token. The run presents the grant its queue worker gave it. The grant
 * names the pull request, so the run names only threads.
 */
export interface ThreadResolver {
  /** Resolves these threads; returns the ids it resolved. */
  resolve(threadIds: readonly string[]): Promise<string[]>;
}

/**
 * Bound on one call. The resolver's own timeout is 45 seconds
 * (infra/lib/webhook-stack.ts); this covers that and a cold start.
 */
const RESOLVER_INVOKE_TIMEOUT_MS = 60_000;

export function createThreadResolver(opts: { functionName: string; grant: string; region: string }): ThreadResolver {
  const lambda = new LambdaClient({
    region: opts.region,
    requestHandler: {
      connectionTimeout: RESOLVER_INVOKE_TIMEOUT_MS,
      requestTimeout: RESOLVER_INVOKE_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
  return {
    async resolve(threadIds) {
      const resp = await lambda.send(new InvokeCommand({
        FunctionName: opts.functionName,
        Payload: Buffer.from(JSON.stringify({ grant: opts.grant, thread_ids: threadIds })),
      }));
      if (resp.FunctionError) throw new Error(`thread resolver failed (${resp.FunctionError})`);
      const out = JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString('utf8')) as { resolved?: unknown; error?: string };
      if (!Array.isArray(out.resolved)) throw new Error(`thread resolver refused: ${out.error ?? 'no result returned'}`);
      return out.resolved.filter((id): id is string => typeof id === 'string');
    },
  };
}
