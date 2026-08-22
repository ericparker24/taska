/**
 * src/lib/keepalive.ts
 *
 * Prevents the Supabase free tier from pausing during development.
 * Runs via Cloudflare cron every 5 minutes.
 * No-ops in production — real traffic keeps the DB awake naturally.
 */

import { getSupabase } from './supabase'
import type { Env } from '../types'

export async function keepAlive(env: Env): Promise<void> {
  if (env.ENVIRONMENT === 'production') return

  try {
    const supabase = getSupabase(env)
    await supabase.from('users').select('id').limit(1)
    console.log('[keepalive] Supabase ping OK:', new Date().toISOString())
  } catch (err) {
    console.warn('[keepalive] ping failed:', err)
  }
}
