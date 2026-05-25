'use client';

// ============================================================================
// TS-M-9 / v1.6.0 Part D — root-layout catastrophic error boundary
// ============================================================================
// Triggered when even the root layout / providers throw (e.g. ThemeProvider
// init bombs, a global env-var read fails). Must render its own <html> +
// <body> because the default layout is the thing that crashed. Keep it
// minimal — no shadcn / lucide / theme dependencies, since those may be the
// thing that broke.

import { useEffect } from 'react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// TR2 (v1.6.0 re-audit): named `GlobalError` to match the file's role as the
// catastrophic root-layout boundary. The segment boundary at `app/error.tsx`
// exports `RouteError`.
export default function GlobalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[app/global-error.tsx] root layout crashed:', {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#fafafa',
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            Something went seriously wrong
          </h1>
          <p style={{ color: '#a1a1aa', marginBottom: '1.5rem' }}>
            The application could not start. Please refresh the page.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: '0.75rem',
                color: '#71717a',
                fontFamily: 'monospace',
                marginBottom: '1rem',
              }}
            >
              ref: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              background: '#fafafa',
              color: '#0a0a0a',
              border: 'none',
              borderRadius: '0.375rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
