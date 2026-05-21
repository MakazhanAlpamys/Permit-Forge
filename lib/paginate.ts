// ============================================================================
// Cursor-pagination helper (F9 / Simplify #9)
// ============================================================================
// Collapses the `limit + 1` fetch / pop / nextCursor dance into one call.
// Callers run the query themselves (limit needs to be passed to the query
// builder) and then hand the rows + the cursor field to this helper.
//
// Sign-and-verify of the cursor is intentionally NOT part of this helper —
// chat sessions sign with HMAC (lib/signed-cursor.ts) but other callers may
// want plain ISO cursors. Pass a `signCursor` adapter if you need signing.

export interface PaginateResult<T> {
  rows: T[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Given the rows returned by a `.limit(pageSize + 1)` query, peel off the
 * extra row used as a "has more" sentinel and derive the next cursor from
 * the trailing row's `cursorField` value.
 *
 * @param rows       The rows returned by the DB (length is up to `pageSize + 1`).
 * @param pageSize   The actual page size the caller wants returned.
 * @param cursorField Field name on the row whose value becomes the next cursor.
 * @param signCursor Optional transform applied to the raw cursor value before
 *                   exposing it to clients (e.g. HMAC signing).
 */
export function paginateByCursor<T extends Record<string, unknown>>(
  rows: T[],
  pageSize: number,
  cursorField: keyof T,
  signCursor?: (raw: string) => string,
): PaginateResult<T> {
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;

  let nextCursor: string | undefined;
  if (hasMore && page.length > 0) {
    const rawCursor = page[page.length - 1][cursorField];
    if (typeof rawCursor === 'string') {
      nextCursor = signCursor ? signCursor(rawCursor) : rawCursor;
    }
  }

  return { rows: page, hasMore, nextCursor };
}
