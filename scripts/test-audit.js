const { createClient } = require('@supabase/supabase-js');

// Test both clients
const anonClient = createClient(
  'https://mekqrfayzqredmfdqdip.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0Mzc2MTYsImV4cCI6MjA4MzAxMzYxNn0._CH-UffrGoPuPDoZkBrYcivbf2IM_VTYAq9ISgxjWFA'
);

const serviceClient = createClient(
  'https://mekqrfayzqredmfdqdip.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzQzNzYxNiwiZXhwIjoyMDgzMDEzNjE2fQ.A3zi4yLSPqP0uQGRnLOTdfVkdXO19qvMyND869IKXhY'
);

async function test() {
  console.log('=== Testing Audit Log Insert ===\n');

  // Test 1: Insert with anon client
  console.log('1. Insert audit log with ANON client:');
  const { data: anonData, error: anonError } = await anonClient
    .from('audit_logs')
    .insert({
      action: 'test_login',
      metadata: { test: true },
      ip_address: '127.0.0.1',
      user_agent: 'test-script'
    })
    .select();
  console.log('   Data:', anonData);
  console.log('   Error:', anonError);

  // Test 2: Insert with service client
  console.log('\n2. Insert audit log with SERVICE client:');
  const { data: serviceData, error: serviceError } = await serviceClient
    .from('audit_logs')
    .insert({
      action: 'test_login_service',
      metadata: { test: true },
      ip_address: '127.0.0.1',
      user_agent: 'test-script'
    })
    .select();
  console.log('   Data:', serviceData);
  console.log('   Error:', serviceError);

  // Test 3: Update users with anon (for last_login)
  console.log('\n3. Update user last_login with ANON client:');
  const { error: updateError } = await anonClient
    .from('users')
    .update({ last_login: new Date().toISOString() })
    .eq('username', 'admin');
  console.log('   Error:', updateError);
}

test().catch(console.error);
