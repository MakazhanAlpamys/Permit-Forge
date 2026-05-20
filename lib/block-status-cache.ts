// ============================================================================
// Block-Status Cache (shared by middleware + admin actions for invalidation)
// ============================================================================
// Extracted from middleware.ts so admin mutations can punch holes in the cache
// when a user is blocked/unblocked/deleted/role-changed (B13/H7-clickpath).
//
// Caveats accepted for diploma scope (documented per the plan):
// - Single-process only. Middleware runs in the Edge runtime and server
//   actions run in Node; in production these are different V8 isolates with
//   independent Map instances. Within a single `next dev` process they happen
//   to share state, which is enough for local testing.
// - Stale-up-to-TTL on multi-node deploys is explicitly out of scope; the
//   TTL itself is the floor on staleness regardless of this invalidator.
// ============================================================================

export interface BlockStatusEntry {
  blocked: boolean;
  reason?: string;
  checkedAt: number;
}

export const blockStatusCache = new Map<string, BlockStatusEntry>();

/** Drop the cached block status for a user. Called after admin block /
 *  unblock / role change / delete so the next middleware hit re-reads the DB. */
export function invalidateBlockStatus(userId: string): void {
  blockStatusCache.delete(userId);
}
