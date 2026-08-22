import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import {
  calculateGuarantorFees,
  calculateEvidenceScore,
  splitBookingAmounts,
  getAutoReleaseAt,
  getNextMilestoneToFund,
  getCancellationConfirmAt,
  isMilestoneOverdue,
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
    guarantor_type:   z.enum(['personal', 'taska_verified']).optional(),  // 'escrow_only' removed — guarantor is compulsory for Route 2
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

    if (body.booking_route === 'route_2' && (!body.guarantor_type || !body.guarantor_phone)) {
      return c.json({
        success: false,
        error: 'A guarantor is required for guaranteed projects — nominate someone before continuing.',
        code: 'GUARANTOR_REQUIRED',
      }, 400)
    }

    // Verify provider is live
    const { data: provider } = await supabase
      .from('providers')
      .select('id, is_live, starter_lock_until')
      .eq('id', body.provider_id)
      .single()

    if (!provider?.is_live) {
      return c.json({ success: false, error: 'Provider is not available', code: 'PROVIDER_UNAVAILABLE' }, 400)
    }

    const hasGuarantor = body.booking_route === 'route_2'
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
      // Create guarantor record — validation above guarantees this exists
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
          body.milestones.map((m, i) => ({
            booking_id:     booking.id,
            sequence:       i + 1,
            title:          m.title,
            amount:         m.amount,
            status:         'pending',
            evidence_score: 0,
            funded_at:      null,
            due_date:       m.due_date ?? null,
          }))
        )
      }
    }

    // Route 1: single auto-release milestone
    if (body.booking_route === 'route_1') {
      await supabase.from('milestones').insert({
        booking_id:     booking.id,
        sequence:       1,
        title:          'Service Completion',
        amount:         labourAmount,
        status:         'pending',
        evidence_score: 0,
        funded_at:      null,
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

  const { data: existing } = await supabase
    .from('bookings').select('booking_route').eq('id', bookingId).single()

  const nextStatus = existing?.booking_route === 'route_2' ? 'awaiting_guarantor' : 'accepted'

  const { data: booking, error } = await supabase
    .from('bookings')
    .update({ status: nextStatus })
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
    body:    nextStatus === 'awaiting_guarantor'
      ? 'Your provider has accepted. Your nominated guarantor must accept their role before payment can begin.'
      : 'Your provider has accepted. Proceed to payment to confirm.',
    data:    { booking_id: bookingId },
    is_read: false,
  })

  return c.json({ success: true, data: { status: nextStatus, booking_id: bookingId } })
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

    if (body.milestone_id) {
      // Route 2: scope the "awaiting payment" state to this milestone only —
      // other milestones on the same project keep moving independently.
      await supabase.from('milestones').update({
        status: 'withdrawal_requested',
      }).eq('id', body.milestone_id)
    } else {
      // Route 1: single milestone covers the whole booking, so this is safe.
      await supabase.from('bookings').update({
        status: 'withdrawal_requested',
        withdrawal_requested_at: now.toISOString(),
        auto_release_at: autoReleaseAt.toISOString(),
      }).eq('id', bookingId)
    }

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
      .select('id, provider_id, status, booking_route, labour_amount, commission_amount')
      .eq('id', bookingId)
      .eq('client_id', userId)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    // Update withdrawal
    const { data: withdrawal } = await supabase.from('withdrawal_requests').update({
      status: 'approved', resolved_at: new Date().toISOString()
    }).eq('id', body.withdrawal_id).select().single()

    if (booking.booking_route === 'route_2' && withdrawal?.milestone_id) {
      // Milestone-scoped release — does NOT complete the whole project.
      await supabase.from('milestones').update({
        status: 'released',
        completed_at: new Date().toISOString(),
      }).eq('id', withdrawal.milestone_id)

      const { data: allMilestones } = await supabase
        .from('milestones')
        .select('id, sequence, status')
        .eq('booking_id', bookingId)

      const allReleased = (allMilestones ?? []).every(m => m.status === 'released')

      if (allReleased) {
        await supabase.from('bookings').update({ status: 'completed' }).eq('id', bookingId)
      } else {
        // Rolling escrow: prompt the client to fund whichever milestone is next.
        const next = getNextMilestoneToFund(allMilestones ?? [])
        if (next) {
          await supabase.from('notifications').insert({
            user_id: userId,
            type:    'milestone_funding_due',
            title:   'Fund the next milestone',
            body:    `Milestone ${next.sequence} is ready to start. Fund it to keep your project moving.`,
            data:    { booking_id: bookingId, milestone_id: next.id },
            is_read: false,
          })
        }
      }
    } else {
      // Route 1 — single milestone covers the whole booking.
      await supabase.from('bookings').update({
        status: 'completed',
        client_pin_confirmed: true,
      }).eq('id', bookingId)
    }

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

// -------------------------------------------------------
// POST /bookings/:id/updates
// Freeform progress check-in (Route 2) — not tied to a milestone.
// Keeps the client informed across long projects between milestones.
// -------------------------------------------------------
bookings.post('/:id/updates',
  zValidator('json', z.object({
    note: z.string().min(1).max(1000),
    photo_urls: z.array(z.string().url()).max(6).optional(),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id, booking_route')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    if (booking.booking_route !== 'route_2') {
      return c.json({ success: false, error: 'Progress updates are only available for guaranteed projects', code: 'INVALID_ROUTE' }, 400)
    }

    const postedBy = userId === booking.client_id ? 'client' : 'provider'
    const recipientId = postedBy === 'client' ? booking.provider_id : booking.client_id

    const { data: update, error } = await supabase
      .from('project_updates')
      .insert({
        booking_id: bookingId,
        posted_by: postedBy,
        note: body.note,
        photo_urls: body.photo_urls ?? [],
      })
      .select()
      .single()

    if (error || !update) {
      return c.json({ success: false, error: 'Could not post update', code: 'DB_ERROR' }, 500)
    }

    await supabase.from('notifications').insert({
      user_id: recipientId,
      type:    'project_update',
      title:   'New project update',
      body:    body.note.slice(0, 120),
      data:    { booking_id: bookingId, update_id: update.id },
      is_read: false,
    })

    return c.json({ success: true, data: update }, 201)
  }
)

// -------------------------------------------------------
// GET /bookings/:id/updates
// -------------------------------------------------------
bookings.get('/:id/updates', async (c) => {
  const bookingId = c.req.param('id')
  const userId    = c.get('userId')
  const supabase  = getSupabase(c.env)

  const { data: booking } = await supabase
    .from('bookings')
    .select('id')
    .eq('id', bookingId)
    .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
    .single()

  if (!booking) {
    return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
  }

  const { data: updates } = await supabase
    .from('project_updates')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })

  return c.json({ success: true, data: updates ?? [] })
})

// -------------------------------------------------------
// POST /bookings/:id/change-orders
// Propose a mid-project scope/price change (Route 2).
// Requires the other party to accept before anything changes.
// -------------------------------------------------------
bookings.post('/:id/change-orders',
  zValidator('json', z.object({
    description: z.string().min(10).max(1000),
    amount_delta: z.number().int(),                       // pesewas, can be negative
    new_milestone_titles: z.array(z.string()).max(10).optional(),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id, booking_route')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }
    if (booking.booking_route !== 'route_2') {
      return c.json({ success: false, error: 'Change orders are only available for guaranteed projects', code: 'INVALID_ROUTE' }, 400)
    }

    const proposedBy = userId === booking.client_id ? 'client' : 'provider'
    const recipientId = proposedBy === 'client' ? booking.provider_id : booking.client_id

    const { data: changeOrder, error } = await supabase
      .from('change_orders')
      .insert({
        booking_id: bookingId,
        proposed_by: proposedBy,
        description: body.description,
        amount_delta: body.amount_delta,
        new_milestone_titles: body.new_milestone_titles ?? [],
        status: 'proposed',
      })
      .select()
      .single()

    if (error || !changeOrder) {
      return c.json({ success: false, error: 'Could not create change order', code: 'DB_ERROR' }, 500)
    }

    await supabase.from('notifications').insert({
      user_id: recipientId,
      type:    'change_order_proposed',
      title:   'Project change proposed',
      body:    `${proposedBy === 'client' ? 'Your client' : 'Your provider'} proposed a change to this project. Review and respond.`,
      data:    { booking_id: bookingId, change_order_id: changeOrder.id },
      is_read: false,
    })

    return c.json({ success: true, data: changeOrder }, 201)
  }
)

// -------------------------------------------------------
// POST /bookings/:id/change-orders/:changeOrderId/respond
// The other party accepts or rejects. Accepting adjusts the
// booking total and appends any new milestones (pending, unfunded).
// -------------------------------------------------------
bookings.post('/:id/change-orders/:changeOrderId/respond',
  zValidator('json', z.object({
    decision: z.enum(['accepted', 'rejected']),
    response_note: z.string().max(500).optional(),
  })),
  async (c) => {
    const bookingId     = c.req.param('id')
    const changeOrderId = c.req.param('changeOrderId')
    const userId         = c.get('userId')
    const body           = c.req.valid('json')
    const supabase       = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id, total_amount')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    const { data: changeOrder } = await supabase
      .from('change_orders')
      .select('*')
      .eq('id', changeOrderId)
      .eq('booking_id', bookingId)
      .eq('status', 'proposed')
      .single()

    if (!changeOrder) {
      return c.json({ success: false, error: 'Change order not found or already resolved', code: 'NOT_FOUND' }, 404)
    }

    const responderRole = userId === booking.client_id ? 'client' : 'provider'
    if (responderRole === changeOrder.proposed_by) {
      return c.json({ success: false, error: 'Cannot respond to your own change order', code: 'INVALID_ACTION' }, 400)
    }

    await supabase.from('change_orders').update({
      status: body.decision,
      responded_by: responderRole,
      response_note: body.response_note ?? null,
      resolved_at: new Date().toISOString(),
    }).eq('id', changeOrderId)

    if (body.decision === 'accepted') {
      await supabase.from('bookings').update({
        total_amount: booking.total_amount + changeOrder.amount_delta,
      }).eq('id', bookingId)

      if (changeOrder.new_milestone_titles?.length) {
        const { data: existing } = await supabase
          .from('milestones').select('sequence').eq('booking_id', bookingId)
          .order('sequence', { ascending: false }).limit(1)
        const startSeq = (existing?.[0]?.sequence ?? 0) + 1

        await supabase.from('milestones').insert(
          changeOrder.new_milestone_titles.map((title: string, i: number) => ({
            booking_id: bookingId,
            sequence: startSeq + i,
            title,
            amount: 0,   // amount to be set once parties agree on a price for the new milestone
            status: 'pending',
            evidence_score: 0,
            funded_at: null,
          }))
        )
      }
    }

    const notifyId = changeOrder.proposed_by === 'client' ? booking.client_id : booking.provider_id
    await supabase.from('notifications').insert({
      user_id: notifyId,
      type:    'change_order_resolved',
      title:   body.decision === 'accepted' ? 'Change order accepted' : 'Change order rejected',
      body:    body.response_note ?? `Your proposed change was ${body.decision}.`,
      data:    { booking_id: bookingId, change_order_id: changeOrderId },
      is_read: false,
    })

    return c.json({ success: true, data: { status: body.decision } })
  }
)

// -------------------------------------------------------
// POST /bookings/:id/cancel
// Either party requests early termination. Mirrors the
// withdrawal-request pattern — the OTHER party has 48 hours to
// confirm or dispute before it finalizes automatically.
// -------------------------------------------------------
bookings.post('/:id/cancel',
  zValidator('json', z.object({
    reason: z.string().min(10).max(1000),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id, booking_route, status')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }
    if (booking.booking_route !== 'route_2') {
      return c.json({ success: false, error: 'Use a regular dispute for Route 1 jobs', code: 'INVALID_ROUTE' }, 400)
    }
    if (!['in_progress', 'withdrawal_requested'].includes(booking.status)) {
      return c.json({ success: false, error: 'Cannot cancel a project at this stage', code: 'INVALID_STATUS' }, 400)
    }

    const requestedBy = userId === booking.client_id ? 'client' : 'provider'
    const recipientId = requestedBy === 'client' ? booking.provider_id : booking.client_id
    const now = new Date()
    const confirmBy = getCancellationConfirmAt(now)

    const { data: cancellation, error } = await supabase
      .from('cancellation_requests')
      .insert({
        booking_id: bookingId,
        requested_by: requestedBy,
        reason: body.reason,
        status: 'pending',
        requested_at: now.toISOString(),
        confirm_by: confirmBy.toISOString(),
      })
      .select()
      .single()

    if (error || !cancellation) {
      return c.json({ success: false, error: 'Could not create cancellation request', code: 'DB_ERROR' }, 500)
    }

    await supabase.from('bookings').update({ status: 'cancellation_requested' }).eq('id', bookingId)

    await supabase.from('notifications').insert({
      user_id: recipientId,
      type:    'cancellation_requested',
      title:   'Project cancellation requested',
      body:    `${requestedBy === 'client' ? 'Your client' : 'Your provider'} wants to end this project early. You have 48 hours to respond or it auto-confirms.`,
      data:    { booking_id: bookingId, cancellation_id: cancellation.id, confirm_by: confirmBy.toISOString() },
      is_read: false,
    })

    return c.json({
      success: true,
      data: {
        cancellation_id: cancellation.id,
        confirm_by: confirmBy.toISOString(),
        message: 'Cancellation requested. The other party has 48 hours to confirm or dispute.',
      }
    }, 201)
  }
)

// -------------------------------------------------------
// POST /bookings/:id/cancel/:cancellationId/confirm
// The other party agrees. Finalizes the project: any milestone
// that's funded but has no submitted evidence is refunded to the
// client. Milestones already mid-evidence/withdrawal must resolve
// through the normal release/dispute path first — cancellation
// won't silently override an in-flight payment decision.
// -------------------------------------------------------
bookings.post('/:id/cancel/:cancellationId/confirm', async (c) => {
  const bookingId       = c.req.param('id')
  const cancellationId  = c.req.param('cancellationId')
  const userId          = c.get('userId')
  const supabase        = getSupabase(c.env)

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, client_id, provider_id, status')
    .eq('id', bookingId)
    .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
    .single()

  if (!booking) {
    return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
  }

  const { data: cancellation } = await supabase
    .from('cancellation_requests')
    .select('*')
    .eq('id', cancellationId)
    .eq('booking_id', bookingId)
    .eq('status', 'pending')
    .single()

  if (!cancellation) {
    return c.json({ success: false, error: 'Cancellation request not found or already resolved', code: 'NOT_FOUND' }, 404)
  }

  const confirmerRole = userId === booking.client_id ? 'client' : 'provider'
  if (confirmerRole === cancellation.requested_by) {
    return c.json({ success: false, error: 'Cannot confirm your own cancellation request', code: 'INVALID_ACTION' }, 400)
  }

  const { data: milestones } = await supabase
    .from('milestones')
    .select('id, sequence, status, amount')
    .eq('booking_id', bookingId)

  const blocking = (milestones ?? []).filter(m =>
    ['evidence_submitted', 'withdrawal_requested'].includes(m.status)
  )

  if (blocking.length) {
    return c.json({
      success: false,
      error: `Milestone ${blocking[0].sequence} has a payment decision in progress — resolve it (release or dispute) before cancellation can finalize.`,
      code: 'MILESTONE_PAYMENT_PENDING',
    }, 409)
  }

  // Refund any milestone that's funded but work hasn't reached the evidence stage yet.
  const toRefund = (milestones ?? []).filter(m => ['funded', 'in_progress'].includes(m.status))

  for (const m of toRefund) {
    await supabase.from('wallet_transactions').insert({
      booking_id: bookingId,
      milestone_id: m.id,
      amount: m.amount,
      transaction_type: 'refund',
      description: `Refund — milestone ${m.sequence} cancelled before work began`,
    })
  }

  await supabase.from('cancellation_requests').update({
    status: 'confirmed',
    resolved_at: new Date().toISOString(),
  }).eq('id', cancellationId)

  await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId)

  const notifyId = cancellation.requested_by === 'client' ? booking.provider_id : booking.client_id
  await supabase.from('notifications').insert({
    user_id: notifyId,
    type:    'cancellation_confirmed',
    title:   'Project cancelled',
    body:    toRefund.length
      ? `The other party confirmed. ${toRefund.length} unfunded milestone(s) were refunded.`
      : 'The other party confirmed. The project has been cancelled.',
    data:    { booking_id: bookingId },
    is_read: false,
  })

  return c.json({
    success: true,
    data: { status: 'cancelled', refunded_milestones: toRefund.map(m => m.id) }
  })
})

// -------------------------------------------------------
// POST /bookings/:id/cancel/:cancellationId/dispute
// The other party objects — raises a project-level dispute
// instead of silently finalizing. Admin must arbitrate.
// -------------------------------------------------------
bookings.post('/:id/cancel/:cancellationId/dispute',
  zValidator('json', z.object({
    reason: z.string().min(10).max(1000),
  })),
  async (c) => {
    const bookingId      = c.req.param('id')
    const cancellationId = c.req.param('cancellationId')
    const userId         = c.get('userId')
    const body           = c.req.valid('json')
    const supabase       = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    const { data: cancellation } = await supabase
      .from('cancellation_requests')
      .select('*')
      .eq('id', cancellationId)
      .eq('booking_id', bookingId)
      .eq('status', 'pending')
      .single()

    if (!cancellation) {
      return c.json({ success: false, error: 'Cancellation request not found or already resolved', code: 'NOT_FOUND' }, 404)
    }

    const disputerRole = userId === booking.client_id ? 'client' : 'provider'

    await supabase.from('cancellation_requests').update({
      status: 'disputed',
      resolved_at: new Date().toISOString(),
    }).eq('id', cancellationId)

    await supabase.from('disputes').insert({
      booking_id: bookingId,
      milestone_id: null,
      raised_by: disputerRole,
      reason: body.reason,
      denial_reason: null,
      evidence_urls: [],
      status: 'open',
      bot_confidence: null,
      admin_override: false,
      false_dispute_penalty_applied: false,
    })

    await supabase.from('bookings').update({ status: 'disputed' }).eq('id', bookingId)

    return c.json({
      success: true,
      data: { message: 'Cancellation disputed. Admin will review and arbitrate.' }
    })
  }
)

// -------------------------------------------------------
// POST /bookings/:id/cancel/:cancellationId/withdraw
// The requester changes their mind before the other party responds.
// -------------------------------------------------------
bookings.post('/:id/cancel/:cancellationId/withdraw', async (c) => {
  const bookingId      = c.req.param('id')
  const cancellationId = c.req.param('cancellationId')
  const userId         = c.get('userId')
  const supabase       = getSupabase(c.env)

  const { data: cancellation } = await supabase
    .from('cancellation_requests')
    .select('*, bookings!inner(client_id, provider_id)')
    .eq('id', cancellationId)
    .eq('booking_id', bookingId)
    .eq('status', 'pending')
    .single()

  if (!cancellation) {
    return c.json({ success: false, error: 'Cancellation request not found or already resolved', code: 'NOT_FOUND' }, 404)
  }

  const requesterRole = userId === (cancellation as any).bookings.client_id ? 'client' : 'provider'
  if (requesterRole !== cancellation.requested_by) {
    return c.json({ success: false, error: 'Only the original requester can withdraw this request', code: 'INVALID_ACTION' }, 403)
  }

  await supabase.from('cancellation_requests').update({
    status: 'withdrawn',
    resolved_at: new Date().toISOString(),
  }).eq('id', cancellationId)

  await supabase.from('bookings').update({ status: 'in_progress' }).eq('id', bookingId)

  return c.json({ success: true, data: { message: 'Cancellation request withdrawn. Project continues.' } })
})

// -------------------------------------------------------
// POST /bookings/:id/messages
// Three-way thread — client, provider, AND guarantor all post and
// read from the same conversation. Authorization checks all three
// possible identities since they map to different id columns.
// -------------------------------------------------------
bookings.post('/:id/messages',
  zValidator('json', z.object({
    body: z.string().min(1).max(2000),
  })),
  async (c) => {
    const bookingId = c.req.param('id')
    const userId    = c.get('userId')
    const body      = c.req.valid('json')
    const supabase  = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, booking_route, providers(user_id)')
      .eq('id', bookingId)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }
    if (booking.booking_route !== 'route_2') {
      return c.json({ success: false, error: 'Group threads are only available for guaranteed projects', code: 'INVALID_ROUTE' }, 400)
    }

    const { data: guarantor } = await supabase
      .from('guarantors').select('user_id').eq('booking_id', bookingId).single()

    const providerUserId = (booking as any).providers?.user_id
    let senderRole: 'client' | 'provider' | 'guarantor' | null = null
    if (userId === booking.client_id) senderRole = 'client'
    else if (userId === providerUserId) senderRole = 'provider'
    else if (guarantor && userId === guarantor.user_id) senderRole = 'guarantor'

    if (!senderRole) {
      return c.json({ success: false, error: 'You are not part of this project thread', code: 'FORBIDDEN' }, 403)
    }

    const { data: message, error } = await supabase
      .from('project_messages')
      .insert({
        booking_id: bookingId,
        sender_id: userId,
        sender_role: senderRole,
        body: body.body,
        is_system: false,
      })
      .select()
      .single()

    if (error || !message) {
      return c.json({ success: false, error: 'Could not send message', code: 'DB_ERROR' }, 500)
    }

    // Notify the other two participants
    const recipients = [booking.client_id, providerUserId, guarantor?.user_id]
      .filter((id): id is string => !!id && id !== userId)

    if (recipients.length) {
      await supabase.from('notifications').insert(
        recipients.map(id => ({
          user_id: id,
          type: 'project_message',
          title: `New message from ${senderRole}`,
          body: body.body.slice(0, 120),
          data: { booking_id: bookingId, message_id: message.id },
          is_read: false,
        }))
      )
    }

    return c.json({ success: true, data: message }, 201)
  }
)

// -------------------------------------------------------
// GET /bookings/:id/messages
// -------------------------------------------------------
bookings.get('/:id/messages', async (c) => {
  const bookingId = c.req.param('id')
  const userId    = c.get('userId')
  const supabase  = getSupabase(c.env)

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, client_id, providers(user_id)')
    .eq('id', bookingId)
    .single()

  if (!booking) {
    return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
  }

  const { data: guarantor } = await supabase
    .from('guarantors').select('user_id').eq('booking_id', bookingId).single()

  const providerUserId = (booking as any).providers?.user_id
  const isParticipant = userId === booking.client_id || userId === providerUserId || (guarantor && userId === guarantor.user_id)

  if (!isParticipant) {
    return c.json({ success: false, error: 'You are not part of this project thread', code: 'FORBIDDEN' }, 403)
  }

  const { data: messages } = await supabase
    .from('project_messages')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true })

  return c.json({ success: true, data: messages ?? [] })
})

// -------------------------------------------------------
// GET /bookings/:id/milestones
// Surfaces is_overdue per milestone so the client app doesn't have
// to recompute the due-date logic itself.
// -------------------------------------------------------
bookings.get('/:id/milestones', async (c) => {
  const bookingId = c.req.param('id')
  const userId    = c.get('userId')
  const supabase  = getSupabase(c.env)

  const { data: booking } = await supabase
    .from('bookings')
    .select('id')
    .eq('id', bookingId)
    .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
    .single()

  if (!booking) {
    return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
  }

  const { data: milestones } = await supabase
    .from('milestones')
    .select('*')
    .eq('booking_id', bookingId)
    .order('sequence', { ascending: true })

  const withOverdue = (milestones ?? []).map(m => ({
    ...m,
    is_overdue: isMilestoneOverdue(m.due_date, m.status),
  }))

  return c.json({ success: true, data: withOverdue })
})

// -------------------------------------------------------
// POST /bookings/:id/milestones/:milestoneId/request-extension
// Provider (usually) requests more time on a due_date. Lighter than
// a change order — no money moves, just a date, but still needs
// the other party's consent so deadlines can't be silently ignored.
// -------------------------------------------------------
bookings.post('/:id/milestones/:milestoneId/request-extension',
  zValidator('json', z.object({
    new_due_date: z.string().datetime(),
    reason: z.string().min(5).max(500),
  })),
  async (c) => {
    const bookingId    = c.req.param('id')
    const milestoneId  = c.req.param('milestoneId')
    const userId       = c.get('userId')
    const body         = c.req.valid('json')
    const supabase     = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id, booking_route')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }
    if (booking.booking_route !== 'route_2') {
      return c.json({ success: false, error: 'Only guaranteed projects have milestone due dates', code: 'INVALID_ROUTE' }, 400)
    }

    const { data: milestone } = await supabase
      .from('milestones')
      .select('id, due_date, sequence')
      .eq('id', milestoneId)
      .eq('booking_id', bookingId)
      .single()

    if (!milestone) {
      return c.json({ success: false, error: 'Milestone not found', code: 'NOT_FOUND' }, 404)
    }

    const requestedBy = userId === booking.client_id ? 'client' : 'provider'
    const recipientId = requestedBy === 'client' ? booking.provider_id : booking.client_id

    const { data: extension, error } = await supabase
      .from('milestone_extension_requests')
      .insert({
        milestone_id: milestoneId,
        booking_id: bookingId,
        requested_by: requestedBy,
        current_due_date: milestone.due_date,
        new_due_date: body.new_due_date,
        reason: body.reason,
        status: 'pending',
      })
      .select()
      .single()

    if (error || !extension) {
      return c.json({ success: false, error: 'Could not create extension request', code: 'DB_ERROR' }, 500)
    }

    await supabase.from('notifications').insert({
      user_id: recipientId,
      type:    'extension_requested',
      title:   'More time requested',
      body:    `${requestedBy === 'provider' ? 'Osei' : 'Your client'} requested an extension on milestone ${milestone.sequence}.`,
      data:    { booking_id: bookingId, milestone_id: milestoneId, extension_id: extension.id },
      is_read: false,
    })

    return c.json({ success: true, data: extension }, 201)
  }
)

// -------------------------------------------------------
// POST /bookings/:id/milestones/:milestoneId/extension/:extensionId/respond
// -------------------------------------------------------
bookings.post('/:id/milestones/:milestoneId/extension/:extensionId/respond',
  zValidator('json', z.object({
    decision: z.enum(['approved', 'rejected']),
  })),
  async (c) => {
    const bookingId    = c.req.param('id')
    const milestoneId  = c.req.param('milestoneId')
    const extensionId  = c.req.param('extensionId')
    const userId       = c.get('userId')
    const body         = c.req.valid('json')
    const supabase     = getSupabase(c.env)

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, client_id, provider_id')
      .eq('id', bookingId)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    const { data: extension } = await supabase
      .from('milestone_extension_requests')
      .select('*')
      .eq('id', extensionId)
      .eq('milestone_id', milestoneId)
      .eq('status', 'pending')
      .single()

    if (!extension) {
      return c.json({ success: false, error: 'Extension request not found or already resolved', code: 'NOT_FOUND' }, 404)
    }

    const responderRole = userId === booking.client_id ? 'client' : 'provider'
    if (responderRole === extension.requested_by) {
      return c.json({ success: false, error: 'Cannot respond to your own extension request', code: 'INVALID_ACTION' }, 400)
    }

    await supabase.from('milestone_extension_requests').update({
      status: body.decision,
      resolved_at: new Date().toISOString(),
    }).eq('id', extensionId)

    if (body.decision === 'approved') {
      await supabase.from('milestones').update({
        due_date: extension.new_due_date,
      }).eq('id', milestoneId)
    }

    const notifyId = extension.requested_by === 'client' ? booking.provider_id : booking.client_id
    await supabase.from('notifications').insert({
      user_id: notifyId,
      type:    'extension_resolved',
      title:   body.decision === 'approved' ? 'Extension approved' : 'Extension declined',
      body:    body.decision === 'approved'
        ? `New due date set to ${new Date(extension.new_due_date).toLocaleDateString()}.`
        : 'Your extension request was declined.',
      data:    { booking_id: bookingId, milestone_id: milestoneId },
      is_read: false,
    })

    return c.json({ success: true, data: { status: body.decision } })
  }
)

export { bookings as bookingRoutes }
