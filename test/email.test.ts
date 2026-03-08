import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const mockSendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: 'test-id' }));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
}));

import {
  generateSixDigitCode,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangeCodeEmail,
} from '@/lib/email';

// ============================================================================
// generateSixDigitCode
// ============================================================================
describe('generateSixDigitCode', () => {
  it('should return a string of length 6', () => {
    const code = generateSixDigitCode();
    expect(code).toHaveLength(6);
  });

  it('should return only digits', () => {
    const code = generateSixDigitCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('should pad with leading zeros when needed', () => {
    const cryptoSpy = vi.spyOn(crypto, 'randomInt');
    cryptoSpy.mockReturnValueOnce(0 as never);
    const code = generateSixDigitCode();
    expect(code).toBe('000000');
    cryptoSpy.mockRestore();
  });

  it('should pad small numbers with leading zeros', () => {
    const cryptoSpy = vi.spyOn(crypto, 'randomInt');
    cryptoSpy.mockReturnValueOnce(42 as never);
    const code = generateSixDigitCode();
    expect(code).toBe('000042');
    cryptoSpy.mockRestore();
  });

  it('should handle max value (999999)', () => {
    const cryptoSpy = vi.spyOn(crypto, 'randomInt');
    cryptoSpy.mockReturnValueOnce(999999 as never);
    const code = generateSixDigitCode();
    expect(code).toBe('999999');
    cryptoSpy.mockRestore();
  });

  it('should generate different codes (randomness check)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      codes.add(generateSixDigitCode());
    }
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ============================================================================
// sendVerificationEmail
// ============================================================================
describe('sendVerificationEmail', () => {
  const originalUser = process.env.SMTP_USER;
  const originalPass = process.env.SMTP_PASS;

  beforeEach(() => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'test-id' });
  });

  afterEach(() => {
    if (originalUser !== undefined) {
      process.env.SMTP_USER = originalUser;
    } else {
      delete process.env.SMTP_USER;
    }
    if (originalPass !== undefined) {
      process.env.SMTP_PASS = originalPass;
    } else {
      delete process.env.SMTP_PASS;
    }
  });

  it('should return false when SMTP credentials are not set', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const result = await sendVerificationEmail('user@test.com', '123456');
    expect(result).toBe(false);
  });

  it('should return true on successful send', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    const result = await sendVerificationEmail('user@test.com', '123456');
    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it('should call with correct params', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    await sendVerificationEmail('user@test.com', '123456');
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Verify your email — PermitForge',
      })
    );
  });

  it('should return false when send throws', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
    const result = await sendVerificationEmail('user@test.com', '123456');
    expect(result).toBe(false);
  });
});

// ============================================================================
// sendPasswordResetEmail
// ============================================================================
describe('sendPasswordResetEmail', () => {
  const originalUser = process.env.SMTP_USER;
  const originalPass = process.env.SMTP_PASS;

  beforeEach(() => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'test-id' });
  });

  afterEach(() => {
    if (originalUser !== undefined) {
      process.env.SMTP_USER = originalUser;
    } else {
      delete process.env.SMTP_USER;
    }
    if (originalPass !== undefined) {
      process.env.SMTP_PASS = originalPass;
    } else {
      delete process.env.SMTP_PASS;
    }
  });

  it('should return false when SMTP credentials are not set', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const result = await sendPasswordResetEmail('user@test.com', '654321');
    expect(result).toBe(false);
  });

  it('should return true on successful send', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    const result = await sendPasswordResetEmail('user@test.com', '654321');
    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it('should call with correct subject', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    await sendPasswordResetEmail('user@test.com', '654321');
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Password Reset — PermitForge',
      })
    );
  });

  it('should return false when send throws', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    mockSendMail.mockRejectedValueOnce(new Error('Network error'));
    const result = await sendPasswordResetEmail('user@test.com', '654321');
    expect(result).toBe(false);
  });
});

// ============================================================================
// sendPasswordChangeCodeEmail
// ============================================================================
describe('sendPasswordChangeCodeEmail', () => {
  const originalUser = process.env.SMTP_USER;
  const originalPass = process.env.SMTP_PASS;

  beforeEach(() => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'test-id' });
  });

  afterEach(() => {
    if (originalUser !== undefined) {
      process.env.SMTP_USER = originalUser;
    } else {
      delete process.env.SMTP_USER;
    }
    if (originalPass !== undefined) {
      process.env.SMTP_PASS = originalPass;
    } else {
      delete process.env.SMTP_PASS;
    }
  });

  it('should return false when SMTP credentials are not set', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const result = await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(result).toBe(false);
  });

  it('should return true on successful send', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    const result = await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it('should call with correct subject', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Password Change Code — PermitForge',
      })
    );
  });

  it('should return false when send throws', async () => {
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'test-pass';
    mockSendMail.mockRejectedValueOnce(new Error('Timeout'));
    const result = await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(result).toBe(false);
  });
});
