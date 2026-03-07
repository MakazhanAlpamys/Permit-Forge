import { describe, it, expect } from 'vitest';
import { 
  loginSchema, 
  createUserSchema, 
  chatMessageSchema, 
  uuidSchema,
  paginationSchema,
} from '@/lib/validations';

describe('Validation Schemas', () => {
  // ============================================================================
  // Login Schema Tests
  // ============================================================================
  describe('loginSchema', () => {
    it('should accept valid login credentials', () => {
      const validLogin = {
        username: 'testuser',
        password: 'SecurePass123!',
      };
      
      const result = loginSchema.safeParse(validLogin);
      expect(result.success).toBe(true);
    });

    it('should reject empty username', () => {
      const invalidLogin = {
        username: '',
        password: 'SecurePass123!',
      };
      
      const result = loginSchema.safeParse(invalidLogin);
      expect(result.success).toBe(false);
    });

    it('should reject password under 6 characters', () => {
      const invalidLogin = {
        username: 'testuser',
        password: '12345',
      };
      
      const result = loginSchema.safeParse(invalidLogin);
      expect(result.success).toBe(false);
    });

    it('should reject password over 100 characters', () => {
      const invalidLogin = {
        username: 'testuser',
        password: 'a'.repeat(101),
      };
      
      const result = loginSchema.safeParse(invalidLogin);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Create User Schema Tests
  // ============================================================================
  describe('createUserSchema', () => {
    it('should accept valid user creation data', () => {
      const validUser = {
        username: 'newuser',
        password: 'SecurePass123!',
        role: 'user',
      };
      
      const result = createUserSchema.safeParse(validUser);
      expect(result.success).toBe(true);
    });

    it('should default role to user if not provided', () => {
      const validUser = {
        username: 'newuser',
        password: 'SecurePass123!',
      };
      
      const result = createUserSchema.safeParse(validUser);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('user');
      }
    });

    it('should reject invalid role', () => {
      const invalidUser = {
        username: 'newuser',
        password: 'SecurePass123!',
        role: 'superadmin',
      };
      
      const result = createUserSchema.safeParse(invalidUser);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // UUID Schema Tests
  // ============================================================================
  describe('uuidSchema', () => {
    it('should accept valid UUID', () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';
      
      const result = uuidSchema.safeParse(validUuid);
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID', () => {
      const invalidUuid = 'not-a-uuid';
      
      const result = uuidSchema.safeParse(invalidUuid);
      expect(result.success).toBe(false);
    });

    it('should reject SQL injection attempt', () => {
      const maliciousInput = "'; DROP TABLE users; --";
      
      const result = uuidSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Chat Message Schema Tests
  // ============================================================================
  describe('chatMessageSchema', () => {
    it('should accept valid chat message', () => {
      const validMessage = {
        message: 'Hello, how can I help you with building code compliance?',
      };
      
      const result = chatMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should trim whitespace', () => {
      const messageWithWhitespace = {
        message: '   Hello world   ',
      };
      
      const result = chatMessageSchema.safeParse(messageWithWhitespace);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.message).toBe('Hello world');
      }
    });

    it('should reject empty message', () => {
      const emptyMessage = {
        message: '',
      };
      
      const result = chatMessageSchema.safeParse(emptyMessage);
      expect(result.success).toBe(false);
    });

    it('should reject message over 2000 characters', () => {
      const longMessage = {
        message: 'a'.repeat(2001),
      };
      
      const result = chatMessageSchema.safeParse(longMessage);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Pagination Schema Tests
  // ============================================================================
  describe('paginationSchema', () => {
    it('should accept valid pagination params', () => {
      const validPagination = {
        limit: 20,
        cursor: '2024-01-01T00:00:00Z',
      };
      
      const result = paginationSchema.safeParse(validPagination);
      expect(result.success).toBe(true);
    });

    it('should use default limit if not provided', () => {
      const partialPagination = {};
      
      const result = paginationSchema.safeParse(partialPagination);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20); // Default is 20, not 10
      }
    });

    it('should reject limit over 100', () => {
      const invalidPagination = {
        limit: 150,
      };
      
      const result = paginationSchema.safeParse(invalidPagination);
      expect(result.success).toBe(false);
    });
  });

});
