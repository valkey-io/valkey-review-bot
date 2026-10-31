import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadReceiverConfig } from './config.js';
import { createDeliveryHandler } from './delivery.js';
import { awsClientConfig, sqsClientConfig } from './aws-clients.js';
import { createAppSecretSource, createInstallationTokens, githubApi } from './github.js';
import { createSafetyGate } from './mention.js';
import { sendMessageInput } from './send-message.js';
import { createDeliveryStore } from './store.js';

/**
 * Receiver Lambda behind the HTTP API. Wires the AWS clients and the
 * configuration into the delivery handler in src/delivery.ts, which has
 * the logic.
 */

const config = loadReceiverConfig(process.env);

const aws = awsClientConfig();
const sm = new SecretsManagerClient(aws);
const sqs = new SQSClient(sqsClientConfig());
const secrets = createAppSecretSource(async () =>
  (await sm.send(new GetSecretValueCommand({ SecretId: config.githubSecretArn }))).SecretString);
const installationToken = createInstallationTokens(secrets);

export const handler = createDeliveryHandler(config, {
  webhookSecret: async (refresh) => {
    const { webhookSecret } = await (refresh ? secrets.refresh() : secrets.get());
    if (!webhookSecret) throw new Error('GitHub App secret has no webhook_secret');
    return webhookSecret;
  },
  store: createDeliveryStore(DynamoDBDocumentClient.from(new DynamoDBClient(aws)), config.idempotencyTable),
  sendMessage: async (queueUrl, body, attributes, options) => {
    await sqs.send(new SendMessageCommand(sendMessageInput(queueUrl, body, attributes, options)));
  },
  github: async (installationId) => githubApi(await installationToken(installationId)),
  // Not `aws`: the Bedrock client's HTTP/2 handler ignores those bounds,
  // and its own options open a connection per call, so one stalled
  // connection cannot hold the calls after it. The gate bounds each call.
  approveInstruction: createSafetyGate({ client: new BedrockRuntimeClient({}), modelId: config.safetyModelId }),
});
