'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getProfileAction,
  updateProfileAction,
  requestPasswordChangeCodeAction,
  confirmPasswordChangeAction,
} from '@/actions/profile';
import { readCsrfCookie } from '@/lib/csrf-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Header } from '@/components/dashboard/header';
import {
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  ArrowLeft,
  Mail,
  User,
  Lock,
} from 'lucide-react';
import Link from 'next/link';

type PasswordStep = 'idle' | 'code_sent' | 'done';

export default function ProfilePage() {
  const { t } = useTranslation();
  // Profile data
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);

  // Profile update
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState(false);

  // Password change
  const [passwordStep, setPasswordStep] = useState<PasswordStep>('idle');
  const [passwordCode, setPasswordCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  // Original values to detect changes
  const [origUsername, setOrigUsername] = useState('');
  const [origFullName, setOrigFullName] = useState('');

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    setProfileLoading(true);
    const result = await getProfileAction();
    if (result.data) {
      setUsername(result.data.username);
      setFullName(result.data.full_name || '');
      setEmail(result.data.email || '');
      setEmailVerified(result.data.email_verified);
      setOrigUsername(result.data.username);
      setOrigFullName(result.data.full_name || '');
    }
    setProfileLoading(false);
  };

  const getCSRF = async (setError: (msg: string) => void): Promise<string | null> => {
    const token = readCsrfCookie();
    if (!token) {
      setError(t('errors.tryAgain'));
      return null;
    }
    return token;
  };

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    setProfileError('');
    setProfileSuccess(false);

    const csrf = await getCSRF(setProfileError);
    if (!csrf) { setProfileSaving(false); return; }

    const updates: Record<string, string> = {};
    if (username !== origUsername) updates.username = username;
    if (fullName !== origFullName) updates.full_name = fullName;

    if (Object.keys(updates).length === 0) {
      setProfileError(t('common.notAvailable'));
      setProfileSaving(false);
      return;
    }

    const result = await updateProfileAction(updates, csrf);
    if (result.error) {
      setProfileError(result.error);
    } else {
      setProfileSuccess(true);
      setOrigUsername(username);
      setOrigFullName(fullName);
      setTimeout(() => setProfileSuccess(false), 3000);
    }
    setProfileSaving(false);
  };

  const handleRequestCode = async () => {
    setPasswordLoading(true);
    setPasswordError('');

    const csrf = await getCSRF(setPasswordError);
    if (!csrf) { setPasswordLoading(false); return; }

    const result = await requestPasswordChangeCodeAction(csrf);
    if (result.error) {
      setPasswordError(result.error);
    } else {
      setPasswordStep('code_sent');
    }
    setPasswordLoading(false);
  };

  const handleConfirmPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordLoading(true);
    setPasswordError('');

    const csrf = await getCSRF(setPasswordError);
    if (!csrf) { setPasswordLoading(false); return; }

    const result = await confirmPasswordChangeAction(passwordCode, newPassword, csrf);
    if (result.error) {
      setPasswordError(result.error);
    } else {
      setPasswordStep('done');
      setPasswordCode('');
      setNewPassword('');
      setTimeout(() => setPasswordStep('idle'), 3000);
    }
    setPasswordLoading(false);
  };

  if (profileLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <div className="container max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-bold">{t('profile.title')}</h1>
        </div>

        {/* Profile Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <User className="h-5 w-5" />
              {t('profile.personalInfo')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleProfileSave} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="username" className="text-sm font-medium">{t('profile.username')}</label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={profileSaving}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="fullName" className="text-sm font-medium">{t('profile.fullName')}</label>
                <input
                  id="fullName"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  disabled={profileSaving}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                  placeholder={t('profile.fullName')}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  {t('profile.email')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    value={email}
                    readOnly
                    className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm opacity-70"
                  />
                  {emailVerified && (
                    <span className="flex items-center gap-1 text-xs text-green-600 whitespace-nowrap">
                      <CheckCircle2 className="h-3.5 w-3.5" /> {t('admin.users.active')}
                    </span>
                  )}
                </div>
              </div>

              {profileError && (
                <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
                  {profileError}
                </div>
              )}

              {profileSuccess && (
                <div className="p-3 text-sm text-green-600 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md">
                  {t('profile.profileUpdated')}
                </div>
              )}

              <Button
                type="submit"
                disabled={profileSaving || (username === origUsername && fullName === origFullName)}
              >
                {profileSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {profileSaving ? t('profile.updating') : t('profile.updateProfile')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Separator />

        {/* Password Change */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Lock className="h-5 w-5" />
              {t('profile.changePassword')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {passwordStep === 'done' ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <p className="text-sm text-muted-foreground">{t('profile.passwordChanged')}</p>
              </div>
            ) : passwordStep === 'idle' ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t('profile.codeSent')}
                </p>

                {passwordError && (
                  <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
                    {passwordError}
                  </div>
                )}

                <Button onClick={handleRequestCode} disabled={passwordLoading || !email || !emailVerified}>
                  {passwordLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  {passwordLoading ? t('profile.sendingCode') : t('profile.sendCode')}
                </Button>

                {!email && (
                  <p className="text-xs text-muted-foreground">{t('profile.email')}</p>
                )}
                {email && !emailVerified && (
                  <p className="text-xs text-muted-foreground">{t('auth.verifyEmail.title')}</p>
                )}
              </div>
            ) : (
              <form onSubmit={handleConfirmPasswordChange} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t('auth.forgotPassword.subtitleCode', { email })}
                </p>

                <div className="space-y-2">
                  <label htmlFor="pwCode" className="text-sm font-medium">{t('profile.codeLabel')}</label>
                  <input
                    id="pwCode"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    required
                    value={passwordCode}
                    onChange={(e) => setPasswordCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    disabled={passwordLoading}
                    className="flex h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-center text-2xl tracking-[0.5em] font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                    placeholder="000000"
                  />
                </div>

                <div className="space-y-2">
                  <label htmlFor="newPw" className="text-sm font-medium">{t('profile.newPassword')}</label>
                  <div className="relative">
                    <input
                      id="newPw"
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={passwordLoading}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      placeholder={t('auth.register.passwordPlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {passwordError && (
                  <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
                    {passwordError}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button type="submit" disabled={passwordLoading || passwordCode.length !== 6}>
                    {passwordLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    {t('profile.changePassword')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => { setPasswordStep('idle'); setPasswordError(''); setPasswordCode(''); setNewPassword(''); }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
