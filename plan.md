# План миграции с Resend на Nodemailer + Gmail SMTP

Этот план предназначен для Claude Code или другого AI-ассистента для выполнения задачи по замене почтового провайдера с Resend (которому нужен домен) на бесплатный вариант отправки через Gmail SMTP (используя App Password).

## 1. Обновление зависимостей (package.json)

Необходимо удалить `resend` и установить `nodemailer`.

**Команды:**
```bash
npm uninstall resend
npm install nodemailer
npm install -D @types/nodemailer
```

## 2. Обновление переменных окружения (.env.local)

Нужно удалить старые ключи Resend и добавить ключи для SMTP.

**Удалить:**
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

**Добавить:**
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_USER=твой_gmail_аккаунт@gmail.com`
- `SMTP_PASS=твой_app_password`

*(Также нужно будет обновить `.env.example`, если он есть)*

## 3. Рефакторинг `lib/email.ts`

В этом файле нужно полностью заменить логику `resend` на `nodemailer`.

**Что нужно сделать:**
1. Настроить `nodemailer.createTransport` с использованием `process.env.SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` и `SMTP_PASS`.
2. Изменить функцию `getFromEmail()`, чтобы она возвращала `` `PermitForge <${process.env.SMTP_USER}>` ``.
3. Переписать функции `sendVerificationEmail`, `sendPasswordResetEmail`, `sendPasswordChangeCodeEmail`:
   - Вместо проверки `if (!process.env.RESEND_API_KEY)` проверять `if (!process.env.SMTP_USER || !process.env.SMTP_PASS)`.
   - Заменить `resend.emails.send` на `transporter.sendMail`.
   - В случае успеха возвращать `true`, при ошибке логировать её и возвращать `false`.
   - Оставить функцию `generateSixDigitCode` и генератор HTML без изменений.

**Пример настройки транспортера:**
```typescript
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
```

Внутри `lib/email.ts` также полезно экспортировать `transporter` или создать функцию `sendHtmlEmail`, чтобы использовать её в `lib/notifications.ts`.

## 4. Рефакторинг `lib/notifications.ts`

Файл `lib/notifications.ts` также напрямую импортирует и использует `resend` для отправки уведомлений.

**Что нужно сделать:**
1. Найти места использования `import('resend')`.
2. Заменить проверку `process.env.RESEND_API_KEY` на `process.env.SMTP_PASS`.
3. Либо импортировать готовый `transporter` из `lib/email.ts`, либо создать его заново. (Лучше импортировать и переиспользовать).
4. Заменить вызов `resend.emails.send` на вызов `transporter.sendMail`.

## 5. Обновление юнит-тестов (`test/email.test.ts`)

Тесты сейчас замоканы под объект `resend`. Их нужно переписать под мок `nodemailer`.

**Что нужно сделать:**
1. Заменить `vi.mock('resend', ...)` на `vi.mock('nodemailer', ...)`.
   - Мок должен возвращать `createTransport: () => ({ sendMail: mockSendMail })`.
2. В блоках `beforeEach`/`afterEach` и самих тестах заменить переопределение переменной окружения `RESEND_API_KEY` на `SMTP_USER` и `SMTP_PASS`.
3. В проверках `expect(mockSend).toHaveBeenCalledWith(...)` проверить параметры `to`, `from`, `subject` и `html`, передаваемые в функции Nodemailer (они почти такие же, как в Resend).

## 6. Обновление документации (`README.md` и `CLAUDE.md`)

**Что нужно сделать:**
- Найти все упоминания `RESEND_API_KEY` и `Resend`.
- Заменить их на инструкцию по настройке Nodemailer:
  - Указать, что для рассылки писем используется Nodemailer + Gmail SMTP.
  - Описать краткую инструкцию по получению App Password (пароля приложения) от Google.
  - Привести актуальный список переменных окружения (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).

## Инструкция для пользователя по созданию App Password Google
В качестве дополнительной информации для пользователя, для настройки Gmail:
1. Перейти в https://myaccount.google.com/security
2. Включить Двухэтапную аутентификацию (2FA).
3. Перейти в Пароли приложений (App passwords).
4. Сгенерировать новый пароль для "Почта" ("Mail") и скопировать полученный 16-значный код.
5. Вставить этот код без пробелов в `.env.local` как `SMTP_PASS`.
