'use client';

import { useState, Suspense } from 'react';
import { verifyEmailAction, resendVerificationCodeAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { LanguageToggle } from '@/components/language-toggle';
import { DitheringBackground } from '@/components/login/dithering-background';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function VerifyEmailForm() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const emailParam = searchParams.get('email') || '';
  const [email] = useState(emailParam);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  // CP-E-1 (v1.2.0 Part E): resend button state. `resentAt` is a timestamp so
  // we can rate-limit clicks client-side too (server has its own IP limiter).
  const [resending, setResending] = useState(false);
  const [resentAt, setResentAt] = useState<number | null>(null);
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

  const handleResend = async () => {
    if (resending) return;
    // Client-side throttle: at most one resend every 30 s. Server enforces
    // its own rate limit via checkLoginRateLimit on the same IP.
    if (resentAt && Date.now() - resentAt < 30_000) return;
    setResending(true);
    setError('');
    try {
      const result = await resendVerificationCodeAction(email);
      if (result?.error) {
        setError(result.error);
      } else {
        setResentAt(Date.now());
        setCode(''); // previous code is dead
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <DitheringBackground />

      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <LanguageToggle className="bg-accent text-accent-foreground" />
        <ThemeToggle className="bg-accent text-accent-foreground" />
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
              {verified ? t('auth.verifyEmail.titleSuccess') : t('auth.verifyEmail.title')}
            </CardTitle>
            <CardDescription>
              {verified
                ? t('auth.verifyEmail.subtitleRedirect')
                : email
                  ? t('auth.verifyEmail.subtitle', { email })
                  : t('auth.verifyEmail.subtitleFallback')}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          {verified ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-sm text-muted-foreground">{t('auth.verifyEmail.successMessage')}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email (readonly) */}
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium leading-none">
                  {t('auth.verifyEmail.emailLabel')}
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
                  {t('auth.verifyEmail.codeLabel')}
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
                    {t('auth.verifyEmail.submitting')}
                  </>
                ) : (
                  t('auth.verifyEmail.submit')
                )}
              </Button>

              {/* CP-E-1: resend button for expired or lost codes. */}
              <div className="text-center text-sm text-muted-foreground">
                {resentAt ? (
                  <span className="text-green-500">{t('auth.verifyEmail.resent')}</span>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resending || !email}
                    className="text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                  >
                    {resending ? t('auth.verifyEmail.resending') : t('auth.verifyEmail.resend')}
                  </button>
                )}
              </div>
            </form>
          )}

          <div className="mt-6 text-center text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              {t('auth.verifyEmail.backToLogin')}
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
