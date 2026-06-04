import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import {
  calculateCommission,
  calculateGuarantorFees,
  calculateEvidenceScore,
  splitBookingAmounts,
  getAutoReleaseAt,
  getAbandonmentRefundAt,
  FALSE_DISPUTE_PENALTY_PESEWAS,
} from '../lib/pricing'
import type { Env } from '../types'

const bookings = new Hono<{ Bindings: Env }>()
bookings.use('*', requireAuth)

// -------------------------------------------------------
// POST /bookings
// Create Route 1 (simple) or Route 2 (guaranteed) booking
// -------------------------------------------------------
bookings.post('/',
  zValidator('json', z.object({
    provider_id:      z.string().uuid(),
    service_id:       z.string().uuid(),
    booking_route:    z.enum(['route_1', 'route_2']),
    description:      z.string().min(10).max(1000),
    total_amount:     z.number().int().positive(),
    location_address: z.string().optional(),
    location_lat:     z.number().optional(),
    location_lng:     z.number().optional(),
    landmark_description: z.string().optional(),  // rural fallback
    scheduled_at:     z.string().datetime().optional(),
    // Route 2 only
    guarantor_type:   z.enum(['personal', 'taska_verified', 'escrow_only']).optional(),
    guarantor_phone:  z.string().optional(),
    guarantor_message: z.string().max(200).optional(),  // personal message in SMS
    materials_option: z.enum(['marketplace', 'guarantor', 'hybrid']).optional(),
    milestones: z.array(z.object({
      title:    z.string(),
      amount:   z.number().int().positive(),
      due_date: z.string().datetime().optional(),
    })).optional(),
  })),
  async (c) => {
    const clientId = c.get('userId')
    const body     = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Verify provider is live
    const { data: provider } = await supabase
      .from('providers')
      .select('id, is_live, starter_lock_until')
      .eq('id', body.provider_id)
      .single()

    if (!provider?.is_live) {
      return c.json({ success: false, error: 'Provider is not available', code: 'PROVIDER_UNAVAILABLE' }, 400)
    }

    const hasGuarantor = body.booking_route === 'route_2' && body.guarantor_type !== 'escrow_only'
    const { materialsAmount, labourAmount, commission } = splitBookingAmounts(body.total_amount, hasGuarantor)

    // Create booking
    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({
        client_id:        clientId,
        provider_id:      body.provider_id,
        service_id:       body.service_id,
        booking_route:    body.booking_route,
        status:           'pending',
        total_amount:     body.total_amount,
        labour_amount:    labourAmount,
        materials_amount: materialsAmount,
        commission_amount: commission,
        description:      body.description,
        location_address: body.location_address ?? null,
        location_lat:     body.location_lat ?? null,
        location_lng:     body.location_lng ?? null,
        landmark_description: body.landmark_description ?? null,
        scheduled_at:     body.scheduled_at ?? null,
        client_pin_confirmed: false,
      })
      .select()
      .single()

    if (error || !booking) {
      return c.json({ success: false, error: 'Could not create booking', code: 'DB_ERROR' }, 500)
    }

    // Route 2: create guarantor + materials plan + milestones
    if (body.booking_route === 'route_2') {
      // Create guarantor record
      if (body.guarantor_type && body.guarantor_type !== 'escrow_only' && body.guarantor_phone) {
        const guarantorFees = calculateGuarantorFees(body.total_amount)
        await supabase.from('guarantors').insert({
          booking_id:       booking.id,
          user_id:          null,   // set when guarantor registers
          guarantor_type:   body.guarantor_type,
          phone:            body.guarantor_phone,
          personal_message: body.guarantor_message ?? null,
          materials_amount: materialsAmount,
          fee_amount:       guarantorFees.toGuarantor,
          receipt_approved: false,
          site_visit_confirmed: false,
          status:           'invited',
          expires_at:       new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        })
      }

      // Create materials plan
      if (body.materials_option) {
        const mpAmount = body.materials_option === 'guarantor' ? materialsAmount : Math.round(materialsAmount * 0.5)
        const gwAmount = body.materials_option === 'marketplace' ? 0 : materialsAmount - mpAmount
        await supabase.from('materials_plans').insert({
          booking_id:              booking.id,
          option:                  body.materials_option,
          total_materials_amount:  materialsAmount,
          marketplace_amount:      mpAmount,
          guarantor_amount:        gwAmount,
          marketplace_confirmed:   false,
          guarantor_confirmed:     false,
        })
      }

      // Create milestones
      if (body.milestones?.length) {
        await supabase.from('milestones').insert(
          body.milestones.map(m => ({
            booking_id:     booking.id,
            title:          m.title,
            amount:         m.amount,
            status:         'pending',
            evidence_score: 0,
            due_date:       m.due_date ?? null,
          }))
        )
      }
    }

    // Route 1: single auto-release milestone
    if (body.booking_route === 'route_1') {
      await supabase.from('milestones').insert({
        booking_id:     booking.id,
        title:          'Service Completion',
        amount:         labourAmount,
        status:         'pending',
        evidence_score: 0,
      })
    }

    // Notify provider
    await supabase.from('notifications').insert({
      user_id: body.provider_id,
      type:    'new_booking',
      title:   'New booking request',
      body:    `You have a new ${body.booking_route === 'route_2' ? 'guaranteed project' : 'service'} booking`,
      data:    { booking_id: booking.id },
      is_read: false,
    })

    return c.json({
      success: true,
      data: {
        booking_id:       booking.id,
        status:           'pending',
        labour_amount:    labourAmount,
        materials_amount: materialsAmount,
        commission:       commission,
        message:          body.booking_route === 'route_2'
          ? 'Booking created. Please call your guarantor before they receive the SMS.'
          : 'Booking created. Waiting for provider to accept.',
      }
    }, 201)
  }
)

// -------------------------------------------------------
// GET /bookings/:id
// -------------------------------------------------------
bookings.get('/:id', async (c) => {
  const bookingId = c.req.param('id')
  const userId    = c.get('userId')
  const supabase  = getSupabase(c.env)

  const { data: booking, error } = await supabase
    .from('bookings')
    .select(`*, milestones(*), payments(*), guarantors(*), evidence(*), withdrawal_requests(*)`)
    .eq('id', bookingId)
    .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
    .single()

  if (error || !booking) {
    return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
  }

  return c.json({ success: true, data: booking })
})

// -------------------------------------------------------
// POST /bookings/:id/accept — Provider accepts booking
// -------------------------------------------------------
bookings.post('/:id/accept', async (c) => {
  const bookingId = c.req.param('id')
  const userId    = c.get('userId')
  const supabase  = getSupabase(c.env)

  const { data: provider } = await supabase
    .from('providers').select('id').eq('user_id', userId).single()

  const { data: booking, error } = await supabase
    .from('bookings')
    .update({ status: 'accepted' })
    .eq('id', bookingId)
    .eq('provider_id', provider?.id ?? '')
    .eq('status', 'pending')
    .select()
    .single()

  if (error || !booking) {
    return c.json({ success: false, error: 'Booking not found or already processed', code: 'NOT_FOUND' }, 404)
  }

  await supabase.from('notifications').insert({
    user_id: booking.client_id,
    type:    'booking_accepted',
    title:   'Booking accepted!',
    body:    'Your provider has accepted. Proceed to payment to confirm.',
    data:    { booking_id: bookingId },
    is_read: false,
  })

  return c.json({ success: true, data: { status: 'accepted', booking_id: bookingId } })
})

// -------------------------------------------------------
// POST /bookings/:id/request-payment
// Provider taps REQUEST PAYMENT — triggers 72hr auto-release timer
// Client MUST enter PIN to release or deny
// -------------------------------------------------------
bookings.post('/:id/request-payment',
  zValidator('json', z.object({
    milestone_id: z.string().uuid().optional(),
    amount:       z.number().int().positive(),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: provider } = await supabase
      .from('providers').select('id').eq('user_id', userId).single()

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, status')
      .eq('id', bookingId)
      .eq('provider_id', provider?.id ?? '')
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    if (!['in_progress'].includes(booking.status)) {
      return c.json({ success: false, error: 'Cannot request payment at this stage', code: 'INVALID_STATUS' }, 400)
    }

    const now           = new Date()
    const autoReleaseAt = getAutoReleaseAt(now)

    // Create withdrawal request
    const { data: withdrawal } = await supabase
      .from('withdrawal_requests')
      .insert({
        booking_id:      bookingId,
        milestone_id:    body.milestone_id ?? null,
        provider_id:     provider!.id,
        amount:          body.amount,
        status:          'pending',
        requested_at:    now.toISOString(),
        auto_release_at: autoReleaseAt.toISOString(),
      })
      .select()
      .single()

    // Update booking status
    await supabase.from('bookings').update({
      status: 'withdrawal_requested',
      withdrawal_requested_at: now.toISOString(),
      auto_release_at: autoReleaseAt.toISOString(),
    }).eq('id', bookingId)

    // Notify client with WARNING
    await supabase.from('notifications').insert({
      user_id: booking.client_id,
      type:    'withdrawal_requested',
      title:   'Provider is requesting payment',
      body:    `Once you release this payment it cannot be reversed. Only confirm if you are satisfied. You have 72 hours.`,
      data:    { booking_id: bookingId, withdrawal_id: withdrawal?.id, auto_release_at: autoReleaseAt.toISOString() },
      is_read: false,
    })

    return c.json({
      success: true,
      data: {
        withdrawal_id:   withdrawal?.id,
        auto_release_at: autoReleaseAt.toISOString(),
        message:         'Payment request sent. Client has 72 hours to approve or deny.',
      }
    })
  }
)

// -------------------------------------------------------
// POST /bookings/:id/release-payment
// Client enters PIN to approve withdrawal
// -------------------------------------------------------
bookings.post('/:id/release-payment',
  zValidator('json', z.object({
    withdrawal_id: z.string().uuid(),
    pin:           z.string().length(4),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, provider_id, status, labour_amount, commission_amount')
      .eq('id', bookingId)
      .eq('client_id', userId)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    // Update withdrawal + booking
    await supabase.from('withdrawal_requests').update({
      status: 'approved', resolved_at: new Date().toISOString()
    }).eq('id', body.withdrawal_id)

    await supabase.from('bookings').update({
      status: 'completed',
      client_pin_confirmed: true,
    }).eq('id', bookingId)

    // Notify provider
    await supabase.from('notifications').insert({
      user_id: booking.provider_id,
      type:    'payment_released',
      title:   'Payment released!',
      body:    'Your client has approved the payment. Funds are now in your wallet.',
      data:    { booking_id: bookingId },
      is_read: false,
    })

    return c.json({
      success: true,
      data: { message: 'Payment released to provider successfully.' }
    })
  }
)

// -------------------------------------------------------
// POST /bookings/:id/deny-payment
// Client denies withdrawal — must give reason → triggers dispute
// -------------------------------------------------------
bookings.post('/:id/deny-payment',
  zValidator('json', z.object({
    withdrawal_id: z.string().uuid(),
    reason:        z.string().min(10).max(500),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, provider_id')
      .eq('id', bookingId)
      .eq('client_id', userId)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    await supabase.from('withdrawal_requests').update({
      status: 'denied', denial_reason: body.reason, resolved_at: new Date().toISOString()
    }).eq('id', body.withdrawal_id)

    await supabase.from('bookings').update({ status: 'disputed' }).eq('id', bookingId)

    // Auto-create dispute
    await supabase.from('disputes').insert({
      booking_id:     bookingId,
      raised_by:      'client',
      reason:         body.reason,
      denial_reason:  body.reason,
      evidence_urls:  [],
      status:         'open',
      bot_confidence: null,
      admin_override: false,
      false_dispute_penalty_applied: false,
    })

    // Red flag check — if client has denied 2+ times
    const { count } = await supabase
      .from('disputes')
      .select('*', { count: 'exact' })
      .eq('raised_by', 'client')
      .in('booking_id', [bookingId])

    if ((count ?? 0) >= 2) {
      await supabase.from('red_flags').insert({
        booking_id:   bookingId,
        user_id:      userId,
        flag_type:    'client_bad_faith_denial',
        severity:     'warning',
        description:  'Client has denied payment multiple times on same booking',
        auto_actioned: false,
        resolved:     false,
      })
    }

    return c.json({
      success: true,
      data: { message: 'Payment denied. A dispute has been raised. Admin will review.' }
    })
  }
)

// -------------------------------------------------------
// POST /bookings/:id/evidence
// Provider submits GPS + photos + time + code
// -------------------------------------------------------
bookings.post('/:id/evidence',
  zValidator('json', z.object({
    milestone_id:             z.string().uuid(),
    gps_lat:                  z.number().optional(),
    gps_lng:                  z.number().optional(),
    arrival_photo_url:        z.string().url().optional(),
    completion_photo_url:     z.string().url().optional(),
    time_on_site_minutes:     z.number().int().min(0),
    confirmation_code:        z.string().length(4).optional(),
    expected_duration_minutes: z.number().int().optional(),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: provider } = await supabase
      .from('providers').select('id').eq('user_id', userId).single()

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id')
      .eq('id', bookingId)
      .eq('provider_id', provider?.id ?? '')
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    const score = calculateEvidenceScore({
      hasGps:               !!(body.gps_lat && body.gps_lng),
      hasPhoto:             !!(body.arrival_photo_url || body.completion_photo_url),
      timeOnSiteMinutes:    body.time_on_site_minutes,
      hasConfirmationCode:  !!body.confirmation_code,
      expectedDurationMinutes: body.expected_duration_minutes,
    })

    await supabase.from('evidence').insert({
      milestone_id:         body.milestone_id,
      booking_id:           bookingId,
      provider_id:          provider!.id,
      gps_lat:              body.gps_lat ?? null,
      gps_lng:              body.gps_lng ?? null,
      gps_score:            body.gps_lat ? 25 : 0,
      arrival_photo_url:    body.arrival_photo_url ?? null,
      completion_photo_url: body.completion_photo_url ?? null,
      photo_score:          (body.arrival_photo_url || body.completion_photo_url) ? 25 : 0,
      time_on_site_minutes: body.time_on_site_minutes,
      time_score:           score >= 75 ? 25 : score >= 50 ? 15 : 5,
      confirmation_code:    body.confirmation_code ?? null,
      confirmation_score:   body.confirmation_code ? 25 : 0,
      total_score:          score,
    })

    await supabase.from('milestones').update({
      evidence_score: score,
      status:         'evidence_submitted',
    }).eq('id', body.milestone_id)

    // Notify client
    await supabase.from('notifications').insert({
      user_id: booking.client_id,
      type:    'evidence_submitted',
      title:   'Work completed!',
      body:    `Provider submitted completion evidence. Score: ${score}/100`,
      data:    { booking_id: bookingId, score },
      is_read: false,
    })

    return c.json({
      success: true,
      data: {
        evidence_score: score,
        message: score >= 75
          ? 'Evidence submitted. Provider can now request payment.'
          : 'Evidence submitted but score is low. Client approval required.',
      }
    })
  }
)

export { bookings as bookingRoutes }
