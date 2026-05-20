// ============================================================================
// E13 — lib/notifications.ts coverage
// ============================================================================
// Covers createNotification (in-app + optional email), getNotificationContent
// branches, and HTML escaping in the rendered email body. The SMTP transport
// and Supabase are both mocked.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------------

const mockSendMail = vi.fn();
const mockGetTransporter = vi.fn(() => ({ sendMail: mockSendMail }));

vi.mock('@/lib/email', () => ({
  getTransporter: () => mockGetTransporter(),
}));

import { createAdminClient } from '@/lib/supabase-server';
import { createNotification, getNotificationContent } from '@/lib/notifications';

// Helper: build a supabase client mock that satisfies the chain shape used
// by createNotification: from('notifications').insert() + from('users')...
// The order of from() calls is: notifications.insert, then users.select.
function withSupabase(opts: {
  insertResult?: { data: unknown; error: unknown };
  userRow?: { data: unknown; error: unknown };
}) {
  const insert = vi.fn().mockResolvedValue(opts.insertResult ?? { data: null, error: null });

  const single = vi.fn().mockResolvedValue(opts.userRow ?? { data: null, error: null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });

  const from = vi.fn((table: string) => {
    if (table === 'notifications') return { insert };
    if (table === 'users') return { select };
    return {};
  });

  vi.mocked(createAdminClient).mockReturnValueOnce({
    from,
    rpc: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return { from, insert, single };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clean SMTP env so the email branch is opt-in per test.
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

afterEach(() => {
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

// ----------------------------------------------------------------------------
// getNotificationContent
// ----------------------------------------------------------------------------

describe('getNotificationContent', () => {
  it('formats permit_submitted body with project name', () => {
    const out = getNotificationContent('permit_submitted', 'My Tower');
    expect(out.title).toBe('Permit Submitted');
    expect(out.body).toContain('"My Tower"');
  });

  it('formats permit_under_review', () => {
    const out = getNotificationContent('permit_under_review', 'P1');
    expect(out.title).toBe('Permit Under Review');
    expect(out.body).toContain('"P1"');
  });

  it('appends comments to permit_approved when provided', () => {
    const out = getNotificationContent('permit_approved', 'P1', 'looks good');
    expect(out.body).toContain('Comments: looks good');
  });

  it('omits comments suffix when none provided', () => {
    const out = getNotificationContent('permit_approved', 'P1');
    expect(out.body).not.toMatch(/Comments/);
  });

  it('appends reason for permit_rejected', () => {
    const out = getNotificationContent('permit_rejected', 'P1', 'missing FAR');
    expect(out.body).toContain('Reason: missing FAR');
  });

  it('appends details for permit_revision_requested', () => {
    const out = getNotificationContent('permit_revision_requested', 'P1', 'fix step 2');
    expect(out.body).toContain('Details: fix step 2');
  });

  it('falls back to generic update on unknown type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = getNotificationContent('unknown' as any, 'P1');
    expect(out.title).toBe('Permit Update');
    expect(out.body).toContain('"P1"');
  });
});

// ----------------------------------------------------------------------------
// createNotification — in-app + email gating
// ----------------------------------------------------------------------------

describe('createNotification', () => {
  it('inserts an in-app notification row with the correct payload', async () => {
    const { from, insert } = withSupabase({});
    await createNotification({
      userId: 'u1',
      type: 'permit_submitted',
      title: 'Permit Submitted',
      body: 'Your permit "X" has been submitted.',
      data: { permitId: 'p1' },
      sendEmail: false,
    });

    expect(from).toHaveBeenCalledWith('notifications');
    const row = insert.mock.calls[0][0];
    expect(row.user_id).toBe('u1');
    expect(row.type).toBe('permit_submitted');
    expect(row.title).toBe('Permit Submitted');
    expect(row.body).toContain('"X"');
    expect(row.read).toBe(false);
    expect(row.data).toEqual({ permitId: 'p1' });
  });

  it('does NOT send email when SMTP env vars are missing', async () => {
    withSupabase({ userRow: { data: { email: 'a@b.com', username: 'alice' }, error: null } });
    await createNotification({
      userId: 'u1',
      type: 'permit_approved',
      title: 'Approved',
      body: 'ok',
      sendEmail: true,
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does NOT send email when sendEmail=false even with SMTP configured', async () => {
    process.env.SMTP_USER = 'noreply@example.com';
    process.env.SMTP_PASS = 'sekrit';

    withSupabase({ userRow: { data: { email: 'a@b.com', username: 'alice' }, error: null } });
    await createNotification({
      userId: 'u1',
      type: 'permit_approved',
      title: 'Approved',
      body: 'ok',
      sendEmail: false,
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('sends email when SMTP configured and sendEmail=true', async () => {
    process.env.SMTP_USER = 'noreply@example.com';
    process.env.SMTP_PASS = 'sekrit';

    withSupabase({ userRow: { data: { email: 'a@b.com', username: 'alice' }, error: null } });
    await createNotification({
      userId: 'u1',
      type: 'permit_approved',
      title: 'Approved',
      body: 'ok',
      sendEmail: true,
    });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const args = mockSendMail.mock.calls[0][0];
    expect(args.to).toBe('a@b.com');
    expect(args.from).toContain('noreply@example.com');
    expect(args.subject).toBe('Approved');
  });

  it('escapes HTML in title/body/permitName in the email body', async () => {
    process.env.SMTP_USER = 'noreply@example.com';
    process.env.SMTP_PASS = 'sekrit';

    withSupabase({ userRow: { data: { email: 'a@b.com', username: 'a' }, error: null } });
    await createNotification({
      userId: 'u1',
      type: 'permit_approved',
      title: '<script>alert(1)</script>',
      body: 'My <evil> tag & quote " end',
      data: { permitName: '"><img onerror=1>' },
      sendEmail: true,
    });
    const html = mockSendMail.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;evil&gt;');
    // permitName escapes properly: literal `<img onerror=1>` must NOT survive.
    expect(html).not.toContain('<img onerror=1>');
  });

  it('skips email when user lookup returns no email field', async () => {
    process.env.SMTP_USER = 'noreply@example.com';
    process.env.SMTP_PASS = 'sekrit';

    withSupabase({ userRow: { data: { email: null, username: 'x' }, error: null } });
    await createNotification({
      userId: 'u1',
      type: 'permit_approved',
      title: 't',
      body: 'b',
      sendEmail: true,
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does not throw when sendMail itself rejects', async () => {
    process.env.SMTP_USER = 'noreply@example.com';
    process.env.SMTP_PASS = 'sekrit';

    withSupabase({ userRow: { data: { email: 'a@b.com', username: 'a' }, error: null } });
    mockSendMail.mockRejectedValueOnce(new Error('SMTP down'));

    await expect(
      createNotification({
        userId: 'u1',
        type: 'permit_approved',
        title: 't',
        body: 'b',
        sendEmail: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not throw when in-app insert errors (returns without sending email)', async () => {
    process.env.SMTP_USER = 'noreply@example.com';
    process.env.SMTP_PASS = 'sekrit';

    withSupabase({ insertResult: { data: null, error: { message: 'fk violation' } } });
    await createNotification({
      userId: 'u1',
      type: 'permit_approved',
      title: 't',
      body: 'b',
      sendEmail: true,
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does not throw when the supabase client itself throws', async () => {
    vi.mocked(createAdminClient).mockImplementationOnce(() => {
      throw new Error('connection refused');
    });
    await expect(
      createNotification({ userId: 'u1', type: 'permit_approved', title: 't', body: 'b' }),
    ).resolves.toBeUndefined();
  });
});
