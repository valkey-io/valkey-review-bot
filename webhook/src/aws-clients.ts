/**
 * Bound on one call from the receiver's SQS, DynamoDB and Secrets
 * Manager clients. The receiver has 30 seconds per delivery, and no
 * single call may use most of it; GitHub calls have the same bound
 * (GITHUB_TIMEOUT_MS in src/github.ts). Two attempts of a stalled call
 * then take 16 seconds, which leaves the rest of the delivery time to
 * finish. The SDK sets no timeout of its own. The second attempt can
 * repeat a write the first one made: the store's conditional writes
 * recognize their own (src/store.ts). A repeated SQS send cannot be
 * recognized: the queue keeps both messages, and the worker runs the
 * review twice. So the SQS client makes one attempt, and a send that
 * fails fails the delivery, which gives its key back for a redelivery.
 * The Bedrock client is left out; see src/receiver.ts.
 */
export const AWS_CALL_TIMEOUT_MS = 8_000;

/**
 * Client options for the receiver's AWS clients. `throwOnRequestTimeout`
 * makes newer SDKs fail the request; older ones apply `requestTimeout`
 * to an idle socket and fail it without the flag.
 */
export function awsClientConfig(timeoutMs: number = AWS_CALL_TIMEOUT_MS) {
  return {
    maxAttempts: 2,
    requestHandler: { connectionTimeout: timeoutMs, requestTimeout: timeoutMs, throwOnRequestTimeout: true },
  };
}

/** Client options for the receiver's SQS client: the same bound, one attempt. */
export function sqsClientConfig(timeoutMs: number = AWS_CALL_TIMEOUT_MS) {
  return { ...awsClientConfig(timeoutMs), maxAttempts: 1 };
}
