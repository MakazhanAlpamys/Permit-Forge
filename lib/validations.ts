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

export type RegisterInput = z.infer<typeof registerSchema>;

// -----------------------------------------------------------------------------
// Email Verification Schema
// -----------------------------------------------------------------------------

export const verifyEmailSchema = z.object({
  email: z.string().email('Invalid email address').transform(s => s.toLowerCase().trim()),
  code: z.string().length(6, 'Verification code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

// -----------------------------------------------------------------------------
// Forgot Password Schema
// -----------------------------------------------------------------------------

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address').transform(s => s.toLowerCase().trim()),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

// -----------------------------------------------------------------------------
// Reset Password Schema
// -----------------------------------------------------------------------------

export const resetPasswordSchema = z.object({
  email: z.string().email('Invalid email address').transform(s => s.toLowerCase().trim()),
  code: z.string().length(6, 'Reset code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
  newPassword: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

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

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

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

export type PaginationInput = z.infer<typeof paginationSchema>;

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
  buildingDetails: buildingDetailsSchema,
});

export type UpdateBuildingDetailsInput = z.infer<typeof updateBuildingDetailsSchema>;

export const updateComplianceRequirementsSchema = z.object({
  permitId: uuidSchema,
  complianceRequirements: complianceRequirementsSchema,
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



