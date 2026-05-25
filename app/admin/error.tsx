'use client';

// ============================================================================
// TS-M-9 / v1.6.0 Part D — /admin route segment error boundary
// ============================================================================
// The admin shell pulls a lot of dashboards (stats, charts, documents,
// audit logs, permits). A single failing fetch shouldn't blow away the
// whole panel — let the operator retry that segment.

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, RotateCcw, ArrowLeft } from 'lucide-react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AdminError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[app/admin/error.tsx] admin segment crashed:', {
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
              <h2 className="text-xl font-semibold">Admin panel error</h2>
              <p className="text-sm text-muted-foreground">
                Failed to load one of the admin views. Retry, or fall back to
                the user dashboard if the issue persists.
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
