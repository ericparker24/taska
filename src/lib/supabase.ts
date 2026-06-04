import { createClient } from '@supabase/supabase-js'
import type { Env } from '../types'

// Supabase client using service role key (server-side only — never expose to client)
export function getSupabase(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
