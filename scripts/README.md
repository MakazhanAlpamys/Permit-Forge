# Scripts

## `create-admin.ts` — create or promote an admin user

Replaces the removed default-admin migration (audit ID **P1-C2**).

### Prerequisites
`tsx` is not in `package.json`; run via `npx tsx ...` (downloads on first use)
or install once: `npm i -D tsx`.

`.env.local` must contain `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### Create a new admin
```bash
npx tsx scripts/create-admin.ts \
  --username admin \
  --email admin@example.com \
  --password 'StrongPass!123' \
  --name 'Site Administrator'
```

### Promote existing user to admin (keeps password)
```bash
npx tsx scripts/create-admin.ts \
  --username existinguser \
  --email same@email.com \
  --password 'irrelevant-but-required'
```
The script detects the existing username and only flips `role`, `email_verified`,
and `email` — original password is untouched.

### Rotate password while promoting
Add `--reset-password`:
```bash
npx tsx scripts/create-admin.ts \
  --username admin --email admin@example.com \
  --password 'NewPass!456' --reset-password
```

### Validation
- Username: 3-32 chars, `[a-z0-9_-]`
- Email: standard format
- Password: min 8 chars (set your own complexity in real ops)

### Alternatives
If you don't want to run a Node script, use the SQL template at
`scripts/sql/create-admin.template.sql` — fill the placeholders and run
the result via Supabase SQL Editor.

**Do NOT copy the template into `supabase/migrations/`** — files there
are auto-applied by `supabase db push` and `supabase db reset`, which
would attempt to insert literal `<ADMIN_USERNAME>` / `<ADMIN_EMAIL>`
strings into your `users` table.
