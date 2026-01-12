const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

// Using ANON key since it works
const supabase = createClient(
  'https://mekqrfayzqredmfdqdip.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0Mzc2MTYsImV4cCI6MjA4MzAxMzYxNn0._CH-UffrGoPuPDoZkBrYcivbf2IM_VTYAq9ISgxjWFA'
);

async function test() {
  console.log('=== Testing Password Verification ===\n');
  
  // Find admin user with password_hash
  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, password_hash, role, blocked')
    .eq('username', 'admin')
    .single();
  
  console.log('1. User lookup:');
  console.log('   Found:', user ? 'YES' : 'NO');
  console.log('   Error:', error);
  
  if (user) {
    console.log('\n2. User details:');
    console.log('   ID:', user.id);
    console.log('   Username:', user.username);
    console.log('   Role:', user.role);
    console.log('   Blocked:', user.blocked);
    console.log('   Password hash:', user.password_hash);
    
    if (user.password_hash) {
      console.log('\n3. Hash analysis:');
      console.log('   Hash length:', user.password_hash.length);
      console.log('   First 7 chars:', user.password_hash.substring(0, 7));
      
      // Test with bcryptjs
      const testPassword = 'Admin123!';
      console.log('\n4. Testing password "Admin123!":');
      
      try {
        const isValid = await bcrypt.compare(testPassword, user.password_hash);
        console.log('   bcryptjs.compare result:', isValid);
        
        if (!isValid) {
          console.log('\n5. PROBLEM FOUND!');
          console.log('   The hash in DB was created with PostgreSQL crypt() function');
          console.log('   But the app uses bcryptjs which has different format');
          console.log('\n   PostgreSQL crypt hash starts with: $2a$06$ (or similar)');
          console.log('   bcryptjs hash starts with: $2a$12$ (or $2b$12$)');
          
          // Generate correct bcryptjs hash
          const correctHash = await bcrypt.hash(testPassword, 12);
          console.log('\n6. Correct bcryptjs hash for "Admin123!":');
          console.log('   ', correctHash);
          console.log('\n   Run this SQL in Supabase to fix:');
          console.log(`   UPDATE users SET password_hash = '${correctHash}' WHERE username = 'admin';`);
        }
      } catch (err) {
        console.log('   bcrypt error:', err.message);
      }
    }
  }
}

test().catch(console.error);
