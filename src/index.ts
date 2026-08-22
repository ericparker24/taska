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
import { pushRoutes } from './routes/push'
import { scanStalledProjects } from './lib/jobs'
import { keepAlive } from './lib/keepalive'
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
  service:      'Taska API',
  version:      '2.0.0',
  status:       'running',
  environment:  c.env.ENVIRONMENT,
  timestamp:    new Date().toISOString(),
}))

app.get('/health', (c) => c.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
}))

// ============================================================
// ROUTES — single Worker, all routes
// ============================================================
app.route('/auth',        authRoutes)
app.route('/providers',   providerRoutes)
app.route('/bookings',    bookingRoutes)
app.route('/payments',    paymentRoutes)
app.route('/guarantors',  guarantorRoutes)
app.route('/marketplace', marketplaceRoutes)
app.route('/push',        pushRoutes)

// ============================================================
// ADMIN — manual triggers for testing scheduled jobs
// ============================================================
app.post('/admin/scan-stalled-projects', async (c) => {
  // Require internal secret header for admin endpoints
  const secret = c.req.header('X-Admin-Secret')
  if (secret !== c.env.ADMIN_SECRET) {
    return c.json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' }, 403)
  }
  const results = await scanStalledProjects(c.env)
  return c.json({ success: true, data: results })
})

// ============================================================
// 404 + ERROR HANDLERS
// ============================================================
app.notFound((c) =>
  c.json({ success: false, error: 'Route not found', code: 'NOT_FOUND' }, 404)
)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500)
})

// ============================================================
// SCHEDULED CRON HANDLER
// Cloudflare calls this based on crons in wrangler.toml.
// Time-based jobs (auto-release, stalled scan) are also
// handled by Supabase pg_cron — this is a backup trigger.
// ============================================================
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      switch (event.cron) {
        case '*/5 * * * *':
          // Keep DB awake during development (no-op in production)
          await keepAlive(env)
          break

        case '0 6 * * *':
          // Stalled project scan — also runs in Supabase pg_cron
          const results = await scanStalledProjects(env)
          console.log('[cron] stalled scan:', results)
          break

        default:
          console.log('[cron] unmatched schedule:', event.cron)
      }
    })())
  },
}
