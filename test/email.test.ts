import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// The email module uses dynamic import: `const { Resend } = await import('resend')`
// We need to mock at the module level for dynamic imports to work
const mockSend = vi.fn().mockResolvedValue({ id: 'test-id' });
vi.mock('resend', () => ({
  Resend: class MockResend {
    emails = { send: mockSend };
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
  const originalEnv = process.env.RESEND_API_KEY;

  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({ id: 'test-id' });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RESEND_API_KEY = originalEnv;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('should return false when RESEND_API_KEY is not set', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendVerificationEmail('user@test.com', '123456');
    expect(result).toBe(false);
  });

  it('should return true on successful send', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const result = await sendVerificationEmail('user@test.com', '123456');
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it('should call with correct params', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    await sendVerificationEmail('user@test.com', '123456');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Verify your email — PermitForge',
        from: 'PermitForge <noreply@permitforge.com>',
      })
    );
  });

  it('should return false when send throws', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockSend.mockRejectedValueOnce(new Error('API error'));
    const result = await sendVerificationEmail('user@test.com', '123456');
    expect(result).toBe(false);
  });
});

// ============================================================================
// sendPasswordResetEmail
// ============================================================================
describe('sendPasswordResetEmail', () => {
  const originalEnv = process.env.RESEND_API_KEY;

  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({ id: 'test-id' });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RESEND_API_KEY = originalEnv;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('should return false when RESEND_API_KEY is not set', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendPasswordResetEmail('user@test.com', '654321');
    expect(result).toBe(false);
  });

  it('should return true on successful send', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const result = await sendPasswordResetEmail('user@test.com', '654321');
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it('should call with correct subject', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    await sendPasswordResetEmail('user@test.com', '654321');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Password Reset — PermitForge',
      })
    );
  });

  it('should return false when send throws', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockSend.mockRejectedValueOnce(new Error('Network error'));
    const result = await sendPasswordResetEmail('user@test.com', '654321');
    expect(result).toBe(false);
  });
});

// ============================================================================
// sendPasswordChangeCodeEmail
// ============================================================================
describe('sendPasswordChangeCodeEmail', () => {
  const originalEnv = process.env.RESEND_API_KEY;

  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({ id: 'test-id' });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RESEND_API_KEY = originalEnv;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('should return false when RESEND_API_KEY is not set', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(result).toBe(false);
  });

  it('should return true on successful send', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const result = await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it('should call with correct subject', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Password Change Code — PermitForge',
        from: 'PermitForge <noreply@permitforge.com>',
      })
    );
  });

  it('should return false when send throws', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockSend.mockRejectedValueOnce(new Error('Timeout'));
    const result = await sendPasswordChangeCodeEmail('user@test.com', '111111');
    expect(result).toBe(false);
  });
});
