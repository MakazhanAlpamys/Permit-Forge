'use client';

import { useState, Suspense } from 'react';
import { verifyEmailAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { DitheringBackground } from '@/components/login/dithering-background';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';

function VerifyEmailForm() {
  const searchParams = useSearchParams();
  const emailParam = searchParams.get('email') || '';
  const [email] = useState(emailParam);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const { theme } = useTheme();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const result = await verifyEmailAction(email, code);

    if (result?.error) {
      setError(result.error);
      setLoading(false);
    } else if (result?.success) {
      setVerified(true);
      setLoading(false);
      setTimeout(() => router.push('/login'), 2000);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <DitheringBackground />

      <div className="absolute top-4 right-4 z-20">
        <ThemeToggle />
      </div>

      <Card className="w-full max-w-md relative z-10">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <Image
              src={theme === 'dark' ? '/white-icon.svg' : '/black-icon.svg'}
              alt="PermitForge"
              width={64}
              height={64}
              className="h-16 w-auto"
            />
          </div>

          <div>
            <CardTitle className="text-2xl font-bold">
              {verified ? 'Email Verified!' : 'Verify Your Email'}
            </CardTitle>
            <CardDescription>
              {verified
                ? 'Redirecting to login...'
                : `We sent a 6-digit code to ${email || 'your email'}`}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          {verified ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-sm text-muted-foreground">You can now sign in with your account.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email (readonly) */}
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium leading-none">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  readOnly
                  className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm opacity-70"
                />
              </div>

              {/* Code */}
              <div className="space-y-2">
                <label htmlFor="code" className="text-sm font-medium leading-none">
                  Verification Code
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={loading}
                  className="flex h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-center text-2xl tracking-[0.5em] font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="000000"
                />
              </div>

              {error && (
                <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={loading || code.length !== 6}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify Email'
                )}
              </Button>
            </form>
          )}

          <div className="mt-6 text-center text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              Back to login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailForm />
    </Suspense>
  );
}
