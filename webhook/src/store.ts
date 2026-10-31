import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The receiver's DynamoDB table, keyed by "key". It holds these kinds of
 * item, all expired by the "ttl" attribute:
 *
 *   - delivery keys, one per piece of work, so a delivery that GitHub sends
 *     twice is handled once;
 *   - daily review counters, "budget#ROUTEID#YYYY-MM-DD" (UTC), which cap
 *     automatic reviews per route;
 *   - pull request counters, "autoreviews#OWNER/NAME#PR" (lowercased), which
 *     cap automatic reviews per pull request;
 *   - pending markers, "pending#OWNER/NAME#PR" (lowercased), held by an
 *     automatic review while it waits in the queue, and while it waits
 *     for another review of the pull request to finish. The worker
 *     removes the marker when it starts the review. A marker also notes
 *     when the receiver gave back the waiting review's round because the
 *     pull request left (closed, or back to draft) while it waited.
 */

export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

const DELIVERY_KEY_TTL_SECONDS = 24 * 3600;
const BUDGET_TTL_SECONDS = 3 * 24 * 3600;
/** Counted from the pull request's latest automatic review. */
const AUTO_REVIEW_TTL_SECONDS = 180 * 24 * 3600;
/**
 * How long a pending marker outlives its queue delay, or the worker's
 * latest extension, in case no worker removes it.
 */
const PENDING_TTL_SECONDS = 3600;

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

/**
 * An attribute of the item a failed condition found, for a call that set
 * ReturnValuesOnConditionCheckFailure. The document client does not
 * convert errors, so the value is still typed ({ S }, { N }).
 *
 * The SDK retries a call that timed out, and the first attempt may have
 * been applied. Its retry then fails its own condition, or passes it a
 * second time. Each conditional write whose retry would give a wrong
 * answer (a duplicate, a review already waiting, a cap reached, a round
 * given back twice or not at all) puts an id of the call in the item and
 * knows its own write by it. The review counters keep only the latest
 * take: a take of the same counter that lands between an attempt and its
 * retry still makes the retry count again.
 */
function failedItemValue(err: unknown, name: string): unknown {
  const v = (err as { Item?: Record<string, unknown> } | null)?.Item?.[name];
  if (v !== null && typeof v === 'object') {
    const typed = v as { S?: unknown; N?: unknown };
    if (typeof typed.S === 'string') return typed.S;
    if (typeof typed.N === 'string') return Number(typed.N);
  }
  return v;
}

export interface DeliveryStore {
  /** Records the key. False when it is already there: the work was already accepted. */
  claim(key: string, attributes?: Readonly<Record<string, string>>): Promise<boolean>;
  /**
   * Removes a claimed key after the work could not be handed on, so a
   * redelivery from the App settings is processed instead of being
   * dropped as a duplicate.
   */
  release(key: string): Promise<void>;
  /**
   * Takes one automatic review from the route's budget for the current
   * UTC day. False when the day's budget is used up.
   */
  takeReviewSlot(routeId: string, dailyBudget: number): Promise<boolean>;
  /**
   * Takes the pull request's next automatic review. Returns its number,
   * 1 for the first, or 0 when `cap` have been taken.
   */
  takeAutoReview(repo: string, prNumber: number, cap: number): Promise<number>;
  /**
   * Gives back an automatic review taken for a review that was not
   * queued, or for a waiting review that the runtime is going to skip.
   */
  returnAutoReview(repo: string, prNumber: number): Promise<void>;
  /**
   * Notes on the pull request's pending marker that the waiting review's
   * round is given back. True when this call made the note, and the
   * caller gives the round back; false when no review waits, or its
   * round was already given back. So a marker's round is given back at
   * most once, however often the pull request leaves.
   */
  markRoundGivenBack(repo: string, prNumber: number): Promise<boolean>;
  /**
   * Removes that note when an event joins the waiting review: the pull
   * request is back, so the review runs after all. True when there was a
   * note, and the caller takes the round again.
   */
  clearRoundGivenBack(repo: string, prNumber: number): Promise<boolean>;
  /**
   * Marks an automatic review as waiting in the queue for the pull
   * request. Returns the marker's id, or null while another review holds
   * the marker. The marker expires an hour after the delay.
   */
  markReviewPending(repo: string, prNumber: number, delaySeconds: number): Promise<string | null>;
  /** Removes the pull request's pending marker if it is still `markerId`. */
  clearReviewPending(repo: string, prNumber: number, markerId: string): Promise<boolean>;
  /**
   * True while an automatic review of the pull request waits: its
   * pending marker is there and has not expired. Read consistently.
   */
  hasPendingReview(repo: string, prNumber: number): Promise<boolean>;
}

/**
 * Releases a key while another error is already being handled. A failed
 * release is logged, not thrown, so it does not hide the first error.
 */
export async function releaseQuietly(release: (key: string) => Promise<void>, key: string): Promise<void> {
  try {
    await release(key);
  } catch (err) {
    console.error(`[store] could not release ${key}; a redelivery will be skipped as a duplicate`, err);
  }
}

export function budgetKey(routeId: string, now: Date): string {
  return `budget#${routeId}#${now.toISOString().slice(0, 10)}`;
}

/** GitHub repository names are case-insensitive. */
export function autoReviewKey(repo: string, prNumber: number): string {
  return `autoreviews#${repo.toLowerCase()}#${prNumber}`;
}

export function pendingReviewKey(repo: string, prNumber: number): string {
  return `pending#${repo.toLowerCase()}#${prNumber}`;
}

/**
 * Removes the pull request's pending marker, only while it is still
 * `markerId`, so a late or repeated call cannot remove the marker of a
 * later review. The receiver calls it when a review is not queued after
 * all, the worker when it starts the review. False when the marker was
 * not there.
 */
export async function clearPendingReview(
  ddb: DocumentClient,
  tableName: string,
  repo: string,
  prNumber: number,
  markerId: string,
): Promise<boolean> {
  try {
    await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { key: pendingReviewKey(repo, prNumber) },
      ConditionExpression: '#m = :m',
      ExpressionAttributeNames: { '#m': 'marker' },
      ExpressionAttributeValues: { ':m': markerId },
    }));
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * True while the pull request's pending marker is still `markerId`. The
 * worker removes its marker just before it starts the review, so a
 * message that finds its marker still there has never run. Expiry is not
 * checked: a marker that is still this one was not replaced by a later
 * review's.
 */
export async function holdsPendingReview(
  ddb: DocumentClient,
  tableName: string,
  repo: string,
  prNumber: number,
  markerId: string,
): Promise<boolean> {
  const resp = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { key: pendingReviewKey(repo, prNumber) },
    ConsistentRead: true,
  }));
  return (resp.Item as { marker?: unknown } | undefined)?.marker === markerId;
}

/**
 * Moves the expiry of the pull request's pending marker to an hour from
 * now, while it is still `markerId`. An automatic review that waits for
 * another review of the pull request keeps its marker this way, so later
 * events keep joining it. False when the marker is not there.
 */
export async function extendPendingReview(
  ddb: DocumentClient,
  tableName: string,
  repo: string,
  prNumber: number,
  markerId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { key: pendingReviewKey(repo, prNumber) },
      UpdateExpression: 'SET #ttl = :ttl',
      ConditionExpression: '#m = :m',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#m': 'marker' },
      ExpressionAttributeValues: { ':ttl': Math.floor(now.getTime() / 1000) + PENDING_TTL_SECONDS, ':m': markerId },
    }));
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

export function createDeliveryStore(ddb: DocumentClient, tableName: string, now: () => Date = () => new Date()): DeliveryStore {
  const epochSeconds = (): number => Math.floor(now().getTime() / 1000);
  return {
    async claim(key, attributes = {}) {
      const claimId = randomUUID();
      try {
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: { ...attributes, key, ttl: epochSeconds() + DELIVERY_KEY_TTL_SECONDS, receivedAt: now().toISOString(), claimId },
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return failedItemValue(err, 'claimId') === claimId;
        throw err;
      }
    },

    async release(key) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { key } }));
    },

    async takeReviewSlot(routeId, dailyBudget) {
      // The condition below always admits the first review of the day, so
      // a zero budget is decided here.
      if (dailyBudget <= 0) return false;
      const takeId = randomUUID();
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: budgetKey(routeId, now()) },
          UpdateExpression: 'SET #ttl = :ttl, #take = :take ADD #reviews :one',
          ConditionExpression: '(attribute_not_exists(#reviews) OR #reviews < :budget) AND (attribute_not_exists(#take) OR #take <> :take)',
          ExpressionAttributeNames: { '#reviews': 'reviews', '#ttl': 'ttl', '#take': 'lastTake' },
          ExpressionAttributeValues: { ':one': 1, ':budget': dailyBudget, ':ttl': epochSeconds() + BUDGET_TTL_SECONDS, ':take': takeId },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return failedItemValue(err, 'lastTake') === takeId;
        throw err;
      }
    },

    async takeAutoReview(repo, prNumber, cap) {
      if (cap <= 0) return 0;
      const takeId = randomUUID();
      let taken: unknown;
      try {
        const resp = await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: autoReviewKey(repo, prNumber) },
          UpdateExpression: 'SET #ttl = :ttl, #take = :take ADD #reviews :one',
          ConditionExpression: '(attribute_not_exists(#reviews) OR #reviews < :cap) AND (attribute_not_exists(#take) OR #take <> :take)',
          ExpressionAttributeNames: { '#reviews': 'reviews', '#ttl': 'ttl', '#take': 'lastTake' },
          ExpressionAttributeValues: { ':one': 1, ':cap': cap, ':ttl': epochSeconds() + AUTO_REVIEW_TTL_SECONDS, ':take': takeId },
          ReturnValues: 'UPDATED_NEW',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        taken = (resp.Attributes as { reviews?: unknown } | undefined)?.reviews;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        if (failedItemValue(err, 'lastTake') !== takeId) return 0;
        taken = failedItemValue(err, 'reviews');
      }
      if (typeof taken !== 'number') throw new Error(`no review count for ${autoReviewKey(repo, prNumber)}`);
      return taken;
    },

    async returnAutoReview(repo, prNumber) {
      const returnId = randomUUID();
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: autoReviewKey(repo, prNumber) },
          UpdateExpression: 'SET #return = :return ADD #reviews :minusOne',
          ConditionExpression: '#reviews > :zero AND (attribute_not_exists(#return) OR #return <> :return)',
          ExpressionAttributeNames: { '#reviews': 'reviews', '#return': 'lastReturn' },
          ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0, ':return': returnId },
        }));
      } catch (err) {
        // Nothing left to give back, or a retry of this call, which gave it back.
        if (isConditionFailure(err)) return;
        throw err;
      }
    },

    async markReviewPending(repo, prNumber, delaySeconds) {
      const marker = randomUUID();
      try {
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: {
            key: pendingReviewKey(repo, prNumber),
            marker,
            ttl: epochSeconds() + delaySeconds + PENDING_TTL_SECONDS,
            receivedAt: now().toISOString(),
          },
          // TTL deletes lazily, so an expired marker counts as gone.
          ConditionExpression: 'attribute_not_exists(#k) OR #ttl < :now',
          ExpressionAttributeNames: { '#k': 'key', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': epochSeconds() },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return marker;
      } catch (err) {
        if (isConditionFailure(err)) return failedItemValue(err, 'marker') === marker ? marker : null;
        throw err;
      }
    },

    clearReviewPending: (repo, prNumber, markerId) => clearPendingReview(ddb, tableName, repo, prNumber, markerId),

    async markRoundGivenBack(repo, prNumber) {
      // The note is the call's id, so a retry of this call finds its own note.
      const noteId = randomUUID();
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: pendingReviewKey(repo, prNumber) },
          UpdateExpression: 'SET #r = :note',
          // A marker that is there and has not expired, as hasPendingReview counts it.
          ConditionExpression: 'attribute_exists(#m) AND #ttl >= :now AND (attribute_not_exists(#r) OR #r = :note)',
          ExpressionAttributeNames: { '#m': 'marker', '#ttl': 'ttl', '#r': 'roundGivenBack' },
          ExpressionAttributeValues: { ':note': noteId, ':now': epochSeconds() },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async clearRoundGivenBack(repo, prNumber) {
      // The call leaves its id, so a retry of this call finds the note gone by its own hand.
      const clearId = randomUUID();
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: pendingReviewKey(repo, prNumber) },
          UpdateExpression: 'SET #c = :clear REMOVE #r',
          ConditionExpression: 'attribute_exists(#r) OR #c = :clear',
          ExpressionAttributeNames: { '#r': 'roundGivenBack', '#c': 'noteCleared' },
          ExpressionAttributeValues: { ':clear': clearId },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async hasPendingReview(repo, prNumber) {
      const resp = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { key: pendingReviewKey(repo, prNumber) },
        ConsistentRead: true,
      }));
      if (!resp.Item) return false;
      // Expired as markReviewPending counts it: TTL deletes lazily.
      const ttl = (resp.Item as { ttl?: unknown }).ttl;
      return !(typeof ttl === 'number' && ttl < epochSeconds());
    },
  };
}
