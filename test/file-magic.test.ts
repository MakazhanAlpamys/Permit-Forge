// ============================================================================
// Tests: lib/file-magic — magic-byte sniffing (C7H / H10)
// ============================================================================

import { describe, it, expect } from 'vitest';
import { sniffMagic, magicMatchesMime, type DetectedKind } from '@/lib/file-magic';

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('sniffMagic', () => {
  it('detects PDF', () => {
    expect(sniffMagic(ascii('%PDF-1.7\n...'))).toBe('pdf');
  });

  it('detects PNG', () => {
    expect(sniffMagic(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe('png');
  });

  it('detects JPEG (JFIF)', () => {
    expect(sniffMagic(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
  });

  it('detects DWG with version digits', () => {
    expect(sniffMagic(ascii('AC1018xxxxx'))).toBe('dwg');
  });

  it('rejects "AC" prefix without version digits', () => {
    expect(sniffMagic(ascii('AC!!!!'))).toBe('unknown');
  });

  it('detects DXF (whitespace-tolerant)', () => {
    expect(sniffMagic(ascii('  0\nSECTION\n2\nHEADER'))).toBe('dxf');
  });

  it('returns unknown for an empty buffer', () => {
    expect(sniffMagic(new Uint8Array(0))).toBe('unknown');
  });

  it('returns unknown for an arbitrary binary blob', () => {
    expect(sniffMagic(bytes(0x4d, 0x5a, 0x90, 0x00))).toBe('unknown'); // PE/EXE
  });
});

describe('magicMatchesMime', () => {
  const cases: Array<{ kind: DetectedKind; mime: string; ok: boolean }> = [
    { kind: 'pdf', mime: 'application/pdf', ok: true },
    { kind: 'pdf', mime: 'image/png', ok: false },
    { kind: 'png', mime: 'image/png', ok: true },
    { kind: 'png', mime: 'application/pdf', ok: false },
    { kind: 'jpeg', mime: 'image/jpeg', ok: true },
    { kind: 'jpeg', mime: 'image/jpg', ok: true },
    { kind: 'jpeg', mime: 'application/pdf', ok: false },
    { kind: 'dwg', mime: 'application/octet-stream', ok: true },
    { kind: 'dwg', mime: 'application/pdf', ok: false },
    { kind: 'dxf', mime: 'application/dxf', ok: true },
    { kind: 'dxf', mime: 'image/png', ok: false },
    { kind: 'unknown', mime: 'application/pdf', ok: true }, // don't block unknown
  ];

  for (const { kind, mime, ok } of cases) {
    it(`${kind} vs ${mime} → ${ok}`, () => {
      expect(magicMatchesMime(kind, mime)).toBe(ok);
    });
  }
});
