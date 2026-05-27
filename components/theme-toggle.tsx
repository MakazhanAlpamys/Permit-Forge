'use client';

// ============================================================================
// Theme Toggle Button Component
// ============================================================================

import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/theme-provider';
import { Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ThemeToggleProps {
  variant?: 'icon' | 'text';
  className?: string;
}

export function ThemeToggle({ variant = 'icon', className }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();

  if (variant === 'text') {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleTheme}
        className={className}
      >
        {theme === 'dark' ? (
          <>
            <Sun className="h-4 w-4 mr-2" />
            {t('common.lightMode')}
          </>
        ) : (
          <>
            <Moon className="h-4 w-4 mr-2" />
            {t('common.darkMode')}
          </>
        )}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      className={`text-muted-foreground ${className || ''}`}
      aria-label={t('common.toggleTheme')}
    >
      {theme === 'dark' ? (
        <Sun className="h-5 w-5" />
      ) : (
        <Moon className="h-5 w-5" />
      )}
      <span className="sr-only">{t('common.toggleTheme')}</span>
    </Button>
  );
}
