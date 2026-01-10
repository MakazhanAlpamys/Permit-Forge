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
    console.error('Make sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

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
