// ============================================================================
// Structured Logger (v1.7.0 Part E / A-H-7)
// ============================================================================
//
// Edge-Runtime-safe. No external dependency: serialises log records to JSON
// and writes them via `console.error / .warn / .info / .debug` so Vercel +
// any log aggregator can parse them as structured events.
//
// Why not pino? The chat pipeline + API routes run in Node, but middleware.ts
// runs in Edge. pino bundles worker_threads + `fs` shims that have Edge
// runtime issues. A 70-line wrapper around console.* matches the actual
// requirement ("structured + queryable") with zero dependency risk before
// defense. Swap to pino post-defense if a transport (Datadog / Logflare /
// Better Stack) needs the agent protocol.
//
// Usage:
//   import { logger } from '@/lib/logger';
//   logger.info({ userId, action: 'permit_created' }, 'Permit created');
//   logger.error({ err, requestId }, 'Compliance check failed');
//
//   // Bind per-request context:
//   const log = logger.child({ requestId, userId });
//   log.warn({ stage: 'rerank' }, 'CRAG fail');
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

interface Logger {
  debug: (context: LogContext, message?: string) => void;
  info: (context: LogContext, message?: string) => void;
  warn: (context: LogContext, message?: string) => void;
  error: (context: LogContext, message?: string) => void;
  /** Create a child logger that inherits and extends the parent's bindings. */
  child: (bindings: LogContext) => Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentMinLevel(): number {
  // LOG_LEVEL=debug|info|warn|error. Default: 'info' in prod, 'debug' in dev.
  const env = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel;
  if (env in LEVEL_ORDER) return LEVEL_ORDER[env];
  return process.env.NODE_ENV === 'production' ? LEVEL_ORDER.info : LEVEL_ORDER.debug;
}

/**
 * Serialise an Error to a plain object so JSON.stringify retains the
 * message + stack (Error fields are non-enumerable otherwise).
 */
function serialiseError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
  }
  return err;
}

function normaliseContext(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = key === 'err' || key === 'error' ? serialiseError(value) : value;
  }
  return out;
}

function createLogger(bindings: LogContext = {}): Logger {
  const emit = (level: LogLevel, context: LogContext, message?: string) => {
    if (LEVEL_ORDER[level] < currentMinLevel()) return;

    const record = {
      level,
      time: new Date().toISOString(),
      ...bindings,
      ...normaliseContext(context),
      ...(message !== undefined ? { msg: message } : {}),
    };

    const json = JSON.stringify(record);
    // Route to the console method that matches the level so Vercel / DevTools
    // grouping + the existing test spies (vi.spyOn(console, 'warn')) keep
    // working without explicit migration.
    if (level === 'error') console.error(json);
    else if (level === 'warn') console.warn(json);
    else if (level === 'info') console.info(json);
    else console.debug(json);
  };

  return {
    debug: (context, message) => emit('debug', context, message),
    info: (context, message) => emit('info', context, message),
    warn: (context, message) => emit('warn', context, message),
    error: (context, message) => emit('error', context, message),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

/** Process-wide default logger. Prefer `.child({...})` per-request. */
export const logger = createLogger();

/**
 * Read the request id forwarded by middleware (x-request-id). Server actions
 * and API routes both have access to headers(), but only when running inside
 * a request scope; falls back to a fresh UUID for callers running outside
 * one (e.g. cron jobs, ad-hoc scripts).
 */
export async function getRequestLogger(extraBindings: LogContext = {}): Promise<Logger> {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    const requestId = h.get('x-request-id');
    if (requestId) {
      return logger.child({ requestId, ...extraBindings });
    }
  } catch {
    // Outside a request scope — fall through.
  }
  // crypto.randomUUID() is available in Node 18+ (Next 15 requires).
  return logger.child({ requestId: crypto.randomUUID(), ...extraBindings });
}
