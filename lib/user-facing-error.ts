// ============================================================================
// User-facing error helper (SECRET-M1/M3 / v1.5.0 Part F)
// ============================================================================
// Goal: stop echoing internal error.message strings to the client. Native
// PostgreSQL / Supabase errors include table names, column names, constraint
// names, and sometimes raw SQL fragments — handy in dev, recon material in
// production. Server actions previously returned the raw `error.message`
// inside `{ success: false, error }` payloads which the UI rendered as-is.
//
// Use this when the caller needs to surface an error to the user. Keep
// the underlying error in the action's console.error for operator
// visibility — only the user-facing string flows through this helper.

// PSE3 (v1.5.0 re-audit): tightened phrase set — phrases must be specific
// enough that a typical Postgres / driver error won't accidentally match.
// "invalid" and "already exists" were dropped — they match
// `invalid input syntax for type uuid: "..."` (echoes attacker UUID) and
// `duplicate key value violates unique constraint "users_username_key"`
// (leaks index name). Server actions that need to surface those error
// classes should use the explicit sentinel-prefix form below.
const ALLOWED_DOMAIN_PHRASES = [
  // Whole-word phrases that don't appear inside the common pg error strings.
  // Keep this list minimal — each entry is reviewed for "could a DB error
  // contain this string?" before being added.
  'not authorized',
  'unauthorized',
  'permission denied',
  'rate limited',
  'status has changed',
];

/**
 * Caller-controlled sentinel: messages starting with `UF:` are forwarded
 * verbatim (with the sentinel stripped). Server actions use this when they
 * intentionally want to surface a constructed message — e.g.
 *   throw new Error('UF: Permit not found');
 * Postgres / driver errors NEVER carry this prefix so this path is safe.
 */
const SENTINEL_PREFIX = 'UF:';

/**
 * Reduce an arbitrary error object/string/value to a single short safe
 * message suitable for surfacing in `{ success: false, error: ... }` server
 * action payloads.
 *
 * Forward rules (anything else returns the fallback):
 *   1. Message starts with `UF:` sentinel — forwarded verbatim.
 *   2. Message contains one of the (tight) allow-listed domain phrases.
 *
 * Both paths cap the result at 200 chars.
 *
 * Callers should still `console.error(err)` with the original error so
 * operators can correlate logs.
 */
export function userFacingError(err: unknown, fallback: string): string {
  const raw = extractMessage(err);
  if (!raw) return fallback;

  if (raw.startsWith(SENTINEL_PREFIX)) {
    const stripped = raw.slice(SENTINEL_PREFIX.length).trimStart();
    return stripped.length > 200 ? stripped.slice(0, 200) : stripped;
  }

  const lower = raw.toLowerCase();
  for (const phrase of ALLOWED_DOMAIN_PHRASES) {
    if (lower.includes(phrase)) {
      return raw.length > 200 ? raw.slice(0, 200) : raw;
    }
  }
  return fallback;
}

function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}
