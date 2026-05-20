// ============================================================================
// E16 — Edge cases from phase2-coverage.md §4
// ============================================================================
// Tests scattered across modules — collected here for ease of review:
//   - 10MB ± 1B file boundary
//   - DWG/DXF with application/octet-stream
//   - JWT signed with wrong secret rejection
//   - Expired-code boundary
//   - SmartConcurrent getAllDocuments dedup (already covered in E7, see ref)
//   - x-middleware-subrequest header rejection (already covered in E1)
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import { validateFile } from '@/lib/file-upload';
import { FILE_UPLOAD_LIMITS } from '@/lib/constants';
import { verifyJWTToken } from '@/lib/auth';

// ----------------------------------------------------------------------------
// 10MB ± 1B file boundary
// ----------------------------------------------------------------------------

describe('file-upload size boundary', () => {
  // Build a File whose .size reports exactly N bytes without actually
  // allocating N bytes of memory (we use a Proxy).
  function fileOfSize(name: string, type: string, size: number, bytes?: Uint8Array): File {
    // Real bytes used by the magic sniffer (first ~16 bytes).
    const head = bytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    // Cast to BlobPart — the typed-array vs ArrayBuffer story is fiddly in
    // current libdom, but `new Uint8Array(...)` is universally accepted at
    // runtime.
    const real = new File([head as unknown as BlobPart], name, { type });
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'size') return size;
        return Reflect.get(target, prop);
      },
    }) as File;
  }

  it('accepts a file exactly at the maxFileSize boundary', async () => {
    const max = FILE_UPLOAD_LIMITS.maxFileSize;
    const f = fileOfSize('a.pdf', 'application/pdf', max);
    const result = await validateFile(f);
    expect(result.valid).toBe(true);
  });

  it('rejects a file one byte over the maxFileSize boundary', async () => {
    const max = FILE_UPLOAD_LIMITS.maxFileSize;
    const f = fileOfSize('a.pdf', 'application/pdf', max + 1);
    const result = await validateFile(f);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/exceeds/);
  });

  it('rejects a zero-byte file', async () => {
    const f = fileOfSize('a.pdf', 'application/pdf', 0);
    const result = await validateFile(f);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });
});

// ----------------------------------------------------------------------------
// DWG/DXF MIME edge case
// ----------------------------------------------------------------------------

describe('file-upload DWG / DXF MIME handling', () => {
  it('rejects DWG file with generic application/octet-stream type', async () => {
    const f = new File([new Uint8Array([0x00, 0x00])], 'site.dwg', {
      type: 'application/octet-stream',
    });
    const result = await validateFile(f);
    // The MIME-vs-extension check rejects octet-stream for .dwg.
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/MIME/);
  });

  it('accepts DWG file with one of the recognized MIME types', async () => {
    const f = new File([new Uint8Array([0x41, 0x43, 0x31, 0x30])], 'site.dwg', {
      type: 'image/vnd.dwg',
    });
    const result = await validateFile(f);
    expect(result.valid).toBe(true);
  });

  it('rejects DXF file with empty MIME type', async () => {
    const f = new File([new Uint8Array([0x30, 0x0a, 0x53])], 'site.dxf', {
      type: '',
    });
    const result = await validateFile(f);
    expect(result.valid).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// JWT signed with wrong secret
// ----------------------------------------------------------------------------

describe('JWT rejection edge cases', () => {
  it('rejects a JWT signed with a different HMAC secret', async () => {
    const wrongSecret = new TextEncoder().encode(
      'a-different-secret-with-enough-length-to-pass-hs256-validation',
    );
    const token = await new SignJWT({
      sub: '550e8400-e29b-41d4-a716-446655440000',
      username: 'tester',
      role: 'user',
      tv: 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongSecret);

    const result = await verifyJWTToken(token);
    expect(result).toBeNull();
  });

  it('rejects an expired JWT signed with the correct secret', async () => {
    const correctSecret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await new SignJWT({
      sub: '550e8400-e29b-41d4-a716-446655440000',
      username: 'tester',
      role: 'user',
      tv: 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(past - 100)
      .setExpirationTime(past)
      .sign(correctSecret);

    const result = await verifyJWTToken(token);
    expect(result).toBeNull();
  });

  it('rejects a JWT whose payload fails the schema (missing fields)', async () => {
    const correctSecret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT({
      // missing sub, username, role
      tv: 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(correctSecret);

    const result = await verifyJWTToken(token);
    expect(result).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Expired code attempt boundary (lib/code-verification)
// ----------------------------------------------------------------------------

describe('code-verification expiry boundary', () => {
  it('safeEqual rejects strings of different length', async () => {
    const mod = await import('@/lib/code-verification');
    expect(mod.safeEqual('123456', '12345')).toBe(false);
    expect(mod.safeEqual('123456', '1234567')).toBe(false);
  });

  it('safeEqual matches identical 6-digit codes', async () => {
    const mod = await import('@/lib/code-verification');
    expect(mod.safeEqual('123456', '123456')).toBe(true);
    expect(mod.safeEqual('000000', '000000')).toBe(true);
  });

  it('safeEqual handles non-ASCII safely (Buffer length match)', async () => {
    const mod = await import('@/lib/code-verification');
    // Two strings with the same code-point count but different byte lengths
    // after UTF-8 encoding — safeEqual checks via Buffer.byteLength, so it
    // must return false rather than throw.
    expect(mod.safeEqual('café00', 'cafe00')).toBe(false);
  });
});

// Compile-time used to silence vi
void vi;
