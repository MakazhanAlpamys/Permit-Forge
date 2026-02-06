// ============================================================================
// Zod Validation Schemas (Security-First)
// ============================================================================

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Security Helpers
// -----------------------------------------------------------------------------

// Sanitize string to prevent XSS (removes HTML tags)
const sanitizeString = (s: string) => s.replace(/<[^>]*>/g, '').trim();

// -----------------------------------------------------------------------------
// Password Validation (Unified - min 8 chars with complexity requirements)
// -----------------------------------------------------------------------------

const passwordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password must be 100 characters or less')
  .refine(
    (password) => /[A-Z]/.test(password),
    'Password must contain at least one uppercase letter (A-Z)'
  )
  .refine(
    (password) => /[a-z]/.test(password),
    'Password must contain at least one lowercase letter (a-z)'
  )
  .refine(
    (password) => /[0-9]/.test(password),
    'Password must contain at least one digit (0-9)'
  )
  .refine(
    (password) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password),
    'Password must contain at least one special character (!@#$%^&*...)'
  );

// Helper function to validate password (for use in server actions)
export function validatePassword(password: string): { valid: boolean; error?: string } {
  const result = passwordSchema.safeParse(password);
  if (!result.success) {
    return { valid: false, error: result.error.issues[0].message };
  }
  return { valid: true };
}

// -----------------------------------------------------------------------------
// UUID Validation (Strict)
// -----------------------------------------------------------------------------

export const uuidSchema = z.string()
  .uuid('Invalid UUID format')
  .refine(
    (uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid),
    'Invalid UUID format'
  );

// -----------------------------------------------------------------------------
// Chat Message Validation (with XSS protection)
// -----------------------------------------------------------------------------

export const chatMessageSchema = z.object({
  message: z.string()
    .min(1, 'Message is required')
    .max(500, 'Message must be 500 characters or less')
    .transform(sanitizeString),
  sessionId: z.string().uuid().optional().nullable(),
});

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

// -----------------------------------------------------------------------------
// User Input Validation (Strict)
// -----------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be 50 characters or less')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .transform(s => s.toLowerCase()), // Normalize to lowercase
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password must be 100 characters or less'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be 50 characters or less')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .transform(s => s.toLowerCase()),
  password: passwordSchema,
  full_name: z.string()
    .max(100)
    .transform(sanitizeString)
    .optional(),
  role: z.enum(['admin', 'user']).default('user'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

// -----------------------------------------------------------------------------
// Change Password Schema
// -----------------------------------------------------------------------------

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

// -----------------------------------------------------------------------------
// Citation Schema
// -----------------------------------------------------------------------------

export const citationSchema = z.object({
  chunkId: z.number().int().positive(),
  page: z.number().int().nonnegative(),
  section: z.string().optional(),
  excerpt: z.string(),
  similarity: z.number().min(0).max(1),
});

export const citationsArraySchema = z.array(citationSchema);

// -----------------------------------------------------------------------------
// Pagination Schema
// -----------------------------------------------------------------------------

export const paginationSchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

// -----------------------------------------------------------------------------
// Session Token Payload
// -----------------------------------------------------------------------------

export const jwtPayloadSchema = z.object({
  sub: z.string().uuid(),
  username: z.string(),
  role: z.enum(['admin', 'user']),
  iat: z.number(),
  exp: z.number(),
});

export type JWTPayload = z.infer<typeof jwtPayloadSchema>;



