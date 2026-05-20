// ============================================================================
// E11 — lib/pdf-parser.ts coverage
// ============================================================================
// We can't easily load a real PDF in unit tests, so we mock pdfjs-dist and
// drive the parser through its public API. The goal is to exercise:
//   - TOC extraction from a PDF outline
//   - Fallback section detection when outline is empty
//   - getPageText page-content shaping
//   - findSectionForPage path resolution
//   - detectTable / detectContentType heuristics
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----------------------------------------------------------------------------
// pdfjs-dist mock
// ----------------------------------------------------------------------------

interface MockPage {
  getTextContent: () => Promise<{
    items: Array<{
      str: string;
      transform: number[];
      width: number;
      height: number;
      fontName?: string;
    }>;
  }>;
}

interface MockDoc {
  numPages: number;
  getOutline: () => Promise<unknown>;
  getDestination: (n: string) => Promise<unknown>;
  getPageIndex: (ref: { num: number; gen: number }) => Promise<number>;
  getPage: (n: number) => Promise<MockPage>;
  destroy: () => Promise<void>;
}

let currentDoc: MockDoc;

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn((_: unknown) => {
    void _;
    return { promise: Promise.resolve(currentDoc) };
  }),
}));

import { PDFParser, createPDFParser } from '@/lib/pdf-parser';

function makeDoc(overrides: Partial<MockDoc> = {}): MockDoc {
  return {
    numPages: 3,
    getOutline: async () => null,
    getDestination: async () => null,
    getPageIndex: async () => 0,
    getPage: async () => ({
      getTextContent: async () => ({ items: [] }),
    }),
    destroy: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  currentDoc = makeDoc();
});

// ----------------------------------------------------------------------------
// load + totalPages + close
// ----------------------------------------------------------------------------

describe('PDFParser lifecycle', () => {
  it('loads via Buffer and reports totalPages', async () => {
    currentDoc = makeDoc({ numPages: 7 });
    const parser = await createPDFParser(Buffer.from('fake-pdf-bytes'));
    expect(parser.totalPages).toBe(7);
    await parser.close();
  });

  it('loads via Uint8Array (already-typed array buffer)', async () => {
    currentDoc = makeDoc({ numPages: 4 });
    const parser = await createPDFParser(new Uint8Array([1, 2, 3, 4]));
    expect(parser.totalPages).toBe(4);
  });

  it('throws when extractTOC is called before load()', async () => {
    const parser = new PDFParser(Buffer.from('x'));
    await expect(parser.extractTOC()).rejects.toThrow(/PDF not loaded/);
  });

  it('throws when getPageText is called before load()', async () => {
    const parser = new PDFParser(Buffer.from('x'));
    await expect(parser.getPageText(1)).rejects.toThrow(/PDF not loaded/);
  });
});

// ----------------------------------------------------------------------------
// extractTOC — outline path
// ----------------------------------------------------------------------------

describe('extractTOC from PDF outline', () => {
  it('builds hierarchical TOC and flatTOC from outline items', async () => {
    currentDoc = makeDoc({
      numPages: 100,
      getOutline: async () => [
        {
          title: '1. Introduction',
          dest: 'intro-dest',
          items: [
            { title: '1.1 Scope', dest: 'scope-dest', items: [] },
            { title: '1.2 Definitions', dest: 'defs-dest', items: [] },
          ],
        },
        { title: '2. Requirements', dest: 'req-dest', items: [] },
      ],
      // Both Resolved destinations point to the first page object below.
      getDestination: async () => [{ num: 1, gen: 0 }],
      // 0-indexed page index → +1 in parser
      getPageIndex: async (ref) => ref.num,
    });

    const parser = await createPDFParser(Buffer.from('x'));
    const struct = await parser.extractTOC();
    expect(struct.toc).toHaveLength(2);
    expect(struct.toc[0].children).toHaveLength(2);
    expect(struct.flatTOC.length).toBe(4);
    // section number was extracted from the title prefix
    expect(struct.flatTOC[0].section).toBe('1');
    expect(struct.flatTOC[1].section).toBe('1.1');
    // flatTOC is sorted by pageNumber ascending
    for (let i = 1; i < struct.flatTOC.length; i++) {
      expect(struct.flatTOC[i].pageNumber).toBeGreaterThanOrEqual(
        struct.flatTOC[i - 1].pageNumber,
      );
    }
  });

  it('handles outline entries that fail destination resolution', async () => {
    currentDoc = makeDoc({
      getOutline: async () => [
        { title: 'Broken', dest: 'bad-dest', items: [] },
      ],
      getDestination: async () => {
        throw new Error('cannot resolve');
      },
    });
    const parser = await createPDFParser(Buffer.from('x'));
    const struct = await parser.extractTOC();
    // Defaults to page 1 when destination resolution fails.
    expect(struct.toc[0].pageNumber).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// detectSectionsFromContent fallback (no outline)
// ----------------------------------------------------------------------------

describe('section detection fallback', () => {
  it('uses content-based detection when no outline is present', async () => {
    const pageItems = (text: string) => ({
      items: text.split('\n').map((line, i) => ({
        str: line,
        transform: [1, 0, 0, 1, 0, 100 - i * 20],
        width: 100,
        height: 12,
      })),
    });

    currentDoc = makeDoc({
      numPages: 3,
      getOutline: async () => null,
      getPage: async (pageNum) => ({
        getTextContent: async () => {
          if (pageNum === 1) return pageItems('Chapter 1: Scope\nIntro text');
          if (pageNum === 2) return pageItems('1.1 Definitions\nbody');
          return pageItems('plain page text');
        },
      }),
    });

    const parser = await createPDFParser(Buffer.from('x'));
    const struct = await parser.extractTOC();
    // We expect at least the two detected headings.
    expect(struct.flatTOC.length).toBeGreaterThanOrEqual(2);
    const titles = struct.flatTOC.map((e) => e.title).join(' | ');
    expect(titles.toLowerCase()).toContain('chapter 1');
  });
});

// ----------------------------------------------------------------------------
// getPageText + line-break detection
// ----------------------------------------------------------------------------

describe('getPageText', () => {
  it('joins text items and inserts newlines on Y-axis jumps', async () => {
    currentDoc = makeDoc({
      getPage: async () => ({
        getTextContent: async () => ({
          items: [
            { str: 'Hello ', transform: [1, 0, 0, 1, 0, 100], width: 30, height: 10 },
            { str: 'world', transform: [1, 0, 0, 1, 30, 100], width: 30, height: 10 },
            // Next line — Y dropped by 20
            { str: 'second', transform: [1, 0, 0, 1, 0, 80], width: 30, height: 10 },
          ],
        }),
      }),
    });

    const parser = await createPDFParser(Buffer.from('x'));
    const page = await parser.getPageText(1);
    expect(page.text).toBe('Hello world\nsecond');
    expect(page.textItems).toHaveLength(3);
  });

  it('getAllPagesText skips empty pages', async () => {
    currentDoc = makeDoc({
      numPages: 3,
      getPage: async (pageNum) => ({
        getTextContent: async () => {
          if (pageNum === 2) return { items: [] };
          return {
            items: [
              {
                str: `page ${pageNum}`,
                transform: [1, 0, 0, 1, 0, 100],
                width: 30,
                height: 10,
              },
            ],
          };
        },
      }),
    });
    const parser = await createPDFParser(Buffer.from('x'));
    const all = await parser.getAllPagesText();
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.pageNumber === 2)).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// findSectionForPage
// ----------------------------------------------------------------------------

describe('findSectionForPage', () => {
  it('returns an empty path when TOC has not been extracted', async () => {
    currentDoc = makeDoc();
    const parser = await createPDFParser(Buffer.from('x'));
    expect(parser.findSectionForPage(5).sectionPath).toEqual([]);
  });

  it('finds the deepest matching section before the given page', async () => {
    currentDoc = makeDoc({
      numPages: 100,
      getOutline: async () => [
        {
          title: 'Chapter 1 General',
          dest: 'c1',
          items: [{ title: '1.1 Scope', dest: 'c1-1', items: [] }],
        },
        { title: 'Chapter 2 Building', dest: 'c2', items: [] },
      ],
      getDestination: async (d) => {
        if (d === 'c1') return [{ num: 0, gen: 0 }];
        if (d === 'c1-1') return [{ num: 5, gen: 0 }];
        if (d === 'c2') return [{ num: 20, gen: 0 }];
        return null;
      },
      getPageIndex: async (ref) => ref.num,
    });
    const parser = await createPDFParser(Buffer.from('x'));
    await parser.extractTOC();

    const onScope = parser.findSectionForPage(10);
    expect(onScope.section).toBe('1.1');

    const inChapter2 = parser.findSectionForPage(25);
    expect(inChapter2.sectionTitle?.toLowerCase()).toContain('chapter 2');
    // Chapter discovery
    expect(inChapter2.chapter?.toLowerCase()).toContain('chapter');
  });
});

// ----------------------------------------------------------------------------
// detectTable / detectContentType
// ----------------------------------------------------------------------------

describe('content type detection', () => {
  it('flags table-like content', async () => {
    currentDoc = makeDoc();
    const parser = await createPDFParser(Buffer.from('x'));
    const text = `Table 4.1 — Required Areas
| Type | Min | Max |
| A    | 10  | 20  |
| B    | 30  | 40  |`;
    expect(parser.detectTable(text)).toBe(true);
    expect(parser.detectContentType(text)).toBe('table');
  });

  it('flags list-like content', async () => {
    currentDoc = makeDoc();
    const parser = await createPDFParser(Buffer.from('x'));
    const text = `Requirements:
- item one
- item two
- item three`;
    expect(parser.detectContentType(text)).toBe('list');
  });

  it('flags heading-like content', async () => {
    currentDoc = makeDoc();
    const parser = await createPDFParser(Buffer.from('x'));
    expect(parser.detectContentType('3.2.1 Fire Safety')).toBe('heading');
  });

  it('falls back to "text" for ordinary prose', async () => {
    currentDoc = makeDoc();
    const parser = await createPDFParser(Buffer.from('x'));
    const longProse =
      'This is a paragraph of normal prose without any structured ' +
      'list or table indicators. It just describes a requirement in plain text.';
    expect(parser.detectContentType(longProse)).toBe('text');
  });
});
