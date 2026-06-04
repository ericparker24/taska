import { createMiddleware } from 'hono/factory'
import { getSupabase } from '../lib/supabase'
import type { Env } from '../types'

// Extends Hono context with authenticated user
type AuthVariables = {
  userId: string
  phone: string
  role: string
}

// Middleware: verify Supabase JWT from Authorization header
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ success: false, error: 'Missing auth token', code: 'UNAUTHORIZED' }, 401)
    }

    const token = authHeader.replace('Bearer ', '')
    const supabase = getSupabase(c.env)

    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return c.json({ success: false, error: 'Invalid or expired token', code: 'UNAUTHORIZED' }, 401)
    }

    // Check blacklist
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

    await next()
  }
)

// Middleware: require provider role
export const requireProvider = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const role = c.get('role')
    if (role !== 'provider') {
      return c.json({ success: false, error: 'Provider account required', code: 'FORBIDDEN' }, 403)
    }
    await next()
  }
)

// Middleware: require admin role
export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const role = c.get('role')
    if (role !== 'admin') {
      return c.json({ success: false, error: 'Admin access required', code: 'FORBIDDEN' }, 403)
    }
    await next()
  }
)
