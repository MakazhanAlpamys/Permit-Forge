'use client';

import { useState } from 'react';
import { forgotPasswordAction, resetPasswordAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { DitheringBackground } from '@/components/login/dithering-background';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Eye, EyeOff, CheckCircle2, ArrowLeft } from 'lucide-react';

type Step = 'email' | 'code' | 'done';

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { theme } = useTheme();
  const router = useRouter();

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const result = await forgotPasswordAction(email);

    if (result?.error) {
      setError(result.error);
    } else {
      setStep('code');
    }
    setLoading(false);
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const result = await resetPasswordAction(email, code, newPassword);

    if (result?.error) {
      setError(result.error);
      setLoading(false);
    } else if (result?.success) {
      setStep('done');
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
              {step === 'done' ? 'Password Reset!' : 'Forgot Password'}
            </CardTitle>
            <CardDescription>
              {step === 'email' && 'Enter your email to receive a reset code'}
              {step === 'code' && `Enter the code sent to ${email}`}
              {step === 'done' && 'Redirecting to login...'}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          {step === 'done' ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-sm text-muted-foreground">Your password has been updated.</p>
            </div>
          ) : step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium leading-none">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Enter your email"
                />
              </div>

              {error && (
                <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending code...
                  </>
                ) : (
                  'Send Reset Code'
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleResetSubmit} className="space-y-4">
              {/* Code */}
              <div className="space-y-2">
                <label htmlFor="code" className="text-sm font-medium leading-none">
                  Reset Code
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

              {/* New Password */}
              <div className="space-y-2">
                <label htmlFor="newPassword" className="text-sm font-medium leading-none">
                  New Password
                </label>
                <div className="relative">
                  <input
                    id="newPassword"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={loading}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="Min 8 chars, uppercase, lowercase, digit, special"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
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
                    Resetting password...
                  </>
                ) : (
                  'Reset Password'
                )}
              </Button>

              <button
                type="button"
                onClick={() => { setStep('email'); setError(''); setCode(''); }}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto"
              >
                <ArrowLeft className="h-3 w-3" />
                Back
              </button>
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
