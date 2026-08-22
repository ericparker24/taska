/**
 * src/routes/push.ts
 * Web Push subscription management.
 * The actual push sending is handled by Supabase database triggers
 * calling the send-push Edge Function — this route just stores
 * and removes device subscriptions.
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { Env } from '../types'

const push = new Hono<{ Bindings: Env }>()

// -------------------------------------------------------
// GET /push/vapid-public-key
// Frontend fetches this before calling PushManager.subscribe()
// -------------------------------------------------------
push.get('/vapid-public-key', (c) => {
  return c.json({
    success: true,
    data: { publicKey: c.env.VAPID_PUBLIC_KEY },
  })
})

// -------------------------------------------------------
// POST /push/subscribe
// Store device subscription — upserts on endpoint so
// re-subscribing on the same device just refreshes the keys.
// -------------------------------------------------------
push.post(
  '/subscribe',
  requireAuth,
  zValidator('json', z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth:   z.string(),
    }),
  })),
  async (c) => {
    const userId    = c.get('userId')
    const { endpoint, keys } = c.req.valid('json')
    const supabase  = getSupabase(c.env)
    const userAgent = c.req.header('User-Agent') ?? null

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        user_id:      userId,
        endpoint,
        p256dh:       keys.p256dh,
        auth:         keys.auth,
        user_agent:   userAgent,
        last_used_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' })

    if (error) {
      return c.json({ success: false, error: 'Could not save subscription', code: 'DB_ERROR' }, 500)
    }

    return c.json({ success: true, data: { message: 'Subscribed' } }, 201)
  }
)

// -------------------------------------------------------
// DELETE /push/unsubscribe
// Remove all subscriptions for this user (all devices).
// Call on logout.
// -------------------------------------------------------
push.delete('/unsubscribe', requireAuth, async (c) => {
  const userId   = c.get('userId')
  const supabase = getSupabase(c.env)

  await supabase.from('push_subscriptions').delete().eq('user_id', userId)

  return c.json({ success: true, data: { message: 'Unsubscribed from all devices' } })
})

// -------------------------------------------------------
// DELETE /push/unsubscribe-device
// Remove a single device subscription by endpoint.
// Call when the browser fires pushsubscriptionchange.
// -------------------------------------------------------
push.delete(
  '/unsubscribe-device',
  requireAuth,
  zValidator('json', z.object({ endpoint: z.string().url() })),
  async (c) => {
    const userId          = c.get('userId')
    const { endpoint }    = c.req.valid('json')
    const supabase        = getSupabase(c.env)

    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', endpoint)

    return c.json({ success: true, data: { message: 'Device unsubscribed' } })
  }
)

export { push as pushRoutes }
