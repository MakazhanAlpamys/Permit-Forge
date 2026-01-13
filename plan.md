# 🏗️ МАСТЕР-ПЛАН: RAG Citations → 100%

## 📊 Прогресс реализации

### ✅ Фаза 1: Улучшенный Ingestion (COMPLETED ✓)
- [x] Установить `pdfjs-dist` (Mozilla PDF.js)
- [x] Обновить `types/index.ts` — добавить `startPage`, `endPage`, `sectionPath`, `TOCEntry`
- [x] Создать `lib/pdf-parser.ts` — новый парсер с TOC extraction
- [x] Переписать `actions/ingest-pdf.ts` — использовать pdf.js
- [x] Обновить `app/api/ingest/route.ts` — streaming с pdf.js
- [x] SQL миграция `002_enhanced_metadata.sql` — индексы и helper functions
- [x] Обновить UI — показывать "Pages 45-46" с badges

**Что реализовано в Фазе 1:**
```
✅ PDF.js парсер с точным отслеживанием страниц
✅ TOC extraction из PDF bookmarks/outlines
✅ Fallback detection секций из контента
✅ Page range tracking (startPage → endPage)
✅ Section mapping по TOC
✅ Content type detection (text/table/list/heading)
✅ UI с badges для page ranges и verified citations
✅ SQL helper functions: match_citation, find_chunks_by_page/section
```

### ⏳ Фаза 2: Умные Citations (NEXT)
- [ ] Парсинг `[Page X, Section Y]` из ответа AI
- [ ] Сопоставление цитат с чанками в базе (использовать `match_citation` RPC)
- [ ] Динамическое количество Sources (1-10)
- [ ] Streaming API с умными citations
- [ ] Флаг `isVerified` для каждой citation

### ⏳ Фаза 3: Верификация (PENDING)
- [ ] Использовать output `verifyAnswer()`
- [ ] Показывать confidence для каждого source
- [ ] Удалять невалидные sources

### ⏳ Фаза 4: Rich Excerpt (PENDING)
- [ ] Markdown рендеринг для таблиц
- [ ] Table detection при ingestion (уже есть `contentType`)
- [ ] Кнопка "View in PDF"

---

## 📁 Изменённые файлы (Фаза 1)

| Файл | Изменение |
|------|-----------|
| `package.json` | +pdfjs-dist |
| `types/index.ts` | +TOCEntry, +ChunkWithPageRange, startPage/endPage |
| `lib/pdf-parser.ts` | **NEW** - PDF.js парсер с TOC |
| `actions/ingest-pdf.ts` | Переписан на pdf.js |
| `app/api/ingest/route.ts` | Streaming с pdf.js |
| `supabase/migrations/002_enhanced_metadata.sql` | **NEW** - индексы, RPC functions |
| `components/chat/source-citation.tsx` | Page ranges, verified badges |

---

🎯 Анализ: Как довести всё до 100%
1️⃣ НОМЕР СТРАНИЦЫ → 100%
Текущие проблемы:
Fallback делит по символам (не знает реальных страниц)
Чанк на границе 2 страниц → показывает только первую
Некоторые PDF не отдают pageIndex корректно
Решения:
Решение  Описание  Результат
A. Убрать fallback  Если pagerender не работает → ошибка вместо угадывания  100% или честная ошибка
B. Хранить диапазон страниц  pages: [45, 46] вместо page: 45  100% - показываем все страницы чанка
C. Использовать pdf.js вместо pdf-parse  Более надёжная библиотека Mozilla  100% - точный pageIndex
D. Привязка к координатам  PDF хранит позицию текста (x, y) → можно точно знать страницу  100% - абсолютная точность
Лучший вариант: B + C

Перейти на pdf.js (надёжнее)
Хранить startPage и endPage для каждого чанка
В UI показывать: Pages 45-46 если чанк на границе
2️⃣ НОМЕР СЕКЦИИ → 100%
Текущие проблемы:
Regex ловит первое число X.X.X в тексте
Может поймать номер таблицы, рисунка, формулы
Не понимает иерархию документа
Решения:
Решение  Описание  Результат
A. Парсинг Table of Contents  PDF обычно имеет TOC с bookmarks → извлечь структуру  95-100%
B. Распознавание заголовков  Заголовки = крупный/жирный шрифт → pdf.js даёт font info  95%
C. Двухпроходный парсинг  1й проход: найти все секции, 2й: привязать текст  98%
D. LLM при ingestion  Для каждого чанка спросить AI "какая секция?"  99% но дорого
E. Структурный анализ  Секции начинаются с новой строки, имеют определённый формат  90%
Лучший вариант: A + C
Шаг 1: Извлечь TOC/Bookmarks из PDF
        Chapter 1 ────────── Page 10
        ├── 1.1 General ──── Page 12
        ├── 1.2 Scope ────── Page 15
        Chapter 2 ────────── Page 30
        ...

Шаг 2: Для каждого чанка найти секцию по странице
        Чанк на странице 13 → между 1.1 (стр 12) и 1.2 (стр 15)
        → Секция = 1.1

3️⃣ РЕЛЕВАНТНОСТЬ → 100%
Текущие проблемы:
Hybrid search даёт score, но это не "релевантность к ответу"
Re-ranking даёт 0-100, но результат не используется в Citations
Показываем 5 чанков, даже если 3 из них мусор
Решения:
Решение  Описание  Результат
A. Использовать rerank score  Заменить similarity на rerank score (0-100)  90%
B. Жёсткий фильтр  Показывать только score >= 70  95%
C. По цитатам в ответе  AI написал [Page 45] → показать только Page 45  99%
D. Верификация каждого source  AI проверяет "этот чанк реально использован?"  100%
Лучший вариант: C + D
AI ответ: "The minimum width is 1.2m [Page 45, Section 3.2.1] 
          and height must be 2.4m [Page 67]"
                    ↓
Парсим цитаты: [{page: 45, section: "3.2.1"}, {page: 67}]
                    ↓
Из 7 чанков оставляем только те, что на Page 45 и Page 67
                    ↓
Показываем 2 Sources (не 5!)
Результат: 100% релевантность - показываем ТОЛЬКО то, что AI реально использовал.

4️⃣ EXCERPT → 100%
Текущие проблемы:
Таблицы теряют структуру
Колонки могут смешаться
Спецсимволы, переносы, пробелы
Решения:
Решение  Описание  Результат
A. pdf.js с позициями  Извлекать текст с координатами → сохранять структуру  95%
B. Разделять таблицы  Определять таблицы → парсить как JSON/Markdown  98%
C. OCR для сложных PDF  Tesseract.js для сканов  90%
D. Сохранять formatting  Жирный, курсив, размер шрифта → Markdown  95%
E. Показывать скриншот  Вместо текста - картинка области PDF  100%
Лучший вариант: A + B + E
Для обычного текста: pdf.js с координатами
Для таблиц: специальный парсер → Markdown формат
Fallback: ссылка "View in PDF" → открывает страницу
📊 Анализ текущей архитектуры Emirate Forge
Текущая реализация
1️⃣ PDF Ingestion (ingest-pdf.ts)
Как работает сейчас:

Использует pdf-parse для извлечения текста
Реализован pagerender callback для отслеживания страниц через pageData.pageIndex
Fallback: если pagerender не работает → делит текст по ~3000 символов на "страницу" (угадывание!)
Чанки: 800 символов с overlap 150
Метаданные извлекаются regex-ом из контента чанка:
page — номер страницы
section — первое найденное X.X.X в тексте
chapter — "Chapter N: ..."
tableId / tableName
isTable, headings
Проблемы:

❌ Fallback делит по символам — не знает реальных страниц
❌ Чанк на границе страниц → хранится только page, не диапазон
❌ section ловит первое число X.X.X — может поймать номер таблицы/рисунка
❌ Нет TOC extraction — не понимает иерархию документа
2️⃣ RAG Pipeline (rag.ts)
Как работает:

Hybrid Search: Vector (70%) + Keyword FTS (30%) с RRF fusion
Возвращает 25 чанков → Re-ranking оставляет top 7
match_dubai_code_hybrid RPC в Supabase
Что хорошо:

✅ RRF fusion реализован правильно
✅ Exact search для секций/таблиц
✅ Фильтрация по similarity > 0.4
3️⃣ AI Agents (agents.ts)
Реализовано:

Topic Classifier — on/off topic detection
Query Expansion — 4 вариации запроса
Re-ranking — AI scoring 0-100 для каждого чанка
Answer Verification — проверка на hallucinations
Проблема:

❌ Re-rank score не используется в Citations! Всегда берётся top 5
❌ Нет парсинга цитат из ответа AI
4️⃣ Chat & Citations (chat.ts, source-citation.tsx)
Текущий flow:

AI генерирует ответ с [Page X, Section Y] inline
Citations берутся из top 5 чанков (не из ответа!)
UI показывает: Page, Section, Excerpt (200 символов)
Проблемы:

❌ Релевантность 70% — показываем 5 чанков даже если AI использовал только 2
❌ Excerpt теряет форматирование таблиц
❌ Нет "View in PDF" ссылки
5️⃣ Database Schema (001_complete_setup.sql)
dubai_code_chunks (
  id BIGSERIAL,
  content TEXT,
  metadata JSONB,        -- {page, chapter, section, tableId, ...}
  embedding VECTOR(768),
  fts tsvector           -- Auto-generated for keyword search
)
Что нужно добавить для плана:

startPage / endPage вместо одного page
sectionPath — полный путь из TOC
isTable flag уже есть, но нет table content отдельно
📋 Соответствие твоему плану
Элемент	Текущее состояние	Что нужно изменить
Номер страницы	pdf-parse + fallback угадывание	→ pdf.js + startPage/endPage
Номер секции	Regex X.X.X из текста	→ TOC extraction + page mapping
Релевантность	Top 5 чанков (не по ответу)	→ Парсинг [Page X] из ответа AI
Excerpt	200 символов plain text	→ Markdown для таблиц + "View in PDF"
🗂️ Файлы для изменения по фазам:
Фаза 1: Улучшенный Ingestion

ingest-pdf.ts — заменить pdf-parse на pdf.js
index.ts — добавить startPage, endPage, sectionPath
SQL миграция — обновить metadata структуру
Фаза 2: Умные Citations

chat.ts — парсинг [Page X, Section Y] из ответа
agents.ts — сопоставление цитат с чанками
route.ts — streaming с умными citations
Фаза 3: Верификация

agents.ts — verifyAnswer() уже есть, нужно использовать его output
Фаза 4: Rich Excerpt

source-citation.tsx — Markdown рендеринг
ingest-pdf.ts — table detection при ingestion
