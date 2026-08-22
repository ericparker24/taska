import { createMiddleware } from 'hono/factory'
import { getSupabase } from '../lib/supabase'
import type { Env } from '../types'

type AuthVariables = {
  userId: string
  phone: string
  role: string
}

// Verify Supabase JWT from Authorization header
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: 'Missing auth token', code: 'UNAUTHORIZED' }, 401)
    }

    const token    = authHeader.replace('Bearer ', '')
    const supabase = getSupabase(c.env)

    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return c.json({ success: false, error: 'Invalid or expired token', code: 'UNAUTHORIZED' }, 401)
    }

    const { data: userData } = await supabase
      .from('users')
      .select('id, phone, role, is_blacklisted')
      .eq('id', user.id)
      .single()

    if (!userData) {
      return c.json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' }, 404)
    }

    if (userData.is_blacklisted) {
      return c.json({ success: false, error: 'Account suspended', code: 'BLACKLISTED' }, 403)
    }

    c.set('userId', userData.id)
    c.set('phone', userData.phone)
    c.set('role', userData.role)

    return next()
  }
)

// Require provider role
export const requireProvider = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    if (c.get('role') !== 'provider') {
      return c.json({ success: false, error: 'Provider account required', code: 'FORBIDDEN' }, 403)
    }
    return next()
  }
)

// Require admin role
export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    if (c.get('role') !== 'admin') {
      return c.json({ success: false, error: 'Admin access required', code: 'FORBIDDEN' }, 403)
    }
    return next()
  }
)
