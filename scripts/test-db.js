const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabase = createClient(
  'https://mekqrfayzqredmfdqdip.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzQzNzYxNiwiZXhwIjoyMDgzMDEzNjE2fQ.A3zi4yLSPqP0uQGRnLOTdfVkdXO19qvMyND869IKXhY',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

async function test() {
  console.log('=== Testing Database Access ===\n');
  
  // Test 1: Try RPC function
  console.log('1. Testing RPC function get_admin_stats:');
  const { data: stats, error: statsError } = await supabase.rpc('get_admin_stats');
  console.log('   Stats:', stats);
  console.log('   Error:', statsError);

  // Test 2: Try selecting from users with raw SQL via RPC
  console.log('\n2. Trying to list all tables:');
  const { data: tables, error: tablesError } = await supabase
    .from('information_schema.tables')
    .select('table_name')
    .eq('table_schema', 'public');
  console.log('   Tables:', tables);
  console.log('   Error:', tablesError);
  
  // Test 3: Check if audit_logs is accessible (usually more permissive)
  console.log('\n3. Testing audit_logs table:');
  const { data: logs, error: logsError } = await supabase
    .from('audit_logs')
    .select('*')
    .limit(5);
  console.log('   Logs count:', logs?.length);
  console.log('   Error:', logsError);

  // Test 4: Try anon key
  console.log('\n4. Testing with anon key:');
  const anonSupabase = createClient(
    'https://mekqrfayzqredmfdqdip.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0Mzc2MTYsImV4cCI6MjA4MzAxMzYxNn0._CH-UffrGoPuPDoZkBrYcivbf2IM_VTYAq9ISgxjWFA'
  );
  
  const { data: anonUser, error: anonError } = await anonSupabase
    .from('users')
    .select('id, username, role, blocked')
    .eq('username', 'admin')
    .single();
  console.log('   User with anon:', anonUser);
  console.log('   Error:', anonError);
}

test().catch(console.error);
