#!/usr/bin/env node

// ============================================================================
// Create User Script
// Usage: npx tsx scripts/create-user.ts
// ============================================================================

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as readline from 'readline';
import bcrypt from 'bcryptjs';

// Load environment variables from .env.local
config({ path: '.env.local' });

// Use same salt rounds as lib/auth.ts
const BCRYPT_SALT_ROUNDS = 12;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

// Note: Can't import from @/lib/auth in standalone script due to Next.js dependencies
// Using local implementation with same BCRYPT_SALT_ROUNDS for consistency
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

async function main() {
  console.log('\n=== Create New User ===\n');

  // Check environment variables
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Missing environment variables');
    console.error('Make sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env.local');
    process.exit(1);
  }

  // Validate that we have the service role key (not anon key)
  try {
    const payload = JSON.parse(Buffer.from(supabaseKey.split('.')[1], 'base64').toString());
    if (payload.role !== 'service_role') {
      console.error('\n⚠️  WARNING: This appears to be an ANON key, not SERVICE_ROLE key!');
      console.error('   Service Role Key is required to bypass RLS.');
      console.error('   Find it in: Supabase Dashboard → Settings → API → service_role (secret)\n');
    }
  } catch {
    // Could not decode key, continue anyway
  }

  // Service Role Key bypasses RLS with auth.admin option
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  try {
    const username = await question('Username: ');
    const password = await question('Password: ');
    const fullName = await question('Full Name (optional): ');
    const roleInput = await question('Role (admin/user, default: user): ');
    const role = roleInput.trim() || 'user';

    if (!username || !password) {
      console.error('\nError: Username and password are required');
      rl.close();
      process.exit(1);
    }

    if (role !== 'admin' && role !== 'user') {
      console.error('\nError: Role must be either "admin" or "user"');
      rl.close();
      process.exit(1);
    }

    const passwordHash = await hashPassword(password);

    const { data, error } = await supabase
      .from('users')
      .insert({
        username,
        password_hash: passwordHash,
        full_name: fullName || null,
        role,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        console.error('\nError: Username already exists');
      } else {
        console.error('\nError:', error.message);
      }
      rl.close();
      process.exit(1);
    }

    console.log('\n✅ User created successfully!');
    console.log(`   ID: ${data.id}`);
    console.log(`   Username: ${data.username}`);
    console.log(`   Role: ${data.role}\n`);
  } catch (error) {
    console.error('\nError:', error);
    process.exit(1);
  }

  rl.close();
}

main();
