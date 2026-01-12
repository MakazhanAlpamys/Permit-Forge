// ============================================================================
// Zod Validation Schemas
// ============================================================================

import { z } from 'zod';

// -----------------------------------------------------------------------------
// UUID Validation
// -----------------------------------------------------------------------------

export const uuidSchema = z.string().uuid('Invalid UUID format');

// -----------------------------------------------------------------------------
// Chat Message Validation
// -----------------------------------------------------------------------------

export const chatMessageSchema = z.object({
  message: z.string()
    .min(1, 'Message is required')
    .max(500, 'Message must be 500 characters or less')
    .transform(s => s.trim()),
  sessionId: z.string().uuid().optional().nullable(),
});

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

// -----------------------------------------------------------------------------
// User Input Validation
// -----------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be 50 characters or less')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  password: z.string()
    .min(6, 'Password must be at least 6 characters')
    .max(100, 'Password must be 100 characters or less'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be 50 characters or less')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password must be 100 characters or less'),
  full_name: z.string().max(100).optional(),
  role: z.enum(['admin', 'user']).default('user'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

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
  userId: z.string().uuid(),
  role: z.enum(['admin', 'user']),
});

export const blockUserSchema = z.object({
  userId: z.string().uuid(),
  blocked: z.boolean(),
  reason: z.string().max(500).optional(),
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



