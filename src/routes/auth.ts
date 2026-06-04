import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import type { Env } from '../types'

const auth = new Hono<{ Bindings: Env }>()

const phoneSchema = z.string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164 format e.g. +233241234567')

// -------------------------------------------------------
// POST /auth/send-otp
// -------------------------------------------------------
auth.post('/send-otp',
  zValidator('json', z.object({ phone: phoneSchema })),
  async (c) => {
    const { phone } = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { error } = await supabase.auth.signInWithOtp({ phone })
    if (error) {
      console.error('OTP send error:', error.message)
      return c.json({ success: false, error: 'Could not send OTP. Check the number and try again.', code: 'OTP_SEND_FAILED' }, 400)
    }

    return c.json({ success: true, data: { message: `OTP sent to ${phone}`, expires_in: 300 } })
  }
)

// -------------------------------------------------------
// POST /auth/verify-otp
// Creates user + wallet records on first login
// -------------------------------------------------------
auth.post('/verify-otp',
  zValidator('json', z.object({
    phone: phoneSchema,
    token: z.string().length(6, 'OTP must be 6 digits'),
  })),
  async (c) => {
    const { phone, token } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' })
    if (error || !data.session || !data.user) {
      return c.json({ success: false, error: 'Invalid or expired OTP', code: 'OTP_INVALID' }, 400)
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id, role, full_name, diaspora_mode')
      .eq('id', data.user.id)
      .single()

    let isNewUser = false

    if (!existingUser) {
      const countryCode  = detectCountryFromPhone(phone)
      const currencyCode = countryCurrency[countryCode] ?? 'GHS'

      // Create user
      await supabase.from('users').insert({
        id: data.user.id,
        phone,
        role: 'client',
        country_code: countryCode,
        currency_code: currencyCode,
        taska_score: 50,
        is_blacklisted: false,
        diaspora_mode: false,
        diaspora_target_country: null,
      })

      // Create client wallet automatically
      await supabase.from('wallets').insert({
        user_id: data.user.id,
        wallet_type: 'client',
        balance: 0,
        currency_code: currencyCode,
        is_frozen: false,
      })

      isNewUser = true
    }

    return c.json({
      success: true,
      data: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
        user: {
          id:            data.user.id,
          phone,
          role:          existingUser?.role ?? 'client',
          full_name:     existingUser?.full_name ?? null,
          diaspora_mode: existingUser?.diaspora_mode ?? false,
          is_new_user:   isNewUser,
        }
      }
    })
  }
)

// -------------------------------------------------------
// POST /auth/refresh
// -------------------------------------------------------
auth.post('/refresh',
  zValidator('json', z.object({ refresh_token: z.string() })),
  async (c) => {
    const { refresh_token } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    const { data, error } = await supabase.auth.refreshSession({ refresh_token })
    if (error || !data.session) {
      return c.json({ success: false, error: 'Session expired. Please log in again.', code: 'SESSION_EXPIRED' }, 401)
    }

    return c.json({
      success: true,
      data: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
      }
    })
  }
)

// -------------------------------------------------------
// POST /auth/diaspora-mode
// Activates when user is detected outside Africa
// -------------------------------------------------------
auth.post('/diaspora-mode',
  zValidator('json', z.object({
    target_country: z.string().length(2),  // GH, NG, KE etc
    target_city:    z.string(),
  })),
  async (c) => {
    const { target_country, target_city } = c.req.valid('json')
    const authHeader = c.req.header('Authorization')
    if (!authHeader) return c.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)

    const token    = authHeader.replace('Bearer ', '')
    const supabase = getSupabase(c.env)
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return c.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)

    await supabase.from('users').update({
      diaspora_mode: true,
      diaspora_target_country: target_country,
    }).eq('id', user.id)

    return c.json({
      success: true,
      data: {
        message: `Diaspora mode activated. Showing providers in ${target_city}, ${target_country}.`,
        protection: 'Only providers with 4.5+ stars and 20+ completed jobs will appear.',
      }
    })
  }
)

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function detectCountryFromPhone(phone: string): string {
  if (phone.startsWith('+233')) return 'GH'
  if (phone.startsWith('+234')) return 'NG'
  if (phone.startsWith('+254')) return 'KE'
  if (phone.startsWith('+255')) return 'TZ'
  if (phone.startsWith('+256')) return 'UG'
  if (phone.startsWith('+250')) return 'RW'
  if (phone.startsWith('+225')) return 'CI'
  if (phone.startsWith('+221')) return 'SN'
  if (phone.startsWith('+237')) return 'CM'
  if (phone.startsWith('+27'))  return 'ZA'
  if (phone.startsWith('+260')) return 'ZM'
  return 'GH'
}

const countryCurrency: Record<string, string> = {
  GH: 'GHS', NG: 'NGN', KE: 'KES', TZ: 'TZS',
  UG: 'UGX', RW: 'RWF', CI: 'XOF', SN: 'XOF',
  CM: 'XAF', ZA: 'ZAR', ZM: 'ZMW',
}

export { auth as authRoutes }
