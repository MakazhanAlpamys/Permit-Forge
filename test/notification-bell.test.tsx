/**
 * @vitest-environment jsdom
 */
// ============================================================================
// NotificationBell — optimistic-state rollback on mark-read failure (B15 / H10)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockGetNotifications = vi.fn();
const mockMarkNotificationRead = vi.fn();
const mockMarkAllNotificationsRead = vi.fn();

vi.mock('@/actions/notifications', () => ({
  getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
  markNotificationRead: (...args: unknown[]) => mockMarkNotificationRead(...args),
  markAllNotificationsRead: (...args: unknown[]) => mockMarkAllNotificationsRead(...args),
}));

vi.mock('@/actions/auth', () => ({
  getCSRFTokenAction: vi.fn().mockResolvedValue('csrf-test'),
}));

const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

import { NotificationBell } from '@/components/notifications/notification-bell';

const oneUnread = {
  data: [
    {
      id: 'n-1',
      type: 'permit_submitted' as const,
      title: 'Submitted',
      body: 'Permit X was submitted',
      read: false,
      createdAt: new Date().toISOString(),
      data: { permitId: 'permit-123' },
    },
  ],
  unreadCount: 1,
  error: null,
};

describe('NotificationBell mark-read rollback (B15 / H10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNotifications.mockResolvedValue(oneUnread);
  });

  it('rolls back optimistic read state when markNotificationRead returns success:false', async () => {
    mockMarkNotificationRead.mockResolvedValue({ success: false, error: 'DB error' });

    render(<NotificationBell />);

    // Wait for the initial fetch to populate the badge.
    const badge = await screen.findByText('1');
    expect(badge).toBeInTheDocument();

    // Open the dropdown.
    fireEvent.click(screen.getByRole('button'));

    // Click the notification.
    const notifButton = await screen.findByText('Permit X was submitted');
    fireEvent.click(notifButton.closest('button')!);

    // After server-rejection, badge must be 1 again (rolled back from optimistic 0).
    await waitFor(() => {
      expect(screen.queryByText('1')).toBeInTheDocument();
    });

    // Navigation still happens — the click intent stands.
    expect(mockRouterPush).toHaveBeenCalledWith('/permits/permit-123');
  });

  it('keeps optimistic read state when markNotificationRead succeeds', async () => {
    mockMarkNotificationRead.mockResolvedValue({ success: true });

    render(<NotificationBell />);
    await screen.findByText('1');

    fireEvent.click(screen.getByRole('button'));
    const notifButton = await screen.findByText('Permit X was submitted');
    fireEvent.click(notifButton.closest('button')!);

    // After success, the badge disappears (unreadCount 0 means no badge).
    await waitFor(() => {
      expect(screen.queryByText('1')).not.toBeInTheDocument();
    });
  });
});
