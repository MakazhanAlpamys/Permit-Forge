import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserSchema, validatePassword, changePasswordSchema } from '@/lib/validations';

// ============================================================================
// Admin Create User Tests
// ============================================================================

describe('Admin Create User Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createUserSchema Tests
  // ---------------------------------------------------------------------------
  describe('createUserSchema', () => {
    it('should accept valid user data', () => {
      const result = createUserSchema.safeParse({
        username: 'newuser',
        password: 'SecureP@ss123',
        full_name: 'New User',
        role: 'user',
      });
      
      expect(result.success).toBe(true);
    });

    it('should accept valid admin user data', () => {
      const result = createUserSchema.safeParse({
        username: 'newadmin',
        password: 'Admin@123!',
        role: 'admin',
      });
      
      expect(result.success).toBe(true);
    });

    it('should reject username shorter than 3 characters', () => {
      const result = createUserSchema.safeParse({
        username: 'ab',
        password: 'SecureP@ss123',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 3 characters');
      }
    });

    it('should reject username with special characters', () => {
      const result = createUserSchema.safeParse({
        username: 'user@name',
        password: 'SecureP@ss123',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('letters, numbers, and underscores');
      }
    });

    it('should reject password shorter than 8 characters', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'Short1!',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 8 characters');
      }
    });

    it('should reject password without uppercase letter', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'lowercase123!',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('uppercase letter');
      }
    });

    it('should reject password without lowercase letter', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'UPPERCASE123!',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('lowercase letter');
      }
    });

    it('should reject password without digit', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'NoDigitsHere!',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('digit');
      }
    });

    it('should reject password without special character', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'NoSpecial123',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('special character');
      }
    });

    it('should reject invalid role', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'SecureP@ss123',
        role: 'superadmin',
      });
      
      expect(result.success).toBe(false);
    });

    it('should use default role of user when not specified', () => {
      const result = createUserSchema.safeParse({
        username: 'validuser',
        password: 'SecureP@ss123',
      });
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('user');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // validatePassword Helper Tests
  // ---------------------------------------------------------------------------
  describe('validatePassword', () => {
    it('should return valid for a strong password', () => {
      const result = validatePassword('SecureP@ss123');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error for short password', () => {
      const result = validatePassword('Ab1!xyz');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 8 characters');
    });

    it('should return error for password without uppercase', () => {
      const result = validatePassword('lowercase123!');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('uppercase letter');
    });

    it('should return error for password without lowercase', () => {
      const result = validatePassword('UPPERCASE123!');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('lowercase letter');
    });

    it('should return error for password without digit', () => {
      const result = validatePassword('NoDigitsHere!');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('digit');
    });

    it('should return error for password without special character', () => {
      const result = validatePassword('NoSpecial123');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('special character');
    });

    it('should accept various special characters', () => {
      const specialChars = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];
      
      for (const char of specialChars) {
        const result = validatePassword(`Password1${char}`);
        expect(result.valid).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // changePasswordSchema Tests
  // ---------------------------------------------------------------------------
  describe('changePasswordSchema', () => {
    it('should accept valid password change data', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'OldP@ssword1',
        newPassword: 'NewP@ssword1',
      });
      
      expect(result.success).toBe(true);
    });

    it('should reject empty current password', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: '',
        newPassword: 'NewP@ssword1',
      });
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Current password is required');
      }
    });

    it('should validate new password complexity', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'OldPassword',
        newPassword: 'weakpass',
      });
      
      expect(result.success).toBe(false);
    });
  });
});
