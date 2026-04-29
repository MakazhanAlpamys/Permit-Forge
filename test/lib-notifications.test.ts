// ============================================================================
// Coverage backfill for lib/notifications.ts (P2-T6f)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInsert, mockSelect, mockEq, mockSingle, mockFrom, mockSendMail, mockGetTransporter } =
  vi.hoisted(() => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockEq = vi.fn(() => ({ single: mockSingle, eq: mockEq }));
    const mockSelect = vi.fn(() => ({ eq: mockEq }));
    const mockFrom = vi.fn(() => ({
      insert: mockInsert,
      select: mockSelect,
    }));
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'ok' });
    const mockGetTransporter = vi.fn(() => ({ sendMail: mockSendMail }));
    return { mockInsert, mockSelect, mockEq, mockSingle, mockFrom, mockSendMail, mockGetTransporter };
  });

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

vi.mock('@/lib/email', () => ({
  getTransporter: () => mockGetTransporter(),
}));

import { createNotification, getNotificationContent } from '@/lib/notifications';

describe('lib/notifications > getNotificationContent', () => {
  it('produces a title+body for permit_submitted', () => {
    const r = getNotificationContent('permit_submitted', 'My Project');
    expect(r.title).toBe('Permit Submitted');
    expect(r.body).toContain('My Project');
  });

  it('appends comments when provided for approval', () => {
    const r = getNotificationContent('permit_approved', 'Tower', 'looks good');
    expect(r.body).toContain('looks good');
  });

  it('appends reason for rejection', () => {
    const r = getNotificationContent('permit_rejected', 'Tower', 'missing docs');
    expect(r.body).toContain('missing docs');
  });

  it('appends details for revision_requested', () => {
    const r = getNotificationContent('permit_revision_requested', 'Tower', 'fix sec 3.1');
    expect(r.body).toContain('fix sec 3.1');
  });

  it('uses generic fallback for unknown types', () => {
    // @ts-expect-error testing default branch with an out-of-union value
    const r = getNotificationContent('unknown_type', 'Tower');
    expect(r.title).toBe('Permit Update');
  });

  it('omits comments suffix when not provided', () => {
    const r = getNotificationContent('permit_approved', 'Tower');
    expect(r.body).not.toContain('Comments');
  });
});

describe('lib/notifications > createNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ error: null });
    mockSingle.mockResolvedValue({ data: null, error: null });
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it('inserts an in-app notification row', async () => {
    await createNotification({
      userId: 'user-1',
      type: 'permit_submitted',
      title: 'Hello',
      body: 'Body',
    });

    expect(mockFrom).toHaveBeenCalledWith('notifications');
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        type: 'permit_submitted',
        title: 'Hello',
        body: 'Body',
        read: false,
      })
    );
  });

  it('does not throw when DB insert fails', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'boom' } });
    await expect(
      createNotification({ userId: 'user-1', type: 'permit_submitted', title: 'x', body: 'y' })
    ).resolves.toBeUndefined();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips email when SMTP is not configured', async () => {
    await createNotification({
      userId: 'user-1',
      type: 'permit_submitted',
      title: 'x',
      body: 'y',
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('sends email when SMTP configured and user has an email', async () => {
    process.env.SMTP_USER = 'sender@test.com';
    process.env.SMTP_PASS = 'pw';
    mockSingle.mockResolvedValueOnce({
      data: { email: 'user@test.com', username: 'u' },
      error: null,
    });

    await createNotification({
      userId: 'user-1',
      type: 'permit_approved',
      title: 'Approved',
      body: 'Approved!',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Approved',
      })
    );
  });

  it('does not throw when sendMail rejects (email failure is non-fatal)', async () => {
    process.env.SMTP_USER = 'sender@test.com';
    process.env.SMTP_PASS = 'pw';
    mockSingle.mockResolvedValueOnce({
      data: { email: 'user@test.com', username: 'u' },
      error: null,
    });
    mockSendMail.mockRejectedValueOnce(new Error('smtp offline'));

    await expect(
      createNotification({
        userId: 'user-1',
        type: 'permit_submitted',
        title: 'x',
        body: 'y',
      })
    ).resolves.toBeUndefined();
  });

  it('skips email when user has no email address', async () => {
    process.env.SMTP_USER = 'sender@test.com';
    process.env.SMTP_PASS = 'pw';
    mockSingle.mockResolvedValueOnce({ data: { email: null, username: 'u' }, error: null });

    await createNotification({
      userId: 'user-1',
      type: 'permit_submitted',
      title: 'x',
      body: 'y',
    });

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('respects sendEmail=false even when SMTP is configured', async () => {
    process.env.SMTP_USER = 'sender@test.com';
    process.env.SMTP_PASS = 'pw';

    await createNotification({
      userId: 'user-1',
      type: 'permit_submitted',
      title: 'x',
      body: 'y',
      sendEmail: false,
    });

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('escapes HTML in subject body when generating email html', async () => {
    process.env.SMTP_USER = 'sender@test.com';
    process.env.SMTP_PASS = 'pw';
    mockSingle.mockResolvedValueOnce({
      data: { email: 'user@test.com', username: 'u' },
      error: null,
    });

    await createNotification({
      userId: 'user-1',
      type: 'permit_submitted',
      title: '<script>alert(1)</script>',
      body: 'bad <b>code</b>',
      data: { permitName: '<img src=x>' },
    });

    const html = mockSendMail.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });
});
