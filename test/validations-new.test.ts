import { describe, it, expect } from 'vitest';
import {
  registerSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  projectTypeSchema,
  buildingDetailsSchema,
  complianceRequirementsSchema,
  reviewPermitSchema,
  fileUploadSchema,
  validatePassword,
  validatePasswordClient,
} from '@/lib/validations';

// ============================================================================
// Register Schema
// ============================================================================
describe('registerSchema', () => {
  const valid = {
    username: 'test_user',
    email: 'Test@Example.COM',
    password: 'Secure1!a',
  };

  it('should accept valid registration data', () => {
    const result = registerSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should lowercase and trim username', () => {
    const result = registerSchema.safeParse({ ...valid, username: 'TestUser' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe('testuser');
    }
  });

  it('should lowercase email', () => {
    const result = registerSchema.safeParse({ ...valid, email: 'Test@Example.COM' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('test@example.com');
    }
  });

  it('should reject username shorter than 3 chars', () => {
    const result = registerSchema.safeParse({ ...valid, username: 'ab' });
    expect(result.success).toBe(false);
  });

  it('should reject username with special characters', () => {
    const result = registerSchema.safeParse({ ...valid, username: 'user@name' });
    expect(result.success).toBe(false);
  });

  it('should accept username with underscores', () => {
    const result = registerSchema.safeParse({ ...valid, username: 'my_user_1' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid email', () => {
    const result = registerSchema.safeParse({ ...valid, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('should reject password without uppercase', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'secure1!a' });
    expect(result.success).toBe(false);
  });

  it('should reject password without lowercase', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'SECURE1!A' });
    expect(result.success).toBe(false);
  });

  it('should reject password without digit', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'Secure!ab' });
    expect(result.success).toBe(false);
  });

  it('should reject password without special character', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'Secure1ab' });
    expect(result.success).toBe(false);
  });

  it('should reject password shorter than 8 chars', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'Se1!a' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Verify Email Schema
// ============================================================================
describe('verifyEmailSchema', () => {
  it('should accept valid email and 6-digit code', () => {
    const result = verifyEmailSchema.safeParse({ email: 'a@b.com', code: '123456' });
    expect(result.success).toBe(true);
  });

  it('should lowercase email', () => {
    const result = verifyEmailSchema.safeParse({ email: 'A@B.COM', code: '000001' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('a@b.com');
    }
  });

  it('should reject code shorter than 6 digits', () => {
    const result = verifyEmailSchema.safeParse({ email: 'a@b.com', code: '12345' });
    expect(result.success).toBe(false);
  });

  it('should reject code longer than 6 digits', () => {
    const result = verifyEmailSchema.safeParse({ email: 'a@b.com', code: '1234567' });
    expect(result.success).toBe(false);
  });

  it('should reject non-digit code', () => {
    const result = verifyEmailSchema.safeParse({ email: 'a@b.com', code: 'abcdef' });
    expect(result.success).toBe(false);
  });

  it('should accept code with leading zeros', () => {
    const result = verifyEmailSchema.safeParse({ email: 'a@b.com', code: '000001' });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Forgot Password Schema
// ============================================================================
describe('forgotPasswordSchema', () => {
  it('should accept valid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'user@test.com' });
    expect(result.success).toBe(true);
  });

  it('should lowercase email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'USER@Test.COM' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('user@test.com');
    }
  });

  it('should reject invalid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'invalid' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Reset Password Schema
// ============================================================================
describe('resetPasswordSchema', () => {
  const valid = { email: 'a@b.com', code: '123456', newPassword: 'NewPass1!' };

  it('should accept valid reset data', () => {
    const result = resetPasswordSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should reject invalid code', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, code: 'abc' });
    expect(result.success).toBe(false);
  });

  it('should reject weak newPassword', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, newPassword: 'weak' });
    expect(result.success).toBe(false);
  });

  it('should lowercase email', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, email: 'A@B.COM' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('a@b.com');
    }
  });
});

// ============================================================================
// Update Profile Schema
// ============================================================================
describe('updateProfileSchema', () => {
  it('should accept empty object (all optional)', () => {
    const result = updateProfileSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept valid username', () => {
    const result = updateProfileSchema.safeParse({ username: 'new_name' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe('new_name');
    }
  });

  it('should reject username shorter than 3 chars', () => {
    const result = updateProfileSchema.safeParse({ username: 'ab' });
    expect(result.success).toBe(false);
  });

  it('should accept valid full_name', () => {
    const result = updateProfileSchema.safeParse({ full_name: 'John Doe' });
    expect(result.success).toBe(true);
  });

  it('should reject full_name over 100 chars', () => {
    const result = updateProfileSchema.safeParse({ full_name: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('should sanitize full_name (strip HTML)', () => {
    const result = updateProfileSchema.safeParse({ full_name: '<script>alert("xss")</script>John' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.full_name).toBe('alert("xss")John');
    }
  });
});

// ============================================================================
// Project Type Schema
// ============================================================================
describe('projectTypeSchema', () => {
  const validTypes = ['residential', 'commercial', 'industrial', 'mixed_use', 'institutional'];

  it.each(validTypes)('should accept "%s"', (type) => {
    const result = projectTypeSchema.safeParse(type);
    expect(result.success).toBe(true);
  });

  it('should reject invalid project type', () => {
    const result = projectTypeSchema.safeParse('retail');
    expect(result.success).toBe(false);
  });

  it('should reject empty string', () => {
    const result = projectTypeSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Building Details Schema
// ============================================================================
describe('buildingDetailsSchema', () => {
  const valid = {
    numberOfFloors: 10,
    totalBuiltUpArea: 5000,
    plotArea: 2000,
    buildingHeight: 30,
    numberOfUnits: 50,
    numberOfParkingSpaces: 100,
    occupancyType: 'Office',
    constructionType: 'Steel Frame',
  };

  it('should accept valid building details', () => {
    const result = buildingDetailsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should reject numberOfFloors < 1', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, numberOfFloors: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject numberOfFloors > 200', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, numberOfFloors: 201 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer numberOfFloors', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, numberOfFloors: 1.5 });
    expect(result.success).toBe(false);
  });

  it('should reject negative totalBuiltUpArea', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, totalBuiltUpArea: -1 });
    expect(result.success).toBe(false);
  });

  it('should reject totalBuiltUpArea > 1,000,000', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, totalBuiltUpArea: 1000001 });
    expect(result.success).toBe(false);
  });

  it('should reject negative plotArea', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, plotArea: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject plotArea > 1,000,000', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, plotArea: 1000001 });
    expect(result.success).toBe(false);
  });

  it('should reject buildingHeight > 1000', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, buildingHeight: 1001 });
    expect(result.success).toBe(false);
  });

  it('should reject negative buildingHeight', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, buildingHeight: -5 });
    expect(result.success).toBe(false);
  });

  it('should accept numberOfUnits = 0', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, numberOfUnits: 0 });
    expect(result.success).toBe(true);
  });

  it('should reject numberOfUnits > 10000', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, numberOfUnits: 10001 });
    expect(result.success).toBe(false);
  });

  it('should reject numberOfParkingSpaces > 50000', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, numberOfParkingSpaces: 50001 });
    expect(result.success).toBe(false);
  });

  it('should reject empty occupancyType', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, occupancyType: '' });
    expect(result.success).toBe(false);
  });

  it('should reject occupancyType > 100 chars', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, occupancyType: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('should reject empty constructionType', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, constructionType: '' });
    expect(result.success).toBe(false);
  });

  it('should sanitize occupancyType (strip HTML)', () => {
    const result = buildingDetailsSchema.safeParse({ ...valid, occupancyType: '<b>Office</b>' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.occupancyType).toBe('Office');
    }
  });

  it('should accept boundary values', () => {
    const boundary = {
      numberOfFloors: 1,
      totalBuiltUpArea: 0.01,
      plotArea: 0.01,
      buildingHeight: 0.01,
      numberOfUnits: 0,
      numberOfParkingSpaces: 0,
      occupancyType: 'A',
      constructionType: 'B',
    };
    const result = buildingDetailsSchema.safeParse(boundary);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Compliance Requirements Schema
// ============================================================================
describe('complianceRequirementsSchema', () => {
  const valid = {
    fireSafety: true,
    accessibility: true,
    parkingCompliance: false,
    structuralSafety: true,
    mepSystems: false,
    energyEfficiency: true,
  };

  it('should accept valid compliance requirements', () => {
    const result = complianceRequirementsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should accept with optional additionalNotes', () => {
    const result = complianceRequirementsSchema.safeParse({
      ...valid,
      additionalNotes: 'Some notes about compliance',
    });
    expect(result.success).toBe(true);
  });

  it('should reject additionalNotes over 2000 chars', () => {
    const result = complianceRequirementsSchema.safeParse({
      ...valid,
      additionalNotes: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-boolean fireSafety', () => {
    const result = complianceRequirementsSchema.safeParse({ ...valid, fireSafety: 'yes' });
    expect(result.success).toBe(false);
  });

  it('should reject missing required boolean field', () => {
    const { accessibility: _accessibility, ...missing } = valid;
    const result = complianceRequirementsSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('should sanitize additionalNotes (strip HTML)', () => {
    const result = complianceRequirementsSchema.safeParse({
      ...valid,
      additionalNotes: '<script>alert(1)</script>Notes',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.additionalNotes).toBe('alert(1)Notes');
    }
  });
});

// ============================================================================
// Review Permit Schema
// ============================================================================
describe('reviewPermitSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const valid = {
    permitId: validUuid,
    action: 'approve' as const,
    comments: 'Approved after review',
  };

  it('should accept valid review data', () => {
    const result = reviewPermitSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it.each(['approve', 'reject', 'request_revision'])('should accept action "%s"', (action) => {
    const result = reviewPermitSchema.safeParse({ ...valid, action });
    expect(result.success).toBe(true);
  });

  it('should reject invalid action', () => {
    const result = reviewPermitSchema.safeParse({ ...valid, action: 'cancel' });
    expect(result.success).toBe(false);
  });

  it('should reject invalid permitId', () => {
    const result = reviewPermitSchema.safeParse({ ...valid, permitId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('should reject empty comments', () => {
    const result = reviewPermitSchema.safeParse({ ...valid, comments: '' });
    expect(result.success).toBe(false);
  });

  it('should reject comments over 2000 chars', () => {
    const result = reviewPermitSchema.safeParse({ ...valid, comments: 'x'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  it('should sanitize comments (strip HTML)', () => {
    const result = reviewPermitSchema.safeParse({ ...valid, comments: '<img>Good work</img>' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.comments).toBe('Good work');
    }
  });
});

// ============================================================================
// File Upload Schema
// ============================================================================
describe('fileUploadSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const valid = {
    permitId: validUuid,
    fileName: 'document.pdf',
    fileSize: 1024,
    fileType: 'application/pdf',
  };

  it('should accept valid file upload data', () => {
    const result = fileUploadSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should reject invalid permitId', () => {
    const result = fileUploadSchema.safeParse({ ...valid, permitId: 'bad' });
    expect(result.success).toBe(false);
  });

  it('should reject empty fileName', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileName: '' });
    expect(result.success).toBe(false);
  });

  it('should reject fileName over 255 chars', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileName: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('should reject fileSize of 0', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileSize: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject negative fileSize', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileSize: -100 });
    expect(result.success).toBe(false);
  });

  it('should reject fileSize over 10MB', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileSize: 10 * 1024 * 1024 + 1 });
    expect(result.success).toBe(false);
  });

  it('should accept fileSize exactly 10MB', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileSize: 10 * 1024 * 1024 });
    expect(result.success).toBe(true);
  });

  it('should reject empty fileType', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileType: '' });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer fileSize', () => {
    const result = fileUploadSchema.safeParse({ ...valid, fileSize: 1024.5 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// SIM-M-10 / v1.9.0 Part D — client-side password validator
// ============================================================================
describe('validatePasswordClient (SIM-M-10)', () => {
  it('returns null for a password that satisfies every rule', () => {
    expect(validatePasswordClient('Secure1!a')).toBeNull();
  });

  it('returns the same message as the server-side validatePassword on a bad input', () => {
    const tooShort = 'aA1!';
    const server = validatePassword(tooShort);
    const client = validatePasswordClient(tooShort);
    expect(server.valid).toBe(false);
    expect(client).toBe(server.error);
  });

  it('returns a non-null string for each rule violation', () => {
    expect(validatePasswordClient('alllowercase1!')).toMatch(/uppercase/i);
    expect(validatePasswordClient('ALLUPPERCASE1!')).toMatch(/lowercase/i);
    expect(validatePasswordClient('NoDigitsHere!')).toMatch(/digit/i);
    expect(validatePasswordClient('NoSpecial1Char')).toMatch(/special/i);
  });
});
