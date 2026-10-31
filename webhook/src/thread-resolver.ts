import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createAppAuth } from '@octokit/auth-app';
import { boundedRequest, createAppSecretSource, githubApi } from './github.js';
import { grantFromItem, type ResolveGrant } from './resolve-grant.js';
import { createThreadResolver } from './resolver.js';

/**
 * Thread resolver for the reviewer runtimes. A review calls it to resolve
 * its own review threads whose findings it found fixed. The checks are in
 * src/resolver.ts.
 *
 * Input:  { grant: string, thread_ids: string[] }
 * Output: { resolved: [thread ids] } or { error }
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const SECRET_ARN = required('GITHUB_SECRET_ARN');
const TABLE = required('IDEMPOTENCY_TABLE');

const sm = new SecretsManagerClient({});
const secrets = createAppSecretSource(async () => (await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))).SecretString);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function appAuth() {
  const { appId, privateKey } = await secrets.get();
  if (!appId || !privateKey) throw new Error('GitHub App secret has no private_key or app_id');
  return createAppAuth({ appId, privateKey, request: boundedRequest() });
}

/** The grant item src/invoker.ts writes, or undefined when it is missing or malformed. */
async function readGrant(key: string): Promise<ResolveGrant | undefined> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { key }, ConsistentRead: true }));
  return grantFromItem(Item);
}

export const handler = createThreadResolver({
  readGrant,
  appApi: async () => githubApi((await (await appAuth())({ type: 'app' })).token),
  issueToken: async (request) => (await appAuth())({ type: 'installation', ...request }),
  installationApi: (token) => githubApi(token),
});
