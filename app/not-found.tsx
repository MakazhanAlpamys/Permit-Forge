'use client';

import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Home } from 'lucide-react';

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-lg text-center">
        <CardContent className="pt-10 pb-8 px-8 space-y-6">
          <div className="space-y-2">
            <h1 className="text-7xl font-bold tracking-tighter text-foreground">
              404
            </h1>
            <p className="text-xl font-medium text-foreground">
              {t('errors.notFound')}
            </p>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {t('errors.notFoundDescription')}
            </p>
          </div>

          <div className="flex items-center justify-center gap-3 pt-2">
            <Button asChild>
              <Link href="/">
                <Home className="mr-2 h-4 w-4" />
                {t('errors.goHome')}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
