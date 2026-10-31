import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from './workspace.js';

/**
 * Sticky review-state comment: one bot-owned top-level comment per PR,
 * rewritten by every review run (post_review and skip_review alike), so
 * the PR always shows the reviewer's current verdict instead of a trail
 * of per-run summaries. The next run finds it again by STATE_MARKER and
 * hands its body back to the agent so open findings carry over.
 *
 * The agent fills a fixed schema and the runtime renders it, which keeps
 * the comment's shape identical across runs and models.
 */

export const STATE_MARKER = '<!-- valkey-reviewer:state -->';

/**
 * `text` with every STATE_MARKER removed, for model-written text the app
 * posts as a comment, so that comment cannot pass for the state comment.
 * Repeats until none is left: removing one copy can join the text around
 * it into a new one.
 */
export function stripStateMarker(text: string): string {
  let out = text;
  while (out.includes(STATE_MARKER)) out = out.replaceAll(STATE_MARKER, '');
  return out;
}

export const reviewStateSchema = z.object({
  status: z.enum(['needs_work', 'ready_for_human_review']).describe(
    '"ready_for_human_review" only when you would approve this PR as it stands: no open blocking finding and no open direction concern. Otherwise "needs_work", which needs an open blocking finding or a `direction`: open minor findings alone are "ready_for_human_review".',
  ),
  summary: z.string().min(1).describe('One or two short, plain sentences on where the PR stands now. If you dropped an earlier finding as wrong, say why here.'),
  risk: z.enum(['low', 'medium', 'high']).describe('Risk of merging the PR as it stands at this head.'),
  risk_reason: z.string().min(1).describe('One short sentence: what breaks, and for whom, if this change is wrong.'),
  findings: z.array(z.object({
    location: z.string().describe('`path:line`, the line its inline comment was posted at (the last line of a multi-line comment), or "" for a PR-wide finding.'),
    summary: z.string().min(1).describe('The finding in one short sentence.'),
    blocking: z.boolean().describe('true if this must be fixed before merge.'),
    resolved: z.boolean().describe('true only if the finding is fixed at the current head, checked there. A finding shown to be wrong is not resolved: drop it from the list.'),
  })).default([]).describe('Every finding from this run plus every finding from the previous state comment, each marked open or resolved. Drop an earlier finding only if it is shown to be wrong: leave it out rather than mark it resolved, and give the reason in the top-level `summary`.'),
  backport: z.object({
    verdict: z.enum(['needed', 'not_needed', 'unclear']),
    branches: z.array(z.string()).default([]).describe('Release branches that need the backport, named as in the PR overview\'s release-line list, e.g. ["8.1", "9.0"]. Empty unless verdict is "needed".'),
    reason: z.string().min(1).describe('One short sentence, e.g. which commit introduced the bug and which release lines carry it.'),
  }),
  direction: z.string().default('').describe('A different approach for the whole PR, only if you checked it against the code and it is clearly better than what the PR does. Empty otherwise.'),
});

export type ReviewState = z.infer<typeof reviewStateSchema>;

/**
 * Returns an error message when the state contradicts itself, else null.
 * `releaseBranches` are the maintained release lines the workspace found;
 * when known, a "needed" backport may only name those.
 */
export function validateReviewState(state: ReviewState, releaseBranches?: readonly string[] | null): string | null {
  const openBlocking = state.findings.filter((f) => f.blocking && !f.resolved);
  if (state.status === 'ready_for_human_review') {
    if (openBlocking.length > 0) {
      return `status is "ready_for_human_review" but ${openBlocking.length} blocking finding(s) are still open. Mark them resolved only if fixed at this head; otherwise set status to "needs_work".`;
    }
    if (state.direction.trim()) {
      return 'status is "ready_for_human_review" but `direction` proposes a different approach. Either set status to "needs_work" or clear `direction`.';
    }
  } else if (openBlocking.length === 0 && !state.direction.trim()) {
    return 'status is "needs_work" but no blocking finding is open and `direction` is empty. Set status to "ready_for_human_review", or list the blocking finding that is still open.';
  }
  const bp = state.backport;
  if (bp.verdict === 'needed') {
    if (bp.branches.length === 0) {
      return 'backport verdict is "needed" but `backport.branches` is empty. List the release branches that need it, or use "unclear".';
    }
    if (releaseBranches) {
      const known = new Set(releaseBranches);
      const unknown = bp.branches.filter((b) => !known.has(b));
      if (unknown.length > 0) {
        const allowed = releaseBranches.length > 0
          ? `the maintained release lines: ${releaseBranches.join(', ')}`
          : 'a maintained release line, and none was found. Use "not_needed" or "unclear" and explain in `reason`';
        return `backport.branches has ${unknown.map((b) => `"${b}"`).join(', ')}, but each entry must be one of ${allowed}.`;
      }
    }
  }
  return null;
}

const RISK_LABEL: Record<ReviewState['risk'], string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** Folds text onto one line, so it cannot start a heading or list item. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function findingLine(f: ReviewState['findings'][number]): string {
  // A location names a PR file, which the author chose. Without newlines
  // or backticks it stays inside its code span, here and when the comment
  // is shown to the next run.
  const location = oneLine(f.location).replace(/`/g, "'");
  const where = location ? `\`${location}\` ` : '';
  const minor = f.blocking ? '' : '(minor) ';
  return `- ${minor}${where}${oneLine(f.summary)}`;
}

/**
 * A finding location as a `path:line` key, or null when it names no
 * single line. It is folded and its backticks replaced as the comment
 * shows it, so a location read back from a state comment gives the same
 * key.
 */
export function locationKey(location: string): string | null {
  const m = /^(.+):(\d+)$/.exec(oneLine(location).replace(/`/g, "'"));
  return m ? `${m[1]}:${Number(m[2])}` : null;
}

/**
 * Keys of the open findings a state comment records. The heads line
 * lists them. A comment from before that list existed is read from its
 * open findings: one per line, the location in the code span that starts
 * the line. Model text can pass for such a line there (a PR-wide
 * finding's summary that starts with a code span, or a summary that
 * holds the heading), which the heads line rules out.
 */
export function openFindingKeys(body: string): Set<string> {
  const recorded = headsJson(body)?.open_locations;
  if (Array.isArray(recorded) && recorded.every((k) => typeof k === 'string')) {
    return new Set(recorded.map((k: string) => locationKey(k)).filter((k): k is string => k !== null));
  }
  const keys = new Set<string>();
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\*\*Open findings \(\d+\)\*\*$/.test(l));
  if (start === -1) return keys;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    const m = /^- (?:\(minor\) )?`([^`]*)` /.exec(line);
    const key = m ? locationKey(m[1]!) : null;
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * What a state comment was written for. `head` is the PR head the run
 * saw and `base` the branch it reviewed against. `fullReview` is the
 * latest head a full review covered and `fullReviewBase` the base that
 * review was against. A partial run, a focused @mention or thread-reply
 * run or a review the model call limit stopped, carries both over.
 * `fullReview` is null when no full review has run, and a 10-hex prefix
 * when it was carried over from a comment written before this line
 * existed; such a comment did not record the base, so `fullReviewBase`
 * is then null.
 */
export interface ReviewHeads {
  readonly head: string;
  readonly base: string;
  readonly fullReview: string | null;
  readonly fullReviewBase: string | null;
}

/** The last full review an earlier state comment records. `base` is null when that comment did not record it. */
export interface FullReview {
  readonly head: string;
  readonly base: string | null;
}

const HEADS_PREFIX = '<!-- valkey-reviewer:heads ';
const HEADS_SUFFIX = ' -->';

/** True when the last full review covered `heads.head` against `heads.base`. */
export function fullyReviewed(heads: ReviewHeads): boolean {
  return heads.fullReview !== null && heads.head.startsWith(heads.fullReview)
    && (heads.fullReviewBase === null || heads.fullReviewBase === heads.base);
}

/**
 * The comment's last line: `heads`, and the `path:line` keys of the open
 * findings that name a line, as JSON inside an HTML comment, which
 * GitHub does not show. Only the runtime writes it, after all model
 * text, so a reader that takes only the last line cannot be handed a
 * line the model wrote. `<` and `>` are escaped, so no value can end the
 * HTML comment early.
 */
function headsLine(heads: ReviewHeads, state: ReviewState): string {
  const open = state.findings.filter((f) => !f.resolved).map((f) => locationKey(f.location)).filter((k) => k !== null);
  const json = JSON.stringify({
    head: heads.head,
    base: heads.base,
    full_review: heads.fullReview,
    full_review_base: heads.fullReviewBase,
    open_locations: [...new Set(open)],
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${HEADS_PREFIX}${json}${HEADS_SUFFIX}`;
}

function lastLine(body: string): string {
  return body.trimEnd().split(/\r?\n/).pop() ?? '';
}

/** The JSON object a state comment's heads line holds, or null when that line is missing or malformed. */
function headsJson(body: string): Record<string, unknown> | null {
  const line = lastLine(body);
  if (!line.startsWith(HEADS_PREFIX) || !line.endsWith(HEADS_SUFFIX)) return null;
  try {
    const value: unknown = JSON.parse(line.slice(HEADS_PREFIX.length, -HEADS_SUFFIX.length));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The heads a state comment's last line records, or null when that line is missing or malformed. */
export function parseReviewHeads(body: string): ReviewHeads | null {
  const v = headsJson(body);
  if (!v) return null;
  if (typeof v.head !== 'string' || !/^[0-9a-f]{40}$/.test(v.head) || typeof v.base !== 'string') return null;
  const full = v.full_review;
  if (full !== null && (typeof full !== 'string' || !/^[0-9a-f]{10,40}$/.test(full))) return null;
  const fullBase = v.full_review_base;
  if (fullBase !== null && typeof fullBase !== 'string') return null;
  return { head: v.head, base: v.base, fullReview: full, fullReviewBase: fullBase };
}

/**
 * The latest full review, from the state comment an earlier run wrote. A
 * comment from before the heads line ends with the footer instead. It
 * does not say which runs were full reviews, so its stamp is taken as
 * one.
 */
export function previousFullReview(body: string): FullReview | null {
  const heads = parseReviewHeads(body);
  if (heads) return heads.fullReview === null ? null : { head: heads.fullReview, base: heads.fullReviewBase };
  const legacy = /^<sub>Updated for ([0-9a-f]{10}) at /.exec(lastLine(body));
  return legacy ? { head: legacy[1]!, base: null } : null;
}

/** `body` without its heads line, for showing a state comment to the model. */
export function stripHeadsLine(body: string): string {
  const lines = body.trimEnd().split(/\r?\n/);
  if (lines.at(-1)?.startsWith(HEADS_PREFIX)) lines.pop();
  return lines.join('\n');
}

/** The footer's note on a state that no full review covers, or "". */
function coverageNote(heads: ReviewHeads): string {
  if (fullyReviewed(heads)) return '';
  if (heads.fullReview === null) return ' after a partial review; no full review has run yet';
  // A branch name may hold a backtick; it would end the code span.
  const against = heads.fullReviewBase !== null && heads.fullReviewBase !== heads.base
    ? ` against \`${oneLine(heads.fullReviewBase).replace(/`/g, "'")}\``
    : '';
  return ` after a partial review; the last full review was at ${heads.fullReview.slice(0, 10)}${against}`;
}

export function renderReviewState(state: ReviewState, heads: ReviewHeads, now: Date = new Date()): string {
  const open = state.findings.filter((f) => !f.resolved);
  const resolved = state.findings.filter((f) => f.resolved);
  const lines: string[] = [STATE_MARKER, '### Review state', ''];

  lines.push(state.status === 'ready_for_human_review'
    ? '**Ready for human review.**'
    : '**Not ready for human review yet.**');
  lines.push(state.summary.trim(), '');

  lines.push(`**Risk:** ${RISK_LABEL[state.risk]}. ${state.risk_reason.trim()}`, '');

  if (open.length > 0) {
    lines.push(`**Open findings (${open.length})**`);
    for (const f of open) lines.push(findingLine(f));
  } else {
    lines.push('**Open findings:** none.');
  }
  lines.push('');
  if (resolved.length > 0) {
    lines.push(`**Resolved (${resolved.length})**`);
    for (const f of resolved) lines.push(findingLine(f));
    lines.push('');
  }

  const bp = state.backport;
  const bpHead = bp.verdict === 'needed'
    ? `Needed${bp.branches.length > 0 ? ` for ${bp.branches.join(', ')}` : ''}.`
    : bp.verdict === 'not_needed' ? 'Not needed.' : 'Unclear.';
  lines.push(`**Backport:** ${bpHead} ${bp.reason.trim()}`, '');

  if (state.direction.trim()) {
    lines.push('**Direction**', state.direction.trim(), '');
  }

  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const headSha = heads.head;
  lines.push(`<sub>Updated for ${headSha.slice(0, 10)} at ${stamp} UTC${coverageNote(heads)}. The bot rewrites this comment on every review.</sub>`);
  lines.push(headsLine(heads, state));
  return lines.join('\n');
}

/**
 * Creates the state comment on first use and edits it afterwards. One
 * writer per run, shared by post_review and skip_review, so a retried
 * terminal call edits the comment it just created instead of adding a
 * second one.
 */
export interface StateCommentWriter {
  /** `userId` is the comment's author, this App's bot account, when GitHub returned it. */
  write(body: string): Promise<{ id: number; url: string; userId: number | null }>;
}

interface RequestErrorFields {
  readonly status?: unknown;
  readonly message?: unknown;
  readonly response?: { readonly headers?: Readonly<Record<string, unknown>> };
}

/**
 * 404: the comment was deleted. 403: the app may no longer edit it. Both
 * mean "start a new one", except that GitHub also answers 403 to rate
 * limiting, which a new comment would not fix.
 */
function isGone(err: unknown): boolean {
  const e = (err ?? {}) as RequestErrorFields;
  if (e.status === 404) return true;
  if (e.status !== 403) return false;
  const headers = e.response?.headers ?? {};
  const rateLimited = headers['retry-after'] !== undefined
    || headers['x-ratelimit-remaining'] === '0'
    || (typeof e.message === 'string' && /rate limit/i.test(e.message));
  return !rateLimited;
}

export function createStateCommentWriter(octokit: Octokit, ctx: PrContext): StateCommentWriter {
  let commentId = ctx.previousState?.id ?? null;
  return {
    async write(body: string) {
      if (commentId !== null) {
        try {
          const { data } = await octokit.issues.updateComment({
            owner: ctx.owner, repo: ctx.repo, comment_id: commentId, body,
          });
          return { id: data.id, url: data.html_url, userId: data.user?.id ?? null };
        } catch (err) {
          if (!isGone(err)) throw err;
          console.warn(`[review-state] state comment ${commentId} cannot be edited (status ${(err as { status: number }).status}); creating a new one`);
        }
      }
      const { data } = await octokit.issues.createComment({
        owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber, body,
      });
      commentId = data.id;
      return { id: data.id, url: data.html_url, userId: data.user?.id ?? null };
    },
  };
}
