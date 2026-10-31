import { createHash } from 'node:crypto';

/**
 * A run's resolve grant: the pull request the thread resolver
 * (src/resolver.ts) may resolve threads on for that run, and until when
 * (Unix seconds). The queue worker writes it (src/invoker.ts) just before
 * it invokes the run, and gives the run a random value that names it.
 */
export interface ResolveGrant {
  readonly repo: string;
  readonly prNumber: number;
  readonly installationId: number;
  readonly expiresAt: number;
}

/**
 * The receiver's table key a grant is stored under. Only a hash of the
 * value is stored, so the table does not hold what a caller presents.
 */
export function grantKey(grant: string): string {
  return `resolve#${createHash('sha256').update(grant).digest('hex')}`;
}

/** The item src/invoker.ts writes under grantKey, without its key. */
export function grantItem(grant: ResolveGrant): Record<string, string | number> {
  return { repo: grant.repo, pr_number: grant.prNumber, installation_id: grant.installationId, ttl: grant.expiresAt };
}

/** The grant a stored item holds, or undefined when it is missing or malformed. */
export function grantFromItem(item: unknown): ResolveGrant | undefined {
  const g = item as { repo?: unknown; pr_number?: unknown; installation_id?: unknown; ttl?: unknown } | undefined;
  if (typeof g?.repo !== 'string' || typeof g.pr_number !== 'number' || typeof g.installation_id !== 'number' || typeof g.ttl !== 'number') {
    return undefined;
  }
  return { repo: g.repo, prNumber: g.pr_number, installationId: g.installation_id, expiresAt: g.ttl };
}
