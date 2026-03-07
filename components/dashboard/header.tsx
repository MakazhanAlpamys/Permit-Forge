'use client';

// ============================================================================
// Header Component
// ============================================================================

import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { logoutAction } from '@/actions/auth';
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

        {/* Logo */}
        <div className="flex items-center gap-2">
          <Image 
            src={theme === 'dark' ? '/white-icon.svg' : '/black-icon.svg'} 
            alt="PermitForge"
            width={48} 
            height={48}
            className="h-12 w-auto"
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right Actions */}
        <div className="flex items-center gap-2">
          {/* Notifications */}
          <NotificationBell />

          {/* Theme Toggle Button */}
          <ThemeToggle />

          {/* Logout Button */}
          <form action={logoutAction}>
            <Button variant="ghost" size="icon" className="text-muted-foreground" type="submit">
              <LogOut className="h-5 w-5" />
              <span className="sr-only">Logout</span>
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
