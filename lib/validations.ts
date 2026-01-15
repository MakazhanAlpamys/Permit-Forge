// ============================================================================
// Zod Validation Schemas (Security-First)
// ============================================================================

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Security Helpers
// -----------------------------------------------------------------------------

// Sanitize string to prevent XSS (removes HTML tags)
const sanitizeString = (s: string) => s.replace(/<[^>]*>/g, '').trim();

// Sanitize for SQL-like injection patterns (additional layer - DB should use parameterized queries)
const sanitizeSQLPatterns = (s: string) => 
  s.replace(/(['";]|--|\bOR\b|\bAND\b|\bUNION\b|\bSELECT\b|\bDROP\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b)/gi, '');

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
// Profile Update Schema (Restricted fields)
// -----------------------------------------------------------------------------

export const updateProfileSchema = z.object({
  // Only allow safe fields to be updated
  full_name: z.string()
    .max(100, 'Name must be 100 characters or less')
    .transform(sanitizeString)
    .optional(),
}).strict(); // Reject any extra fields

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// Fields that are NEVER allowed to be updated via profile update
export const FORBIDDEN_PROFILE_FIELDS = [
  'id',
  'username', 
  'role', 
  'password_hash', 
  'blocked',
  'blocked_reason',
  'blocked_at',
  'blocked_by',
  'created_at',
] as const;

// -----------------------------------------------------------------------------
// Change Password Schema
// -----------------------------------------------------------------------------

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

// -----------------------------------------------------------------------------
// Chat Session Schema
// -----------------------------------------------------------------------------

export const createSessionSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(100, 'Title must be 100 characters or less')
    .transform(sanitizeString),
});

export const saveMessageSchema = z.object({
  sessionId: uuidSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string()
    .min(1, 'Content is required')
    .max(50000, 'Content too large'),
  citations: z.array(z.object({
    chunkId: z.number().int().positive(),
    page: z.number().int().nonnegative(),
    section: z.string().optional(),
    excerpt: z.string(),
    similarity: z.number().min(0).max(1),
  })).optional(),
  complianceStatus: z.enum(['compliant', 'non-compliant', 'requires-review', 'pending']).optional(),
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
// Admin User Management
// -----------------------------------------------------------------------------

export const updateUserRoleSchema = z.object({
  userId: uuidSchema,
  role: z.enum(['admin', 'user']),
});

export const blockUserSchema = z.object({
  userId: uuidSchema,
  blocked: z.boolean(),
  reason: z.string()
    .max(500)
    .transform(sanitizeString)
    .optional(),
});

export const adminResetPasswordSchema = z.object({
  userId: uuidSchema,
  newPassword: passwordSchema,
});

export const adminDeleteUserSchema = z.object({
  userId: uuidSchema,
});

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

// -----------------------------------------------------------------------------
// Search/Filter Schemas (SQL injection protection)
// -----------------------------------------------------------------------------

export const searchQuerySchema = z.object({
  query: z.string()
    .max(200, 'Search query too long')
    .transform(sanitizeSQLPatterns)
    .transform(sanitizeString),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;



