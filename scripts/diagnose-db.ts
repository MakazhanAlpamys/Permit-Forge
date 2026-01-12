// ============================================================================
// Database Diagnostics Script
// Run with: npx tsx scripts/diagnose-db.ts
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mekqrfayzqredmfdqdip.supabase.co';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3FyZmF5enFyZWRtZmRxZGlwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzQzNzYxNiwiZXhwIjoyMDgzMDEzNjE2fQ.A3zi4yLSPqP0uQGRnLOTdfVkdXO19qvMyND869IKXhY';

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function diagnose() {
  console.log('🔍 Diagnosing database...\n');

  // Test 1: Users table
  console.log('1️⃣ Testing USERS table...');
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, role')
      .limit(5);
    
    if (error) {
      console.log('   ❌ Error:', error.message);
    } else {
      console.log('   ✅ Users found:', users?.length || 0);
      users?.forEach(u => console.log(`      - ${u.username} (${u.role})`));
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 2: Insert user
  console.log('\n2️⃣ Testing INSERT into users...');
  try {
    const testUsername = `test_${Date.now()}`;
    const { data, error } = await supabase
      .from('users')
      .insert({
        username: testUsername,
        password_hash: 'test_hash',
        role: 'user',
      })
      .select('id')
      .single();
    
    if (error) {
      console.log('   ❌ Insert error:', error.message);
      console.log('   📋 Error code:', error.code);
      console.log('   📋 Error details:', error.details);
    } else {
      console.log('   ✅ Insert successful, ID:', data?.id);
      
      // Clean up
      await supabase.from('users').delete().eq('id', data?.id);
      console.log('   🧹 Test user cleaned up');
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 3: dubai_code_chunks table
  console.log('\n3️⃣ Testing DUBAI_CODE_CHUNKS table...');
  try {
    const { count, error } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });
    
    if (error) {
      console.log('   ❌ Error:', error.message);
    } else {
      console.log('   ✅ Chunks count:', count);
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 4: Insert into dubai_code_chunks
  console.log('\n4️⃣ Testing INSERT into dubai_code_chunks...');
  try {
    const testEmbedding = new Array(768).fill(0.1);
    const { data, error } = await supabase
      .from('dubai_code_chunks')
      .insert({
        content: 'Test chunk content',
        metadata: { page: 1 },
        embedding: testEmbedding,
      })
      .select('id')
      .single();
    
    if (error) {
      console.log('   ❌ Insert error:', error.message);
      console.log('   📋 Error code:', error.code);
    } else {
      console.log('   ✅ Insert successful, ID:', data?.id);
      
      // Clean up
      await supabase.from('dubai_code_chunks').delete().eq('id', data?.id);
      console.log('   🧹 Test chunk cleaned up');
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 5: DELETE from dubai_code_chunks
  console.log('\n5️⃣ Testing DELETE from dubai_code_chunks...');
  try {
    const { error } = await supabase
      .from('dubai_code_chunks')
      .delete()
      .gte('id', 999999999); // Delete nothing (ID doesn't exist)
    
    if (error) {
      console.log('   ❌ Delete error:', error.message);
    } else {
      console.log('   ✅ Delete operation works');
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 6: match_dubai_code RPC
  console.log('\n6️⃣ Testing match_dubai_code RPC...');
  try {
    const testEmbedding = new Array(768).fill(0);
    const { data, error } = await supabase.rpc('match_dubai_code', {
      query_embedding: testEmbedding,
      match_count: 1,
      filter: {},
    });
    
    if (error) {
      console.log('   ❌ RPC error:', error.message);
      console.log('   📋 Error code:', error.code);
    } else {
      console.log('   ✅ RPC works, results:', data?.length || 0);
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 7: Audit logs
  console.log('\n7️⃣ Testing AUDIT_LOGS table...');
  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .insert({
        action: 'test_action',
        metadata: { test: true },
      })
      .select('id')
      .single();
    
    if (error) {
      console.log('   ❌ Insert error:', error.message);
    } else {
      console.log('   ✅ Audit log insert works, ID:', data?.id);
      await supabase.from('audit_logs').delete().eq('id', data?.id);
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  // Test 8: Admin functions
  console.log('\n8️⃣ Testing admin RPC functions...');
  try {
    const { data, error } = await supabase.rpc('get_admin_stats');
    
    if (error) {
      console.log('   ❌ get_admin_stats error:', error.message);
    } else {
      console.log('   ✅ get_admin_stats works:', data?.[0]);
    }
  } catch (e) {
    console.log('   ❌ Exception:', e);
  }

  console.log('\n✨ Diagnostics complete!\n');
  console.log('📝 If you see permission errors, run the SQL migration:');
  console.log('   1. Go to Supabase Dashboard -> SQL Editor');
  console.log('   2. Run the contents of: supabase/migrations/002_fix_permissions.sql');
}

diagnose().catch(console.error);
