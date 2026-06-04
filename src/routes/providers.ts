import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { Env } from '../types'

const providers = new Hono<{ Bindings: Env }>()

// All provider routes require authentication
providers.use('*', requireAuth)

// -------------------------------------------------------
// GET /providers/me
// Get current provider profile + verification status
// -------------------------------------------------------
providers.get('/me', async (c) => {
  const userId = c.get('userId')
  const supabase = getSupabase(c.env)

  const { data: provider, error } = await supabase
    .from('providers')
    .select(`
      *,
      provider_services (
        service_id,
        services (id, name, category)
      ),
      provider_badges (badge_type, earned_at)
    `)
    .eq('user_id', userId)
    .single()

  if (error || !provider) {
    return c.json({ success: false, error: 'Provider profile not found', code: 'NOT_FOUND' }, 404)
  }

  return c.json({ success: true, data: provider })
})

// -------------------------------------------------------
// POST /providers/onboard/start
// Step 1: Create provider profile (name + bio)
// -------------------------------------------------------
providers.post(
  '/onboard/start',
  zValidator('json', z.object({
    full_name: z.string().min(2).max(100),
    business_name: z.string().max(100).optional(),
    bio: z.string().max(500).optional(),
  })),
  async (c) => {
    const userId = c.get('userId')
    const { full_name, business_name, bio } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Update user's full name
    await supabase
      .from('users')
      .update({ full_name })
      .eq('id', userId)

    // Create provider record (starts at step: id_upload)
    const { data: provider, error } = await supabase
      .from('providers')
      .upsert({
        user_id: userId,
        business_name: business_name ?? null,
        bio: bio ?? null,
        verification_step: 'id_upload',
        is_verified: false,
        is_live: false,
        starter_lock_until: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single()

    if (error) {
      return c.json({ success: false, error: 'Could not create provider profile', code: 'DB_ERROR' }, 500)
    }

    // Update user role to provider
    await supabase
      .from('users')
      .update({ role: 'provider' })
      .eq('id', userId)

    return c.json({
      success: true,
      data: {
        provider_id: provider.id,
        next_step: 'id_upload',
        message: 'Profile created. Next: upload your Ghana Card or Passport.'
      }
    })
  }
)

// -------------------------------------------------------
// POST /providers/onboard/id-upload
// Step 2: Upload national ID (Ghana Card, Passport, Voter ID)
// Returns a signed upload URL for Supabase Storage
// -------------------------------------------------------
providers.post(
  '/onboard/id-upload',
  zValidator('json', z.object({
    file_name: z.string(),
    file_type: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
    id_type: z.enum(['ghana_card', 'passport', 'voter_id', 'drivers_license']),
  })),
  async (c) => {
    const userId = c.get('userId')
    const { file_name, file_type, id_type } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Generate signed upload URL for private provider-ids bucket
    const filePath = `${userId}/${id_type}_${Date.now()}_${file_name}`
    const { data, error } = await supabase.storage
      .from('provider-ids')
      .createSignedUploadUrl(filePath)

    if (error || !data) {
      return c.json({ success: false, error: 'Could not generate upload URL', code: 'STORAGE_ERROR' }, 500)
    }

    // Mark step as in progress
    await supabase
      .from('providers')
      .update({ verification_step: 'face_match' })
      .eq('user_id', userId)

    return c.json({
      success: true,
      data: {
        upload_url: data.signedUrl,
        file_path: filePath,
        next_step: 'face_match',
        message: 'ID upload URL ready. After upload, proceed to face match.'
      }
    })
  }
)

// -------------------------------------------------------
// POST /providers/onboard/services
// Step 5: Select services offered
// -------------------------------------------------------
providers.post(
  '/onboard/services',
  zValidator('json', z.object({
    service_ids: z.array(z.string().uuid()).min(1).max(20),
  })),
  async (c) => {
    const userId = c.get('userId')
    const { service_ids } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Get provider record
    const { data: provider } = await supabase
      .from('providers')
      .select('id')
      .eq('user_id', userId)
      .single()

    if (!provider) {
      return c.json({ success: false, error: 'Start onboarding first', code: 'NOT_FOUND' }, 404)
    }

    // Remove old selections, insert new ones
    await supabase
      .from('provider_services')
      .delete()
      .eq('provider_id', provider.id)

    const inserts = service_ids.map(service_id => ({
      provider_id: provider.id,
      service_id,
    }))

    const { error } = await supabase
      .from('provider_services')
      .insert(inserts)

    if (error) {
      return c.json({ success: false, error: 'Could not save services', code: 'DB_ERROR' }, 500)
    }

    await supabase
      .from('providers')
      .update({ verification_step: 'portfolio' })
      .eq('user_id', userId)

    return c.json({
      success: true,
      data: {
        services_saved: service_ids.length,
        next_step: 'portfolio',
        message: 'Services saved. Next: add portfolio photos.'
      }
    })
  }
)

// -------------------------------------------------------
// POST /providers/onboard/pricing
// Step 7: Set pricing cards (price menu)
// -------------------------------------------------------
providers.post(
  '/onboard/pricing',
  zValidator('json', z.object({
    pricing: z.array(z.object({
      service_id: z.string().uuid(),
      price_from: z.number().int().positive(),   // in pesewas
      price_to: z.number().int().positive().optional(),
      price_unit: z.enum(['fixed', 'per_hour', 'per_day', 'negotiable']),
      description: z.string().max(200).optional(),
    })).min(1),
  })),
  async (c) => {
    const userId = c.get('userId')
    const { pricing } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    const { data: provider } = await supabase
      .from('providers')
      .select('id')
      .eq('user_id', userId)
      .single()

    if (!provider) {
      return c.json({ success: false, error: 'Provider profile not found', code: 'NOT_FOUND' }, 404)
    }

    // Update pricing on each provider_service record
    for (const item of pricing) {
      await supabase
        .from('provider_services')
        .update({
          price_from: item.price_from,
          price_to: item.price_to ?? null,
          price_unit: item.price_unit,
          price_description: item.description ?? null,
        })
        .eq('provider_id', provider.id)
        .eq('service_id', item.service_id)
    }

    // All 7 steps complete — go LIVE
    const { error } = await supabase
      .from('providers')
      .update({
        verification_step: 'pricing',
        is_verified: true,
        is_live: true,
      })
      .eq('user_id', userId)

    if (error) {
      return c.json({ success: false, error: 'Could not activate profile', code: 'DB_ERROR' }, 500)
    }

    return c.json({
      success: true,
      data: {
        message: '🎉 Your Taska profile is now LIVE! Note: you cannot receive payments for 14 days (starter lock period).',
        is_live: true,
        starter_lock_active: true,
      }
    })
  }
)

// -------------------------------------------------------
// GET /providers/search
// Public search — no auth required (removed requireAuth for this route)
// -------------------------------------------------------
providers.get('/search', async (c) => {
  const supabase = getSupabase(c.env)

  const query = c.req.query('q') ?? ''
  const lat = parseFloat(c.req.query('lat') ?? '0')
  const lng = parseFloat(c.req.query('lng') ?? '0')
  const radius = parseInt(c.req.query('radius') ?? '5000')  // metres, default 5km
  const minRating = parseFloat(c.req.query('min_rating') ?? '0')

  let dbQuery = supabase
    .from('providers')
    .select(`
      id,
      business_name,
      bio,
      rating_average,
      jobs_completed,
      response_time_minutes,
      subscription_tier,
      users!inner (full_name, country_code),
      provider_services (
        price_from, price_to, price_unit,
        services (name, category)
      ),
      provider_badges (badge_type)
    `)
    .eq('is_live', true)
    .eq('is_verified', true)
    .gte('rating_average', minRating)
    .order('rating_average', { ascending: false })
    .limit(20)

  const { data: results, error } = await dbQuery

  if (error) {
    return c.json({ success: false, error: 'Search failed', code: 'DB_ERROR' }, 500)
  }

  return c.json({
    success: true,
    data: {
      results: results ?? [],
      count: results?.length ?? 0,
    }
  })
})

export { providers as providerRoutes }
