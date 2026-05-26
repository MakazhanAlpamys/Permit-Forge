// ============================================================================
// Zod Validation Schemas (Security-First)
// ============================================================================
// R-M-5 / v1.9.0 Part C: previously this file exported 10 `*Input` types
// (LoginInput, RegisterInput, ChatMessageInput, …) that no action, component,
// or test ever imported — actions parse with the schema and inline the result
// type. Removed to shrink the module's public API. The schemas themselves are
// kept exported; callers reach for `z.infer<typeof X>` inline if they need it.
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

/**
 * SIM-M-10 / v1.9.0 Part D: client-side password validator. Returns the first
 * rule violation as a string, or null on success. Reuses the same Zod schema
 * as `validatePassword` (which server actions use) so a future tightening of
 * the password rules lands in both places at once — no more silent drift
 * between client preflight and server reject.
 */
export function validatePasswordClient(password: string): string | null {
  const result = passwordSchema.safeParse(password);
  return result.success ? null : (result.error.issues[0]?.message ?? 'Password invalid');
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

// -----------------------------------------------------------------------------
// Registration Schema (with email)
// -----------------------------------------------------------------------------

export const registerSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be 50 characters or less')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .transform(s => s.toLowerCase()),
  email: z.string()
    .email('Invalid email address')
    .max(255, 'Email must be 255 characters or less')
    .transform(s => s.toLowerCase().trim()),
  password: passwordSchema,
});

// -----------------------------------------------------------------------------
// Email Verification Schema
// -----------------------------------------------------------------------------

export const verifyEmailSchema = z.object({
  email: z.string().email('Invalid email address').transform(s => s.toLowerCase().trim()),
  code: z.string().length(6, 'Verification code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
});

// -----------------------------------------------------------------------------
// Forgot Password Schema
// -----------------------------------------------------------------------------

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address').transform(s => s.toLowerCase().trim()),
});

// -----------------------------------------------------------------------------
// Reset Password Schema
// -----------------------------------------------------------------------------

export const resetPasswordSchema = z.object({
  email: z.string().email('Invalid email address').transform(s => s.toLowerCase().trim()),
  code: z.string().length(6, 'Reset code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
  newPassword: passwordSchema,
});

// -----------------------------------------------------------------------------
// Update Profile Schema
// -----------------------------------------------------------------------------

export const updateProfileSchema = z.object({
  full_name: z.string().max(100).transform(sanitizeString).optional(),
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be 50 characters or less')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .transform(s => s.toLowerCase())
    .optional(),
});

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

const citationSchema = z.object({
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

// -----------------------------------------------------------------------------
// Permit Application Schemas
// -----------------------------------------------------------------------------

export const projectTypeSchema = z.enum([
  'residential', 'commercial', 'industrial', 'mixed_use', 'institutional'
]);

export const buildingDetailsSchema = z.object({
  numberOfFloors: z.number().int().min(1, 'Must have at least 1 floor').max(200),
  totalBuiltUpArea: z.number().positive('Built-up area must be positive').max(1000000),
  plotArea: z.number().positive('Plot area must be positive').max(1000000),
  buildingHeight: z.number().positive('Building height must be positive').max(1000),
  numberOfUnits: z.number().int().min(0).max(10000),
  numberOfParkingSpaces: z.number().int().min(0).max(50000),
  occupancyType: z.string().min(1, 'Occupancy type is required').max(100).transform(sanitizeString),
  constructionType: z.string().min(1, 'Construction type is required').max(100).transform(sanitizeString),
});

// C24H/M23: drafts can be saved incrementally — the user types one field
// and clicks Next. Submit-time guard (submit_permit_atomic RPC) enforces
// the actually-required fields.
// R-M-6 / v1.9.0 Part C: non-exported — only used by updateBuildingDetailsSchema below.
const buildingDetailsPartialSchema = z.object({
  numberOfFloors: z.number().int().min(0).max(200).optional(),
  totalBuiltUpArea: z.number().min(0).max(1000000).optional(),
  plotArea: z.number().min(0).max(1000000).optional(),
  buildingHeight: z.number().min(0).max(1000).optional(),
  numberOfUnits: z.number().int().min(0).max(10000).optional(),
  numberOfParkingSpaces: z.number().int().min(0).max(50000).optional(),
  occupancyType: z.string().max(100).transform(sanitizeString).optional(),
  constructionType: z.string().max(100).transform(sanitizeString).optional(),
});

export const complianceRequirementsSchema = z.object({
  fireSafety: z.boolean(),
  accessibility: z.boolean(),
  parkingCompliance: z.boolean(),
  structuralSafety: z.boolean(),
  mepSystems: z.boolean(),
  energyEfficiency: z.boolean(),
  additionalNotes: z.string().max(2000).transform(sanitizeString).optional(),
});

export const createPermitSchema = z.object({
  projectName: z.string()
    .min(3, 'Project name must be at least 3 characters')
    .max(200, 'Project name must be 200 characters or less')
    .transform(sanitizeString),
  projectType: projectTypeSchema,
  projectAddress: z.string()
    .min(5, 'Address must be at least 5 characters')
    .max(500, 'Address must be 500 characters or less')
    .transform(sanitizeString),
  plotNumber: z.string().max(50).transform(sanitizeString).optional(),
  projectDescription: z.string().max(2000).transform(sanitizeString).optional(),
});

export type CreatePermitInput = z.infer<typeof createPermitSchema>;

export const updateBuildingDetailsSchema = z.object({
  permitId: uuidSchema,
  buildingDetails: buildingDetailsPartialSchema,
  // X17: optimistic-locking version captured at load time. Optional for back-
  // compat with the existing callers that haven't been wired through yet.
  expectedVersion: z.number().int().nonnegative().optional(),
});

export type UpdateBuildingDetailsInput = z.infer<typeof updateBuildingDetailsSchema>;

export const updateComplianceRequirementsSchema = z.object({
  permitId: uuidSchema,
  complianceRequirements: complianceRequirementsSchema,
  expectedVersion: z.number().int().nonnegative().optional(),
});

export type UpdateComplianceRequirementsInput = z.infer<typeof updateComplianceRequirementsSchema>;

export const reviewPermitSchema = z.object({
  permitId: uuidSchema,
  action: z.enum(['approve', 'reject', 'request_revision']),
  comments: z.string()
    .min(1, 'Review comments are required')
    .max(2000, 'Comments must be 2000 characters or less')
    .transform(sanitizeString),
});

export type ReviewPermitInput = z.infer<typeof reviewPermitSchema>;

// -----------------------------------------------------------------------------
// File Upload Validation
// -----------------------------------------------------------------------------

export const fileUploadSchema = z.object({
  permitId: uuidSchema,
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive().max(10 * 1024 * 1024, 'File must be under 10MB'),
  fileType: z.string().min(1),
});

// -----------------------------------------------------------------------------
// Session Token Payload
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// LLM compliance-check response (C23H/M22)
// -----------------------------------------------------------------------------
// Validates the JSON the model is supposed to return. Strict shape + sane
// length caps so a hallucinated megabyte of text or a malicious nested
// payload can't blow up downstream renderers.

const complianceCheckReferenceObjectSchema = z.object({
  page: z.number().int().min(0).max(100_000),
  section: z.string().max(500),
  excerpt: z.string().max(2000),
});

// Models sometimes return references as plain strings ("Section 2.1, Page 30")
// instead of objects. Accept either and normalize strings into the object
// shape so downstream renderers see one consistent schema.
const complianceCheckReferenceSchema = z.union([
  complianceCheckReferenceObjectSchema,
  z.string().max(500).transform((s) => ({ page: 0, section: s, excerpt: '' })),
]);

const complianceCheckItemSchema = z.object({
  category: z.string().min(1).max(200),
  status: z.enum(['compliant', 'non_compliant', 'requires_review']),
  details: z.string().max(4000),
  codeReferences: z.array(complianceCheckReferenceSchema).max(50),
});

export const complianceCheckJsonSchema = z.object({
  overallStatus: z.enum(['compliant', 'non_compliant', 'requires_review']),
  checks: z.array(complianceCheckItemSchema).max(30),
  summary: z.string().max(4000),
});

export const jwtPayloadSchema = z.object({
  sub: z.string().uuid(),
  username: z.string(),
  role: z.enum(['admin', 'user']),
  // C14H/M3: token version. Bumped on role change / password change so any
  // outstanding JWT with the previous tv is invalidated server-side at the
  // next middleware hop. Optional for backwards compatibility with sessions
  // issued before this migration; treated as 0 when missing.
  tv: z.number().int().nonnegative().optional(),
  iat: z.number(),
  exp: z.number(),
});

export type JWTPayload = z.infer<typeof jwtPayloadSchema>;



