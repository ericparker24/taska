import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { Env } from '../types'

const guarantors = new Hono<{ Bindings: Env }>()

// -------------------------------------------------------
// POST /guarantors/accept/:token
// Guarantor clicks SMS link and accepts role
// No auth required — they may not have an account yet
// -------------------------------------------------------
guarantors.post('/accept/:token',
  zValidator('json', z.object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  })),
  async (c) => {
    const token    = c.req.param('token')
    const { phone } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Find guarantor invite by token (stored as id)
    const { data: guarantor } = await supabase
      .from('guarantors')
      .select('*, bookings(description, total_amount, location_address)')
      .eq('id', token)
      .eq('phone', phone)
      .eq('status', 'invited')
      .single()

    if (!guarantor) {
      return c.json({ success: false, error: 'Invitation not found or already used', code: 'NOT_FOUND' }, 404)
    }

    // Check expiry (48 hours)
    if (new Date() > new Date(guarantor.expires_at)) {
      await supabase.from('guarantors').update({ status: 'timed_out' }).eq('id', token)
      return c.json({ success: false, error: 'This invitation has expired', code: 'EXPIRED' }, 410)
    }

    await supabase.from('guarantors').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', token)

    // Advance the booking — client can now proceed to fund milestone 1
    const { data: booking } = await supabase
      .from('bookings')
      .update({ status: 'accepted' })
      .eq('id', guarantor.booking_id)
      .eq('status', 'awaiting_guarantor')
      .select('id, client_id, provider_id')
      .single()

    if (booking) {
      await supabase.from('notifications').insert({
        user_id: booking.client_id,
        type:    'guarantor_accepted',
        title:   'Guarantor accepted!',
        body:    'Your nominated guarantor has accepted. You can now fund the first milestone to begin.',
        data:    { booking_id: booking.id },
        is_read: false,
      })

      // System message into the shared three-way thread — first time all
      // three parties (client, provider, guarantor) are actually connected.
      await supabase.from('project_messages').insert({
        booking_id:  booking.id,
        sender_id:   guarantor.id,
        sender_role: 'guarantor',
        body:        'Guarantor has accepted and joined this project thread.',
        is_system:   true,
      })
    }

    return c.json({
      success: true,
      data: {
        guarantor_id:     guarantor.id,
        booking_id:       guarantor.booking_id,
        materials_amount: guarantor.materials_amount,
        fee_amount:       guarantor.fee_amount,
        job_description:  guarantor.bookings?.description,
        job_location:     guarantor.bookings?.location_address,
        message:          'You have accepted the guarantor role. Please complete your quick registration.',
        next_step:        'register',
      }
    })
  }
)

// -------------------------------------------------------
// POST /guarantors/register
// Quick 2-minute guarantor registration
// -------------------------------------------------------
guarantors.post('/register',
  zValidator('json', z.object({
    guarantor_id: z.string().uuid(),
    phone:        z.string().regex(/^\+[1-9]\d{7,14}$/),
    full_name:    z.string().min(2).max(100),
    otp_token:    z.string().length(6),
  })),
  async (c) => {
    const { guarantor_id, phone, full_name, otp_token } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Verify OTP
    const { data, error } = await supabase.auth.verifyOtp({ phone, token: otp_token, type: 'sms' })
    if (error || !data.user) {
      return c.json({ success: false, error: 'Invalid OTP', code: 'OTP_INVALID' }, 400)
    }

    // Upsert user as guarantor role
    await supabase.from('users').upsert({
      id:           data.user.id,
      phone,
      full_name,
      role:         'guarantor',
      country_code: detectCountryFromPhone(phone),
      currency_code: 'GHS',
      taska_score:  50,
      is_blacklisted: false,
      diaspora_mode: false,
      diaspora_target_country: null,
    })

    // Create guarantor wallet
    const { data: existingWallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', data.user.id)
      .eq('wallet_type', 'guarantor')
      .single()

    if (!existingWallet) {
      await supabase.from('wallets').insert({
        user_id:      data.user.id,
        wallet_type:  'guarantor',
        balance:      0,
        currency_code: 'GHS',
        is_frozen:    false,
      })
    }

    // Link user to guarantor record
    await supabase.from('guarantors').update({
      user_id: data.user.id,
      status:  'registered',
    }).eq('id', guarantor_id)

    return c.json({
      success: true,
      data: {
        access_token:  data.session?.access_token,
        refresh_token: data.session?.refresh_token,
        message:       'Registration complete! Materials money will be sent to your wallet shortly.',
      }
    })
  }
)

// -------------------------------------------------------
// POST /guarantors/:id/upload-receipt
// Guarantor uploads receipt after buying materials
// -------------------------------------------------------
guarantors.post('/:id/upload-receipt',
  requireAuth,
  zValidator('json', z.object({
    receipt_url:   z.string().url(),
    materials_photo_url: z.string().url(),
    notes:         z.string().max(300).optional(),
  })),
  async (c) => {
    const guarantorId = c.req.param('id')
    const userId      = c.get('userId')
    const body        = c.req.valid('json')
    const supabase    = getSupabase(c.env)

    const { data: guarantor } = await supabase
      .from('guarantors')
      .select('*, bookings(client_id)')
      .eq('id', guarantorId)
      .eq('user_id', userId)
      .single()

    if (!guarantor) {
      return c.json({ success: false, error: 'Guarantor record not found', code: 'NOT_FOUND' }, 404)
    }

    await supabase.from('guarantors').update({
      receipt_url: body.receipt_url,
      status:      'materials_purchased',
    }).eq('id', guarantorId)

    // Notify client to approve receipt
    await supabase.from('notifications').insert({
      user_id: guarantor.bookings?.client_id,
      type:    'receipt_uploaded',
      title:   'Materials purchased!',
      body:    'Your guarantor has uploaded the materials receipt. Please review and approve.',
      data:    { guarantor_id: guarantorId, receipt_url: body.receipt_url },
      is_read: false,
    })

    return c.json({
      success: true,
      data: { message: 'Receipt uploaded. Waiting for client approval before work begins.' }
    })
  }
)

// -------------------------------------------------------
// POST /guarantors/:id/confirm-job
// Guarantor confirms job is complete at site
// -------------------------------------------------------
guarantors.post('/:id/confirm-job',
  requireAuth,
  zValidator('json', z.object({
    site_photo_url: z.string().url(),
    notes:          z.string().max(300).optional(),
  })),
  async (c) => {
    const guarantorId = c.req.param('id')
    const userId      = c.get('userId')
    const body        = c.req.valid('json')
    const supabase    = getSupabase(c.env)

    const { data: guarantor } = await supabase
      .from('guarantors')
      .select('*, bookings(client_id, provider_id)')
      .eq('id', guarantorId)
      .eq('user_id', userId)
      .single()

    if (!guarantor) {
      return c.json({ success: false, error: 'Not found', code: 'NOT_FOUND' }, 404)
    }

    await supabase.from('guarantors').update({
      site_visit_confirmed: true,
      status: 'job_confirmed',
    }).eq('id', guarantorId)

    // Notify client
    await supabase.from('notifications').insert({
      user_id: guarantor.bookings?.client_id,
      type:    'guarantor_confirmed',
      title:   'Guarantor confirmed job complete',
      body:    'Your guarantor has confirmed the job is complete. Please review and release payment.',
      data:    { guarantor_id: guarantorId, booking_id: guarantor.booking_id },
      is_read: false,
    })

    return c.json({
      success: true,
      data: { message: 'Job confirmed. Client has been notified to release payment.' }
    })
  }
)

function detectCountryFromPhone(phone: string): string {
  if (phone.startsWith('+233')) return 'GH'
  if (phone.startsWith('+234')) return 'NG'
  if (phone.startsWith('+254')) return 'KE'
  return 'GH'
}

export { guarantors as guarantorRoutes }
