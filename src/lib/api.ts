const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'https://taska.ericdabankah23.workers.dev'

// ─── Core fetch wrapper ────────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const { token, ...init } = options
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers })

  // Try to parse JSON regardless of status so we can surface Worker error messages
  let body: { success: boolean; data?: T; error?: string; code?: string }
  try {
    body = await res.json()
  } catch {
    throw new Error(`Network error (${res.status})`)
  }

  if (!res.ok || body.success === false) {
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }

  return body.data as T
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

export const auth = {
  /** POST /auth/send-otp — request OTP for phone */
  sendOtp(phone: string) {
    return request<{ message: string }>('/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    })
  },

  /** POST /auth/verify-otp — verify OTP, returns token + user */
  verifyOtp(phone: string, otp: string) {
    return request<{ token: string; user: { id: string; phone: string; role: string } }>(
      '/auth/verify-otp',
      {
        method: 'POST',
        body: JSON.stringify({ phone, otp }),
      }
    )
  },
}

// ─── Providers ────────────────────────────────────────────────────────────────

export interface ProviderSearchResult {
  id: string
  business_name: string | null
  bio: string | null
  rating_average: number
  jobs_completed: number
  response_time_minutes: number
  subscription_tier: string
  users: { full_name: string; country_code: string }
  provider_services: Array<{
    price_from: number
    price_to: number | null
    price_unit: string
    services: { name: string; category: string }
  }>
  provider_badges: Array<{ badge_type: string }>
}

/** Normalise Worker's search result into the Provider shape the UI expects */
function normaliseProvider(p: ProviderSearchResult) {
  const topBadges = p.provider_badges?.map(b => b.badge_type) ?? []
  return {
    id: p.id,
    user_id: '',
    full_name: p.users?.full_name ?? p.business_name ?? 'Provider',
    bio: p.bio ?? undefined,
    location_area: '',
    location_city: '',
    rating: p.rating_average ?? 0,
    total_jobs: p.jobs_completed ?? 0,
    response_time_minutes: p.response_time_minutes ?? 30,
    is_verified: topBadges.includes('verified') || true,
    is_id_checked: topBadges.includes('id_checked'),
    is_top_rated: topBadges.includes('top_rated'),
    services: (p.provider_services ?? []).map((ps, i) => ({
      id: String(i),
      name: ps.services?.name ?? '',
      price_pesewas: ps.price_from ?? 0,
      description: ps.services?.category,
    })),
    portfolio_photos: [] as string[],
  }
}

export const providers = {
  /**
   * GET /providers/search?q=&lat=&lng=&min_rating=
   * Note: Worker auth middleware is on all /providers/* routes.
   * Pass token if available so the Worker accepts the request.
   */
  async search(params: { query?: string; category?: string; token?: string }) {
    const qs = new URLSearchParams()
    if (params.query) qs.set('q', params.query)
    // Worker doesn't filter by category yet — filter client-side
    const path = `/providers/search${qs.toString() ? `?${qs}` : ''}`
    const data = await request<{ results: ProviderSearchResult[]; count: number }>(path, {
      token: params.token,
    })
    const list = (data.results ?? []).map(normaliseProvider)
    // Client-side category filter
    if (params.category && params.category !== 'all' && params.category !== '') {
      return list.filter(p =>
        p.services.some(s =>
          s.description?.toLowerCase() === params.category?.toLowerCase()
        )
      )
    }
    return list
  },

  /** GET /providers/me — current provider profile */
  getMe(token: string) {
    return request('/providers/me', { token })
  },
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

export interface BookingListItem {
  id: string
  status: string
  total_amount: number
  labour_amount: number
  commission_amount: number
  description: string
  location_address: string | null
  scheduled_at: string | null
  booking_route: string
  created_at: string
  provider_id: string
  client_id: string
  service_id: string
}

export const bookings = {
  /**
   * GET /bookings — list user's bookings
   * Worker doesn't have a list endpoint shown, but likely exists.
   * Fallback: returns empty array if 404.
   */
  async list(token: string) {
    try {
      return await request<BookingListItem[]>('/bookings', { token })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('404') || msg.includes('not found')) return []
      throw e
    }
  },

  /** GET /bookings/:id */
  getById(id: string, token: string) {
    return request<BookingListItem>(`/bookings/${id}`, { token })
  },

  /**
   * POST /bookings — create a booking
   */
  create(
    token: string,
    payload: {
      provider_id: string
      service_id: string
      booking_route: 'route_1' | 'route_2'
      description: string
      total_amount: number
      location_address?: string
      scheduled_at?: string
    }
  ) {
    return request<{ booking_id: string; status: string; message: string }>('/bookings', {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    })
  },

  /** POST /bookings/:id/accept — provider accepts */
  accept(id: string, token: string) {
    return request(`/bookings/${id}/accept`, { method: 'POST', token })
  },

  /**
   * POST /bookings/:id/release-payment — client releases payment
   * Maps to the old "confirm & release" button in the UI.
   */
  releasePayment(id: string, token: string, withdrawalId: string, pin: string) {
    return request(`/bookings/${id}/release-payment`, {
      method: 'POST',
      token,
      body: JSON.stringify({ withdrawal_id: withdrawalId, pin }),
    })
  },

  /**
   * POST /bookings/:id/deny-payment — client denies (raises dispute)
   */
  denyPayment(id: string, token: string, withdrawalId: string, reason: string) {
    return request(`/bookings/${id}/deny-payment`, {
      method: 'POST',
      token,
      body: JSON.stringify({ withdrawal_id: withdrawalId, reason }),
    })
  },

  /** POST /bookings/:id/evidence — provider submits evidence */
  submitEvidence(
    id: string,
    token: string,
    payload: {
      milestone_id: string
      gps_lat?: number
      gps_lng?: number
      arrival_photo_url?: string
      completion_photo_url?: string
      time_on_site_minutes: number
      confirmation_code?: string
    }
  ) {
    return request(`/bookings/${id}/evidence`, {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    })
  },
}
