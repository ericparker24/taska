import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { isGuarantorReady } from '../lib/pricing'
import type { Env } from '../types'

const payments = new Hono<{ Bindings: Env }>()
payments.use('*', requireAuth)

// -------------------------------------------------------
// POST /payments/initiate
// Primary: PawaPay → auto-failover to Flutterwave
// Invisible to user — they just see "Pay GHS X"
// -------------------------------------------------------
payments.post(
  '/initiate',
  zValidator('json', z.object({
    booking_id: z.string().uuid(),
    milestone_id: z.string().uuid().optional(),  // Route 2 rolling escrow — fund one milestone at a time
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    amount: z.number().int().positive(),  // in pesewas
    payment_type: z.enum(['escrow_deposit', 'labour_release', 'guarantor_fee']),
  })),
  async (c) => {
    const userId = c.get('userId')
    const { booking_id, milestone_id, phone, amount, payment_type } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Verify booking belongs to user
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, status, total_amount, booking_route')
      .eq('id', booking_id)
      .eq('client_id', userId)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    // Guarantor gate — Route 2 is compulsory-guarantor. No milestone can be
    // funded until the nominated guarantor has accepted the role, regardless
    // of what the client app's UI allows — this is the server-side backstop.
    if (booking.booking_route === 'route_2') {
      const { data: guarantor } = await supabase
        .from('guarantors')
        .select('status')
        .eq('booking_id', booking_id)
        .single()

      if (!guarantor || !isGuarantorReady(guarantor.status)) {
        return c.json({
          success: false,
          error: 'Your nominated guarantor must accept their role before you can fund this project.',
          code: 'GUARANTOR_NOT_READY',
        }, 409)
      }
    }

    if (milestone_id) {
      const { data: milestone } = await supabase
        .from('milestones')
        .select('id, status, amount')
        .eq('id', milestone_id)
        .eq('booking_id', booking_id)
        .single()

      if (!milestone) {
        return c.json({ success: false, error: 'Milestone not found', code: 'NOT_FOUND' }, 404)
      }
      if (milestone.status !== 'pending') {
        return c.json({ success: false, error: 'Milestone is not awaiting funding', code: 'INVALID_STATUS' }, 400)
      }
    }

    // Create pending payment record
    const depositId = crypto.randomUUID()
    const { error: paymentError } = await supabase
      .from('payments')
      .insert({
        id: depositId,
        booking_id,
        milestone_id: milestone_id ?? null,
        amount,
        payment_type,
        processor: 'pawapay',   // will update if failover
        status: 'pending',
        phone,
      })

    if (paymentError) {
      return c.json({ success: false, error: 'Could not initiate payment', code: 'DB_ERROR' }, 500)
    }

    // Try PawaPay first
    const pawaResult = await initiatePawaPay({
      depositId,
      phone,
      amount,
      env: c.env,
    })

    if (pawaResult.success) {
      return c.json({
        success: true,
        data: {
          payment_id: depositId,
          processor: 'pawapay',
          status: 'pending',
          message: 'Check your phone for a MoMo prompt',
          instructions: pawaResult.instructions,
        }
      })
    }

    // PawaPay failed → try Flutterwave
    console.warn('PawaPay failed, failing over to Flutterwave:', pawaResult.error)

    const flwResult = await initiateFlutterwave({
      paymentId: depositId,
      phone,
      amount,
      bookingId: booking_id,
      env: c.env,
    })

    if (flwResult.success) {
      // Update payment record to reflect failover
      await supabase
        .from('payments')
        .update({ processor: 'flutterwave', processor_transaction_id: flwResult.txRef })
        .eq('id', depositId)

      return c.json({
        success: true,
        data: {
          payment_id: depositId,
          processor: 'flutterwave',
          status: 'pending',
          message: 'Check your phone for a payment prompt',
          payment_link: flwResult.paymentLink,
        }
      })
    }

    // Both failed
    await supabase
      .from('payments')
      .update({ status: 'failed' })
      .eq('id', depositId)

    return c.json({
      success: false,
      error: 'Payment could not be processed. Please try again.',
      code: 'PAYMENT_FAILED'
    }, 502)
  }
)

// -------------------------------------------------------
// POST /payments/webhook/pawapay
// PawaPay webhook — payment confirmed or failed
// -------------------------------------------------------
payments.post('/webhook/pawapay', async (c) => {
  const supabase = getSupabase(c.env)
  const body = await c.req.json()

  const { depositId, status } = body

  if (!depositId || !status) {
    return c.json({ received: true }, 200)
  }

  const paymentStatus = status === 'COMPLETED' ? 'completed' : 'failed'

  const { data: payment } = await supabase
    .from('payments')
    .update({
      status: paymentStatus,
      processor_transaction_id: body.financialTransactionId ?? null,
    })
    .eq('id', depositId)
    .select()
    .single()

  if (payment && paymentStatus === 'completed') {
    await handlePaymentSuccess(payment.booking_id, payment.payment_type, payment.amount, supabase, payment.milestone_id)
  }

  return c.json({ received: true }, 200)
})

// -------------------------------------------------------
// POST /payments/webhook/flutterwave
// Flutterwave webhook — payment confirmed
// -------------------------------------------------------
payments.post('/webhook/flutterwave', async (c) => {
  const supabase = getSupabase(c.env)

  // Verify Flutterwave signature
  const signature = c.req.header('verif-hash')
  if (signature !== c.env.FLUTTERWAVE_SECRET_KEY) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  const body = await c.req.json()
  const { data: { tx_ref, status } } = body

  if (status !== 'successful') {
    return c.json({ received: true }, 200)
  }

  const { data: payment } = await supabase
    .from('payments')
    .update({
      status: 'completed',
      processor_transaction_id: tx_ref,
    })
    .eq('id', tx_ref)
    .select()
    .single()

  if (payment) {
    await handlePaymentSuccess(payment.booking_id, payment.payment_type, payment.amount, supabase, payment.milestone_id)
  }

  return c.json({ received: true }, 200)
})

// -------------------------------------------------------
// Internal: PawaPay initiation
// -------------------------------------------------------
async function initiatePawaPay({ depositId, phone, amount, env }: {
  depositId: string
  phone: string
  amount: number
  env: Env
}) {
  try {
    const response = await fetch('https://api.pawapay.io/deposits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.PAWAPAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        depositId,
        amount: (amount / 100).toFixed(2),  // convert pesewas to GHS
        currency: 'GHS',
        correspondent: env.PAWAPAY_CORRESPONDENT_ID,  // MTN_MOMO_GHA
        payer: { type: 'MSISDN', address: { value: phone.replace('+', '') } },
        customerTimestamp: new Date().toISOString(),
        statementDescription: 'Taska Payment',
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return { success: false as const, error: err }
    }

    return {
      success: true as const,
      instructions: 'A MoMo prompt has been sent to your phone. Approve to confirm.',
    }
  } catch (e) {
    return { success: false as const, error: String(e) }
  }
}

// -------------------------------------------------------
// Internal: Flutterwave initiation (failover)
// -------------------------------------------------------
async function initiateFlutterwave({ paymentId, phone, amount, bookingId, env }: {
  paymentId: string
  phone: string
  amount: number
  bookingId: string
  env: Env
}) {
  try {
    const response = await fetch('https://api.flutterwave.com/v3/charges?type=mobile_money_ghana', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: paymentId,
        amount: (amount / 100).toFixed(2),
        currency: 'GHS',
        network: 'MTN',
        email: `${phone}@taska.africa`,  // Flutterwave requires email
        phone_number: phone.replace('+', ''),
        fullname: 'Taska User',
        meta: { booking_id: bookingId },
      }),
    })

    const data = await response.json() as any

    if (data.status !== 'success') {
      return { success: false as const, error: data.message }
    }

    return {
      success: true as const,
      txRef: paymentId,
      paymentLink: data.meta?.authorization?.redirect ?? null,
    }
  } catch (e) {
    return { success: false as const, error: String(e) }
  }
}

// -------------------------------------------------------
// Internal: Handle successful payment
// Updates booking status and notifies parties
// -------------------------------------------------------
async function handlePaymentSuccess(
  bookingId: string,
  paymentType: string,
  amount: number,
  supabase: ReturnType<typeof import('../lib/supabase').getSupabase>,
  milestoneId?: string | null
) {
  if (paymentType === 'escrow_deposit') {
    const { data: booking } = await supabase
      .from('bookings')
      .select('provider_id, client_id, status')
      .eq('id', bookingId)
      .single()

    if (milestoneId) {
      // Route 2 rolling escrow — fund this milestone only.
      await supabase.from('milestones').update({
        status: 'funded',
        funded_at: new Date().toISOString(),
      }).eq('id', milestoneId)
    }

    // Move the booking itself to in_progress once at least one milestone is funded
    // (idempotent — harmless if it's already in_progress for a later milestone).
    if (booking?.status === 'pending' || booking?.status === 'accepted') {
      await supabase.from('bookings').update({ status: 'in_progress' }).eq('id', bookingId)
    }

    if (booking) {
      await supabase.from('notifications').insert([
        {
          user_id: booking.provider_id,
          type: 'payment_received',
          title: 'Payment confirmed!',
          body: milestoneId
            ? 'Client has funded this milestone. You can start this stage of the project.'
            : 'Client has paid. You can now start the job.',
          data: { booking_id: bookingId, milestone_id: milestoneId ?? null },
          is_read: false,
        },
        {
          user_id: booking.client_id,
          type: 'payment_confirmed',
          title: 'Payment successful',
          body: 'Your payment is held in escrow. Work can now begin.',
          data: { booking_id: bookingId, milestone_id: milestoneId ?? null },
          is_read: false,
        }
      ])
    }
  }
}

export { payments as paymentRoutes }
