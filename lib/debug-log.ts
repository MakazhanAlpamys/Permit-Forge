// ============================================================================
// TS-M-6 / v1.6.0 Part E — gated console.log helper
// ============================================================================
// Production Lambda logs are noisy enough without per-request chat-pipeline
// trace lines. `debugLog` is a no-op unless DEBUG_PERMITFORGE=1 is set in the
// environment. console.error / console.warn are NOT gated — operators always
// want to see actual failures.
//
// Module-level cache: a single env read at first call; toggling DEBUG_*
// mid-process requires a restart. (Acceptable for a Lambda model.)

let _enabled: boolean | null = null;

function enabled(): boolean {
  if (_enabled === null) {
    _enabled = process.env.DEBUG_PERMITFORGE === '1';
  }
  return _enabled;
}

/**
 * Drop-in replacement for `console.log` in hot-path libs. No-op in prod
 * unless DEBUG_PERMITFORGE=1.
 */
export function debugLog(...args: unknown[]): void {
  if (enabled()) {
    console.log(...args);
  }
}
