// ============================================================================
// ICU-independent relative-time formatting
// ============================================================================
// Some JS runtimes ship CLDR relative-time data for en/ru but NOT for Kazakh,
// so `new Intl.RelativeTimeFormat('kk-KZ').format(-6, 'day')` silently falls
// back to the root locale and renders "-6 d" / "-17 min" instead of
// "6 күн бұрын". We render the relative portion from our own i18n dictionaries
// (common.time.*) so the output is correct in en/ru/kk on ANY machine.
//
// Absolute dates (> 7 days) still go through Intl.DateTimeFormat, whose locale
// data is far more widely present; if even that is missing we degrade to a
// plain numeric date rather than throwing.

type Translate = (key: string, options?: { count?: number }) => string;

/** Map our internal locale code to a BCP-47 tag for Intl.DateTimeFormat. */
export function localeTag(locale: string): string {
  return locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';
}

/**
 * Human-readable "time ago" string driven by i18n keys (no dependency on
 * Intl.RelativeTimeFormat locale data). Falls back to an absolute date beyond
 * 7 days.
 */
export function formatTimeAgo(input: Date | string | number, t: Translate, locale: string): string {
  const date = input instanceof Date ? input : new Date(input);
  const ms = Date.now() - date.getTime();

  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return t('common.time.justNow');

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t('common.time.minutesAgo', { count: minutes });

  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return t('common.time.hoursAgo', { count: hours });

  const days = Math.floor(ms / 86_400_000);
  if (days <= 7) return t('common.time.daysAgo', { count: days });

  const tag = localeTag(locale);
  try {
    return date.toLocaleDateString(tag, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return date.toLocaleDateString();
  }
}
