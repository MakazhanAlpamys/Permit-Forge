// ============================================================================
// v1.7.0 Part E / A-H-7 — lib/logger.ts coverage
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, getRequestLogger } from '@/lib/logger';

describe('logger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it('emits JSON via console.error for error level', () => {
    logger.error({ userId: 'u-1' }, 'something broke');

    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe('error');
    expect(parsed.userId).toBe('u-1');
    expect(parsed.msg).toBe('something broke');
    expect(typeof parsed.time).toBe('string');
  });

  it('routes each level to its matching console method', () => {
    logger.debug({}, 'd');
    logger.info({}, 'i');
    logger.warn({}, 'w');
    logger.error({}, 'e');

    expect(debugSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('respects LOG_LEVEL filtering', () => {
    process.env.LOG_LEVEL = 'warn';
    logger.debug({}, 'd');
    logger.info({}, 'i');
    logger.warn({}, 'w');
    logger.error({}, 'e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('child loggers inherit and extend bindings', () => {
    const log = logger.child({ requestId: 'req-1' });
    const subLog = log.child({ userId: 'u-2' });

    subLog.info({ extra: true }, 'hello');

    const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.userId).toBe('u-2');
    expect(parsed.extra).toBe(true);
  });

  it('serialises Error objects so .message and .stack survive JSON.stringify', () => {
    const err = new Error('boom');
    logger.error({ err }, 'caught');

    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.err.message).toBe('boom');
    expect(typeof parsed.err.stack).toBe('string');
  });

  it('omits msg when no message argument given', () => {
    logger.info({ event: 'ping' });
    const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe('ping');
    expect(parsed.msg).toBeUndefined();
  });

  // Outside a Next.js request scope, next/headers throws — getRequestLogger
  // falls through to a freshly minted request id so callers always get a
  // child logger with a stable correlation key.
  it('getRequestLogger falls back to a fresh UUID outside request scope', async () => {
    const log = await getRequestLogger({ caller: 'unit-test' });
    log.info({}, 'hello');

    const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(typeof parsed.requestId).toBe('string');
    expect(parsed.requestId.length).toBeGreaterThan(10);
    expect(parsed.caller).toBe('unit-test');
  });

  it('getRequestLogger reads x-request-id when headers() is available', async () => {
    // Stub next/headers to return a header bag with x-request-id.
    vi.doMock('next/headers', () => ({
      headers: async () => ({ get: (k: string) => (k === 'x-request-id' ? 'req-from-mw' : null) }),
    }));
    // Force a re-import so the mock takes effect.
    vi.resetModules();
    const { getRequestLogger: rl } = await import('@/lib/logger');

    const log = await rl({ caller: 'api' });
    log.info({}, 'hit');

    const last = infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0] as string;
    const parsed = JSON.parse(last);
    expect(parsed.requestId).toBe('req-from-mw');
    expect(parsed.caller).toBe('api');

    vi.doUnmock('next/headers');
    vi.resetModules();
  });
});
