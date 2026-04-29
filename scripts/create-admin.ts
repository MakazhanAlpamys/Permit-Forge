/**
 * Create or promote an admin user.
 *
 * Usage:
 *   npx tsx scripts/create-admin.ts \
 *     --username admin \
 *     --email admin@example.com \
 *     --password 'StrongPass!123' \
 *     [--name 'Full Name']
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Idempotent: if username already exists, promotes to admin without touching
 * the existing password (use --reset-password to overwrite).
 */

import { createClient } from '@supabase/supabase-js';
import * as bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Args = {
  username?: string;
  email?: string;
  password?: string;
  name?: string;
  resetPassword?: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--username': out.username = next; i++; break;
      case '--email': out.email = next; i++; break;
      case '--password': out.password = next; i++; break;
      case '--name': out.name = next; i++; break;
      case '--reset-password': out.resetPassword = true; break;
    }
  }
  return out;
}

function loadDotEnv(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, 'utf8');
    const env: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
    return env;
  } catch {
    return {};
  }
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.username || !args.email || !args.password) {
    fail('required flags: --username, --email, --password (optional: --name, --reset-password)');
  }
  if (args.password!.length < 8) fail('password must be at least 8 characters');
  if (!/^[a-z0-9_-]{3,32}$/.test(args.username!)) {
    fail('username must be 3-32 chars, lowercase letters/digits/_/-');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email!)) fail('invalid email format');

  const dotenv = loadDotEnv(resolve(process.cwd(), '.env.local'));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || dotenv.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || dotenv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env / .env.local');

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const passwordHash = bcrypt.hashSync(args.password!, 12);

  const { data: existing, error: lookupErr } = await supabase
    .from('users')
    .select('id, username, role, email')
    .eq('username', args.username!)
    .maybeSingle();

  if (lookupErr) fail(`lookup failed: ${lookupErr.message}`);

  if (existing) {
    const update: Record<string, unknown> = {
      role: 'admin',
      email_verified: true,
      email: args.email,
    };
    if (args.name) update.full_name = args.name;
    if (args.resetPassword) update.password_hash = passwordHash;

    const { error } = await supabase
      .from('users')
      .update(update)
      .eq('id', existing.id);
    if (error) fail(`update failed: ${error.message}`);

    console.log(`✓ promoted existing user "${existing.username}" to admin (id=${existing.id})`);
    if (args.resetPassword) console.log('  password rotated.');
    else console.log('  password kept (use --reset-password to overwrite).');
    return;
  }

  const { data: created, error: insertErr } = await supabase
    .from('users')
    .insert({
      username: args.username,
      email: args.email,
      password_hash: passwordHash,
      full_name: args.name ?? 'System Administrator',
      role: 'admin',
      email_verified: true,
    })
    .select('id, username, email, role')
    .single();

  if (insertErr) fail(`insert failed: ${insertErr.message}`);

  console.log(`✓ created admin "${created!.username}" (id=${created!.id}, email=${created!.email})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
