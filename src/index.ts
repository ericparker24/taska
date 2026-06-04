import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { authRoutes } from './routes/auth'
import { providerRoutes } from './routes/providers'
import { bookingRoutes } from './routes/bookings'
import { paymentRoutes } from './routes/payments'
import { guarantorRoutes } from './routes/guarantors'
import { marketplaceRoutes } from './routes/marketplace'
import type { Env } from './types'

const app = new Hono<{ Bindings: Env }>()

// ============================================================
// GLOBAL MIDDLEWARE
// ============================================================
app.use('*', logger())
app.use('*', prettyJSON())

app.use('*', cors({
  origin: ['https://taska.africa', 'https://www.taska.africa', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (c) => c.json({
  service:     'Taska API',
  version:     '2.0.0',
  status:      'running',
  environment: c.env.ENVIRONMENT,
  aligned_with: 'Master Plan June 2026',
}))

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ============================================================
// ROUTES
// ============================================================
app.route('/auth',        authRoutes)
app.route('/providers',   providerRoutes)
app.route('/bookings',    bookingRoutes)
app.route('/payments',    paymentRoutes)
app.route('/guarantors',  guarantorRoutes)
app.route('/marketplace', marketplaceRoutes)

// ============================================================
// 404 + ERROR HANDLERS
// ============================================================
app.notFound((c) => c.json({ success: false, error: 'Route not found', code: 'NOT_FOUND' }, 404))

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500)
})

export default app
