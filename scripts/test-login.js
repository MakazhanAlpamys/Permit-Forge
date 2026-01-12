const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

// Using service_role key with auth.admin to bypass RLS
const supabase = createClient(
  'https://mekqrfayzqredmfdqdip.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzQzNzYxNiwiZXhwIjoyMDgzMDEzNjE2fQ.A3zi4yLSPqP0uQGRnLOTdfVkdXO19qvMyND869IKXhY',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: 'public',
    },
  }
);

async function test() {
  console.log('=== Testing Login ===\n');
  
  // Find admin user
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', 'admin')
    .single();
  
  console.log('1. User lookup result:');
  console.log('   User found:', user ? 'YES' : 'NO');
  console.log('   Error:', error);
  
  if (user) {
    console.log('\n2. User details:');
    console.log('   ID:', user.id);
    console.log('   Username:', user.username);
    console.log('   Role:', user.role);
    console.log('   Blocked:', user.blocked);
    console.log('   Password hash:', user.password_hash);
    console.log('   Hash type:', user.password_hash?.substring(0, 4));
    
    // Test password with bcrypt
    const testPassword = 'Admin123!';
    console.log('\n3. Password verification:');
    console.log('   Testing password:', testPassword);
    
    try {
      const isValid = await bcrypt.compare(testPassword, user.password_hash);
      console.log('   bcryptjs result:', isValid);
      
      if (!isValid) {
        // Check if it's a PostgreSQL crypt format vs bcryptjs format
        console.log('\n4. Hash analysis:');
        console.log('   Hash length:', user.password_hash?.length);
        console.log('   Starts with $2a$:', user.password_hash?.startsWith('$2a$'));
        console.log('   Starts with $2b$:', user.password_hash?.startsWith('$2b$'));
        
        // Create a new hash with bcryptjs for comparison
        const newHash = await bcrypt.hash(testPassword, 12);
        console.log('\n5. New bcryptjs hash for Admin123!:', newHash);
        console.log('   This hash should work. You may need to update the DB.');
      }
    } catch (err) {
      console.log('   bcrypt error:', err.message);
    }
  }
}

test().catch(console.error);
