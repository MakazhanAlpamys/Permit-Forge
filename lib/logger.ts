// ============================================================================
// Centralized Logging Utility
// ============================================================================
//
// Provides a consistent logging interface across the application.
// In production, logs can be sent to external services (Sentry, LogRocket, etc.)
// In development, logs are output to the console with proper formatting.
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
    data?: unknown;
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// Check if we're in production
const isProduction = process.env.NODE_ENV === 'production';

// Minimum log level — defaults to 'warn' in production, 'debug' in development.
// Override with LOG_LEVEL env var (e.g. LOG_LEVEL=info for production info logs).
const MIN_LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || (isProduction ? 'warn' : 'debug');

// -----------------------------------------------------------------------------
// Formatting Helpers
// -----------------------------------------------------------------------------

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[MIN_LOG_LEVEL];
}

function formatLogEntry(entry: LogEntry): string {
    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
    return `${prefix} ${entry.message}`;
}

// -----------------------------------------------------------------------------
// Logger Implementation
// -----------------------------------------------------------------------------

/**
 * Centralized logger with support for different log levels.
 * In production, errors can be sent to external logging services.
 *
 * @example
 * logger.info('User logged in', { userId: '123' });
 * logger.error('Failed to process request', error);
 */
export const logger = {
    /**
     * Log debug information (development only by default)
     */
    debug(message: string, ...args: unknown[]): void {
        if (!shouldLog('debug')) return;

        const entry: LogEntry = {
            level: 'debug',
            message,
            timestamp: new Date().toISOString(),
            data: args.length > 0 ? args : undefined,
        };

        console.debug(formatLogEntry(entry), ...args);
    },

    /**
     * Log general information
     */
    info(message: string, ...args: unknown[]): void {
        if (!shouldLog('info')) return;

        const entry: LogEntry = {
            level: 'info',
            message,
            timestamp: new Date().toISOString(),
            data: args.length > 0 ? args : undefined,
        };

        console.info(formatLogEntry(entry), ...args);
    },

    /**
     * Log warnings
     */
    warn(message: string, ...args: unknown[]): void {
        if (!shouldLog('warn')) return;

        const entry: LogEntry = {
            level: 'warn',
            message,
            timestamp: new Date().toISOString(),
            data: args.length > 0 ? args : undefined,
        };

        if (isProduction) {
            // Send to logging service in production
            // e.g., sendToLoggingService(entry);
        } else {
            console.warn(formatLogEntry(entry), ...args);
        }
    },

    /**
     * Log errors (always logged, sent to external service in production)
     */
    error(message: string, ...args: unknown[]): void {
        if (!shouldLog('error')) return;

        const entry: LogEntry = {
            level: 'error',
            message,
            timestamp: new Date().toISOString(),
            data: args.length > 0 ? args : undefined,
        };

        if (isProduction) {
            // In production, send to external logging service
            // e.g., Sentry.captureException(args[0] instanceof Error ? args[0] : new Error(message));
            // For now, still log to console but with minimal output
            console.error(`[ERROR] ${message}`);
        } else {
            console.error(formatLogEntry(entry), ...args);
        }
    },
};

// Default export for convenience
export default logger;
