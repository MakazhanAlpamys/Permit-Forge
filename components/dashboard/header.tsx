'use client';

// ============================================================================
// Header Component
// ============================================================================

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { logoutAction, getCSRFTokenAction } from '@/actions/auth';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationBell } from '@/components/notifications';
import {
  Menu,
  LogOut
} from 'lucide-react';

interface HeaderProps {
  onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const { theme } = useTheme();
  const [csrfToken, setCsrfToken] = useState('');

  useEffect(() => {
    // TS-M-2 / v1.6.0 Part F: catch + log CSRF fetch failure.
    getCSRFTokenAction()
      .then((t) => setCsrfToken(t ?? ''))
      .catch(err => console.error('CSRF token fetch failed:', err));
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className="flex h-14 items-center px-4 lg:px-6">
        {/* Mobile Menu Button */}
        <Button
          variant="ghost"
          size="icon"
          className="mr-2 lg:hidden"
          onClick={onMenuClick}
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle menu</span>
        </Button>

        {/* Logo — click to go home */}
        <Link href="/" className="flex items-center gap-2">
          <Image
            src={theme === 'dark' ? '/white-icon.svg' : '/black-icon.svg'}
            alt="PermitForge"
            width={48}
            height={48}
            className="h-12 w-auto"
          />
        </Link>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right Actions */}
        <div className="flex items-center gap-2">
          {/* Notifications */}
          <NotificationBell />

          {/* Theme Toggle Button */}
          <ThemeToggle />

          {/* Logout Button */}
          {/* CP-D-1 (v1.2.0): keep the button disabled until the CSRF token has
              actually been fetched. The server-side logoutAction is forgiving
              of a missing token (proceeds with destroy and audit-logs the
              bypass), but disabling client-side prevents that audit-log noise
              and the brief flash of "csrf invalid" log on every page load. */}
          <form action={logoutAction}>
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              type="submit"
              disabled={!csrfToken}
            >
              <LogOut className="h-5 w-5" />
              <span className="sr-only">Logout</span>
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
