'use client';

// ============================================================================
// TS-M-9 / v1.6.0 Part D — /permits route segment error boundary
// ============================================================================
// Scoped so a permit list / detail crash shows a recoverable UI inside the
// app shell instead of bubbling to app/error.tsx and blanking the header.

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, RotateCcw, ArrowLeft } from 'lucide-react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function PermitsError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[app/permits/error.tsx] permits segment crashed:', {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-2xl mx-auto pt-16">
        <Card>
          <CardContent className="pt-8 pb-6 px-6 space-y-4 text-center">
            <div className="flex justify-center">
              <div className="rounded-full bg-red-500/10 p-3">
                <AlertTriangle className="h-7 w-7 text-red-500" />
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Failed to load permits</h2>
              <p className="text-sm text-muted-foreground">
                Something went wrong while loading your permit data. Try
                refreshing, or head back to the dashboard.
              </p>
              {error.digest && (
                <p className="text-xs text-muted-foreground/70 font-mono">
                  ref: {error.digest}
                </p>
              )}
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button onClick={reset}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Retry
              </Button>
              <Button variant="outline" asChild>
                <Link href="/">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Dashboard
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
