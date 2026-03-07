# План: PDF Upload для Document Management

## Проблема

Админ-панель → вкладка "Documents" позволяет регистрировать документы и запускать ingestion, но нет возможности загрузить сам PDF файл. Система ожидает файл в папке `public/` на сервере (`fs.readFileSync`). На Vercel `public/` — read-only, поэтому ingestion падает:

```
PDF file not found at /var/task/public/Dubai_Building_Code_English_2021_Edition_compressed.pdf
Failed to start ingestion
```

## Решение

Загружаем PDF в Supabase Storage (bucket `document-pdfs`), и ingestion pipeline читает оттуда.

## Как будет работать

1. Админ открывает Documents → нажимает "Add Document"
2. Заполняет метаданные (название, категория, ключевые слова)
3. Выбирает PDF файл через file input (лимит 100MB)
4. Нажимает Save → PDF загружается в Supabase Storage, метаданные сохраняются в `document_registry`
5. Нажимает "Ingest" → API route скачивает PDF из Storage → парсит → chunking → embeddings → DB

---

## Реализация — Детальный план

### Шаг 1: SQL миграция — создать bucket и обновить таблицу

**Файл:** `supabase/migrations/001_document_pdf_storage.sql`

```sql
-- Создать storage bucket для PDF документов (private, только через signed URLs)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'document-pdfs',
  'document-pdfs',
  false,
  104857600,  -- 100MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: только service_role может upload/download
-- (adminClient использует service_role key, поэтому RLS не мешает)
CREATE POLICY "Admin upload documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'document-pdfs');

CREATE POLICY "Admin read documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'document-pdfs');

CREATE POLICY "Admin delete documents" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'document-pdfs');

-- Добавить колонку storage_path в document_registry
-- (file_name остаётся для обратной совместимости — отображаемое имя файла)
ALTER TABLE document_registry
  ADD COLUMN IF NOT EXISTS storage_path TEXT DEFAULT NULL;

-- COMMENT: storage_path = 'documents/{document_id}/{filename}.pdf'
-- Если storage_path IS NULL — файл ещё не загружен
```

**Примечание:** Bucket можно также создать вручную через Supabase Dashboard → Storage, если SQL миграция не поддерживается. Главное — service_role key уже обходит RLS, так что policies опциональны.

---

### Шаг 2: Константы

**Файл:** [constants.ts](lib/constants.ts)

Добавить в `FILE_UPLOAD_LIMITS` или рядом:

```typescript
export const DOCUMENT_PDF_LIMITS = {
  maxSizeBytes: 100 * 1024 * 1024,  // 100MB
  maxSizeMB: 100,
  allowedTypes: ['application/pdf'],
  allowedExtensions: ['.pdf'],
  storageBucket: 'document-pdfs',
  storagePath: (documentId: string, fileName: string) =>
    `documents/${documentId}/${fileName}`,
} as const;
```

---

### Шаг 3: Backend — Server Action для upload PDF

**Файл:** [documents.ts](actions/documents.ts)

Добавить функцию `uploadDocumentPDF`:

```typescript
export async function uploadDocumentPDF(documentId: string, formData: FormData) {
  // 1. requireAdmin() — проверка авторизации
  // 2. Извлечь файл из FormData
  // 3. Валидация: размер <= 100MB, тип === 'application/pdf'
  // 4. Сгенерировать storage_path: `documents/${documentId}/${sanitizedName}.pdf`
  // 5. adminClient.storage.from('document-pdfs').upload(storagePath, buffer, { contentType, upsert: true })
  // 6. Обновить document_registry: SET storage_path = storagePath, file_name = originalName
  // 7. Вернуть { success: true, storagePath }
}
```

**Паттерн upload уже есть** в [permit-attachments.ts](actions/permit-attachments.ts) (строки 92-100) — переиспользуем подход:
```typescript
const { error } = await adminClient.storage
  .from(DOCUMENT_PDF_LIMITS.storageBucket)
  .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
```

Также добавить `deleteDocumentPDF` для удаления файла из Storage при удалении документа.

---

### Шаг 4: Backend — PDF Parser принимает Buffer

**Файл:** [pdf-parser.ts](lib/pdf-parser.ts)

Сейчас (строка ~64):
```typescript
const data = fs.readFileSync(this.pdfPath);
this.pdfDoc = await getDocument({ data: new Uint8Array(data), ... }).promise;
```

**Изменения:**
1. Добавить статический метод `PDFParser.fromBuffer(buffer: Buffer, name: string)` — создаёт парсер из буфера без fs.readFileSync
2. Внутри `load()` — если буфер передан, использовать его вместо чтения с диска
3. Существующий конструктор `new PDFParser(pdfPath)` оставить рабочим для обратной совместимости (локальная разработка / тесты)

```typescript
class PDFParser {
  private pdfPath?: string;
  private pdfBuffer?: Uint8Array;

  constructor(pathOrBuffer: string | Buffer) {
    if (typeof pathOrBuffer === 'string') {
      this.pdfPath = pathOrBuffer;
    } else {
      this.pdfBuffer = new Uint8Array(pathOrBuffer);
    }
  }

  async load() {
    const data = this.pdfBuffer ?? new Uint8Array(fs.readFileSync(this.pdfPath!));
    this.pdfDoc = await getDocument({ data, ... }).promise;
  }
}
```

---

### Шаг 5: Backend — Ingestion Pipeline принимает Buffer

**Файл:** [pdf-ingestion.ts](lib/pdf-ingestion.ts)

Сейчас `IngestionOptions`:
```typescript
interface IngestionOptions {
  documentId: string;
  pdfPath: string;          // 'public/document.pdf'
  onProgress?: ProgressCallback;
}
```

**Изменения:**

```typescript
interface IngestionOptions {
  documentId: string;
  pdfPath?: string;          // опционально — для локальной разработки
  pdfBuffer?: Buffer;        // опционально — из Supabase Storage
  onProgress?: ProgressCallback;
}
```

В `runIngestionPipeline`:
- Если `pdfBuffer` передан — создать `new PDFParser(pdfBuffer)`
- Если `pdfPath` передан — использовать как раньше (fallback)
- Если ни того ни другого — ошибка

Строки ~225-248: заменить `fs.existsSync` check на:
```typescript
if (options.pdfBuffer) {
  parser = new PDFParser(options.pdfBuffer);
} else if (options.pdfPath) {
  const absPath = path.join(process.cwd(), options.pdfPath);
  if (!fs.existsSync(absPath)) throw new Error(`PDF not found: ${absPath}`);
  parser = new PDFParser(absPath);
} else {
  throw new Error('Either pdfBuffer or pdfPath must be provided');
}
```

---

### Шаг 6: Backend — API route скачивает из Storage

**Файл:** [route.ts](app/api/ingest/route.ts)

Сейчас (строка ~70-76):
```typescript
const fileName = body.pdfPath || doc.file_name;
// валидация имени файла
const pdfPath = 'public/' + fileName;
// передаём в runIngestionPipeline({ documentId, pdfPath })
```

**Изменения:**

```typescript
// 1. Получить document из document_registry
const doc = await getDocumentById(documentId);

// 2. Проверить storage_path
if (!doc.storage_path) {
  return new Response('PDF not uploaded. Upload PDF first.', { status: 400 });
}

// 3. Скачать PDF из Supabase Storage
const adminClient = createAdminClient();
const { data: blob, error } = await adminClient.storage
  .from('document-pdfs')
  .download(doc.storage_path);

if (error || !blob) {
  return new Response('Failed to download PDF from storage', { status: 500 });
}

const pdfBuffer = Buffer.from(await blob.arrayBuffer());

// 4. Запустить pipeline с буфером
runIngestionPipeline({
  documentId,
  pdfBuffer,
  onProgress: (progress) => { /* SSE stream */ }
});
```

Убрать старую логику с `pdfPath = 'public/' + fileName` и валидацию имени файла через regex (больше не нужно — путь берётся из БД, а не из user input).

---

### Шаг 7: Frontend — File Upload в форме документа

**Файл:** [document-management.tsx](components/admin/document-management.tsx)

**Изменения в форме "Add/Edit Document":**

1. Заменить текстовый input "PDF File Name" на `<input type="file" accept=".pdf">`
2. Показывать текущий статус: "No file uploaded" / "File: document.pdf (uploaded)"
3. При сабмите формы:
   - Сначала `upsertDocument()` для метаданных
   - Если выбран новый файл → `uploadDocumentPDF(documentId, formData)`
4. Показывать progress bar при upload (для больших файлов)
5. При наличии `storage_path` — показывать зелёный badge "PDF Uploaded"
6. Кнопка "Ingest" доступна только если `storage_path !== null`

**Примерный UI flow:**

```
┌─────────────────────────────────────┐
│ Add Document                        │
├─────────────────────────────────────┤
│ Display Name: [________________]    │
│ Short Name:   [________________]    │
│ Category:     [________________]    │
│ Description:  [________________]    │
│                                     │
│ PDF File: [Choose File] 📎         │
│           document.pdf (45.2 MB)    │
│                                     │
│         [Cancel]  [Save]            │
└─────────────────────────────────────┘
```

После сохранения, в списке документов:
```
┌──────────────────────────────────────────────────┐
│ Building Code 2021        ✅ PDF Uploaded         │
│ building-code-2021        45.2 MB                │
│                                                  │
│ [Ingest]  [Edit]  [Delete]                       │
│ ████████████████░░░░ 80% — Generating embeddings │
└──────────────────────────────────────────────────┘
```

---

### Шаг 8: Обновить действие удаления документа

**Файл:** [documents.ts](actions/documents.ts) → `deleteDocument()`

При `clearChunks=true` — также удалять PDF из Storage:
```typescript
if (doc.storage_path) {
  await adminClient.storage
    .from('document-pdfs')
    .remove([doc.storage_path]);
}
```

---

### Шаг 9: Типы

**Файл:** [types/index.ts](types/index.ts)

Добавить `storage_path?: string` к интерфейсу документа (если есть), чтобы фронтенд знал загружен ли PDF.

---

## Порядок реализации

| # | Задача | Файлы | Зависимости |
|---|--------|-------|-------------|
| 1 | SQL миграция: bucket + колонка `storage_path` | `supabase/migrations/001_*` | — |
| 2 | Константы `DOCUMENT_PDF_LIMITS` | `lib/constants.ts` | — |
| 3 | `PDFParser` принимает Buffer | `lib/pdf-parser.ts` | — |
| 4 | `runIngestionPipeline` принимает Buffer | `lib/pdf-ingestion.ts` | #3 |
| 5 | Server action `uploadDocumentPDF` | `actions/documents.ts` | #1, #2 |
| 6 | API route: download из Storage | `app/api/ingest/route.ts` | #4, #5 |
| 7 | Frontend: file input + upload UI | `components/admin/document-management.tsx` | #5, #6 |
| 8 | Удаление PDF из Storage | `actions/documents.ts` | #5 |
| 9 | Типы | `types/index.ts` | — |

**Шаги 1-3 независимы → можно делать параллельно.**
**Шаги 4-6 последовательны (зависят от предыдущих).**
**Шаг 7 — после всего backend.**

## Риски и заметки

- **Supabase Storage бесплатный лимит**: 1GB storage, 2GB bandwidth/month. PDF-ки на ~50-100MB — хватит на 10-20 документов.
- **Timeout**: Upload 100MB через server action может упереться в Vercel timeout (60s на Pro). Альтернатива — presigned URL для direct upload с клиента (но усложняет). Начнём с server action, если упрёмся — переделаем на direct upload.
- **Обратная совместимость**: `pdfPath` fallback остаётся рабочим для локальной разработки (кладём PDF в `public/`, pipeline читает с диска).
- **Bucket создание**: Если SQL миграция не создаёт bucket автоматически, создать вручную в Supabase Dashboard → Storage → New Bucket → `document-pdfs`, private, 100MB limit, allowed MIME: `application/pdf`.
