'use client';

// ============================================================================
// TS-M-9 / v1.6.0 Part D — global error boundary (App Router)
// ============================================================================
// A scoped error.tsx file lets Next.js show a recoverable UI instead of
// crashing the whole shell when a server component / data fetch throws.
// Without this, a single DB blip on a leaf component (e.g. permits list query
// timing out) blanks the entire page including the header / sidebar.

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// TR2 (v1.6.0 re-audit): named `RouteError` — this is the *segment* boundary,
// not the catastrophic root-layout one. The corresponding `app/global-error.tsx`
// exports `GlobalError`. Next.js routes purely by default export so the names
// are for React DevTools / stack traces only.
export default function RouteError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Operator-visible: every error.tsx render gets a server log so we can
    // correlate the user-facing "Something went wrong" with the digest.
    console.error('[app/error.tsx] route segment crashed:', {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-lg text-center">
        <CardContent className="pt-10 pb-8 px-8 space-y-6">
          <div className="flex justify-center">
            <div className="rounded-full bg-red-500/10 p-3">
              <AlertTriangle className="h-8 w-8 text-red-500" />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-foreground">
              Something went wrong
            </h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              An unexpected error occurred while loading this page. The team
              has been notified.
            </p>
            {error.digest && (
              <p className="text-xs text-muted-foreground/70 font-mono pt-1">
                ref: {error.digest}
              </p>
            )}
          </div>

          <div className="flex items-center justify-center gap-3 pt-2">
            <Button onClick={reset}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">
                <Home className="mr-2 h-4 w-4" />
                Go Home
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
