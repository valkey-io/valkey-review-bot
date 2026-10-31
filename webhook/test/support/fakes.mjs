/**
 * Stand-ins for the AWS and GitHub clients the webhook code talks to.
 */

export function conditionFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/** An item as DynamoDB returns it in an error: typed values, which the document client leaves as they are. */
function typedItem(item) {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k,
    typeof v === 'number' ? { N: String(v) } : typeof v === 'boolean' ? { BOOL: v } : { S: String(v) }]));
}

/** The failure for `input`, carrying the item it found when the call asked for it. */
function conditionFailedOn(input, item) {
  const err = conditionFailed();
  if (input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD' && item) err.Item = typedItem(item);
  return err;
}

/**
 * An in-memory DynamoDB document client for the receiver's table. It
 * understands the commands src/store.ts sends, including the conditions
 * on the review counters, and records every call. Any other condition
 * fails the test.
 */
export function fakeDdb() {
  const items = new Map();
  const calls = [];
  return {
    items,
    calls,
    async send(command) {
      const op = command.constructor.name;
      const input = command.input;
      calls.push({ op, input });
      if (op === 'PutCommand') {
        const existing = items.get(input.Item.key);
        if (input.ConditionExpression === 'attribute_not_exists(#k)') {
          if (existing) throw conditionFailedOn(input, existing);
        } else if (input.ConditionExpression === 'attribute_not_exists(#k) OR #ttl < :now') {
          if (existing && !(existing.ttl < input.ExpressionAttributeValues[':now'])) throw conditionFailedOn(input, existing);
        } else {
          throw new Error(`unexpected condition ${input.ConditionExpression}`);
        }
        items.set(input.Item.key, { ...input.Item });
        return {};
      }
      if (op === 'GetCommand') {
        const item = items.get(input.Key.key);
        return item ? { Item: { ...item } } : {};
      }
      if (op === 'DeleteCommand') {
        if (input.ConditionExpression === '#m = :m') {
          if (items.get(input.Key.key)?.marker !== input.ExpressionAttributeValues[':m']) throw conditionFailed();
        } else if (input.ConditionExpression !== undefined) {
          throw new Error(`unexpected condition ${input.ConditionExpression}`);
        }
        items.delete(input.Key.key);
        return {};
      }
      if (op === 'UpdateCommand' && input.ConditionExpression === '#m = :m') {
        const item = items.get(input.Key.key);
        if (item?.marker !== input.ExpressionAttributeValues[':m']) throw conditionFailed();
        if (input.UpdateExpression !== 'SET #ttl = :ttl') throw new Error(`unexpected update ${input.UpdateExpression}`);
        item.ttl = input.ExpressionAttributeValues[':ttl'];
        return {};
      }
      if (op === 'UpdateCommand' && input.ConditionExpression === 'attribute_exists(#m) AND #ttl >= :now AND (attribute_not_exists(#r) OR #r = :note)') {
        const item = items.get(input.Key.key);
        const note = input.ExpressionAttributeValues[':note'];
        if (!item?.marker || !(item.ttl >= input.ExpressionAttributeValues[':now'])) throw conditionFailed();
        if (item.roundGivenBack !== undefined && item.roundGivenBack !== note) throw conditionFailed();
        if (input.UpdateExpression !== 'SET #r = :note' || input.ExpressionAttributeNames['#r'] !== 'roundGivenBack') throw new Error(`unexpected update ${input.UpdateExpression}`);
        item.roundGivenBack = note;
        return {};
      }
      if (op === 'UpdateCommand' && input.ConditionExpression === 'attribute_exists(#r) OR #c = :clear') {
        const item = items.get(input.Key.key);
        const clear = input.ExpressionAttributeValues[':clear'];
        if (item?.roundGivenBack === undefined && item?.noteCleared !== clear) throw conditionFailed();
        if (input.UpdateExpression !== 'SET #c = :clear REMOVE #r' || input.ExpressionAttributeNames['#r'] !== 'roundGivenBack' || input.ExpressionAttributeNames['#c'] !== 'noteCleared') {
          throw new Error(`unexpected update ${input.UpdateExpression}`);
        }
        delete item.roundGivenBack;
        item.noteCleared = clear;
        return {};
      }
      if (op === 'UpdateCommand') {
        const item = items.get(input.Key.key) ?? { key: input.Key.key };
        const values = input.ExpressionAttributeValues;
        const below = /^\(attribute_not_exists\(#reviews\) OR #reviews < (:\w+)\) AND \(attribute_not_exists\(#take\) OR #take <> :take\)$/.exec(input.ConditionExpression);
        if (below) {
          if (item.reviews !== undefined && !(item.reviews < values[below[1]])) throw conditionFailedOn(input, items.get(input.Key.key));
          if (item.lastTake !== undefined && item.lastTake === values[':take']) throw conditionFailedOn(input, items.get(input.Key.key));
        } else if (input.ConditionExpression === '#reviews > :zero AND (attribute_not_exists(#return) OR #return <> :return)') {
          if (!(item.reviews > values[':zero']) || item.lastReturn === values[':return']) throw conditionFailed();
        } else {
          throw new Error(`unexpected condition ${input.ConditionExpression}`);
        }
        const add = /ADD #reviews (:\w+)/.exec(input.UpdateExpression);
        item.reviews = (item.reviews ?? 0) + values[add[1]];
        if (/SET #ttl = :ttl/.test(input.UpdateExpression)) item.ttl = values[':ttl'];
        if (/#take = :take/.test(input.UpdateExpression)) item.lastTake = values[':take'];
        if (/#return = :return/.test(input.UpdateExpression)) item.lastReturn = values[':return'];
        items.set(input.Key.key, item);
        return input.ReturnValues === 'UPDATED_NEW' ? { Attributes: { reviews: item.reviews, ttl: item.ttl } } : {};
      }
      throw new Error(`unexpected ${op}`);
    },
  };
}

/**
 * An in-memory DeliveryStore with the same behavior as src/store.ts.
 * autoReviews counts automatic reviews and pending holds the pending
 * marker ids ("pending-1", "pending-2", ...), both per "owner/name#pr",
 * lowercased. pendingDelays has the delay of every marker taken, in
 * order. givenBack holds the pull requests whose marker notes that its
 * round was given back; the note goes with the marker. Pending markers
 * never expire here.
 */
export function fakeStore({ budget = Infinity } = {}) {
  const keys = new Map();
  const released = [];
  const autoReviews = new Map();
  const returned = [];
  const pending = new Map();
  const pendingDelays = [];
  const givenBack = new Set();
  let slots = 0;
  let markers = 0;
  const prKey = (repo, prNumber) => `${repo.toLowerCase()}#${prNumber}`;
  return {
    keys,
    released,
    autoReviews,
    returned,
    pending,
    pendingDelays,
    givenBack,
    get slotsTaken() { return slots; },
    async claim(key, attributes = {}) {
      if (keys.has(key)) return false;
      keys.set(key, attributes);
      return true;
    },
    async release(key) {
      released.push(key);
      keys.delete(key);
    },
    async takeReviewSlot(_routeId, dailyBudget) {
      if (slots >= Math.min(budget, dailyBudget)) return false;
      slots += 1;
      return true;
    },
    async takeAutoReview(repo, prNumber, cap) {
      const taken = autoReviews.get(prKey(repo, prNumber)) ?? 0;
      if (taken >= cap) return 0;
      autoReviews.set(prKey(repo, prNumber), taken + 1);
      return taken + 1;
    },
    async returnAutoReview(repo, prNumber) {
      const taken = autoReviews.get(prKey(repo, prNumber)) ?? 0;
      returned.push(prKey(repo, prNumber));
      if (taken > 0) autoReviews.set(prKey(repo, prNumber), taken - 1);
    },
    async markReviewPending(repo, prNumber, delaySeconds) {
      if (typeof delaySeconds !== 'number') throw new Error('markReviewPending needs the delay');
      if (pending.has(prKey(repo, prNumber))) return null;
      pendingDelays.push(delaySeconds);
      markers += 1;
      pending.set(prKey(repo, prNumber), `pending-${markers}`);
      return `pending-${markers}`;
    },
    async clearReviewPending(repo, prNumber, markerId) {
      if (pending.get(prKey(repo, prNumber)) !== markerId) return false;
      pending.delete(prKey(repo, prNumber));
      givenBack.delete(prKey(repo, prNumber));
      return true;
    },
    async markRoundGivenBack(repo, prNumber) {
      if (!pending.has(prKey(repo, prNumber)) || givenBack.has(prKey(repo, prNumber))) return false;
      givenBack.add(prKey(repo, prNumber));
      return true;
    },
    async clearRoundGivenBack(repo, prNumber) {
      return givenBack.delete(prKey(repo, prNumber));
    },
    async hasPendingReview(repo, prNumber) {
      return pending.has(prKey(repo, prNumber));
    },
  };
}

/**
 * A GitHubApi that answers from a route table. Each handler key is
 * "METHOD path" and returns { status, json }. Unknown calls fail the test.
 */
export function fakeGitHub(routes) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected GitHub call ${method} ${path}`);
    return typeof handler === 'function' ? handler(body) : handler;
  };
  api.calls = calls;
  return api;
}
