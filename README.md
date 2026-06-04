# Taska API — Hono on Cloudflare Workers

Africa's first community-backed service marketplace API.

## Stack
- **Runtime:** Cloudflare Workers
- **Framework:** Hono v4
- **Database:** Supabase (PostgreSQL)
- **Primary Payments:** PawaPay (African MoMo)
- **Fallback Payments:** Flutterwave
- **Language:** TypeScript

## Project Structure

```
src/
├── index.ts              # Main app entry point + middleware
├── types/
│   └── index.ts          # All TypeScript types (money in pesewas)
├── lib/
│   ├── supabase.ts       # Supabase client
│   └── pricing.ts        # Commission calculator + evidence scoring
├── middleware/
│   └── auth.ts           # JWT auth + role guards
└── routes/
    ├── auth.ts           # Phone OTP send/verify/refresh
    ├── providers.ts      # Provider onboarding (7 steps) + search
    ├── bookings.ts       # Type A (project) + Type B (service) flows
    └── payments.ts       # PawaPay + Flutterwave failover + webhooks
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Set secrets (production)
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put PAWAPAY_API_KEY
npx wrangler secret put PAWAPAY_CORRESPONDENT_ID
npx wrangler secret put FLUTTERWAVE_SECRET_KEY
npx wrangler secret put DAILY_API_KEY
```

### 4. Run locally
```bash
npm run dev
```

### 5. Deploy
```bash
npm run deploy
```

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/send-otp` | Send OTP to phone |
| POST | `/auth/verify-otp` | Verify OTP → get session token |
| POST | `/auth/refresh` | Refresh expired token |

### Providers
| Method | Path | Description |
|--------|------|-------------|
| GET | `/providers/me` | Get my provider profile |
| POST | `/providers/onboard/start` | Step 1: name + bio |
| POST | `/providers/onboard/id-upload` | Step 2: get upload URL for ID |
| POST | `/providers/onboard/services` | Step 5: select services |
| POST | `/providers/onboard/pricing` | Step 7: set prices → go LIVE |
| GET | `/providers/search` | Search providers |

### Bookings
| Method | Path | Description |
|--------|------|-------------|
| POST | `/bookings` | Create booking (Type A or B) |
| GET | `/bookings/:id` | Get booking details |
| POST | `/bookings/:id/accept` | Provider accepts booking |
| POST | `/bookings/:id/evidence` | Submit completion evidence |

### Payments
| Method | Path | Description |
|--------|------|-------------|
| POST | `/payments/initiate` | Pay (PawaPay → Flutterwave failover) |
| POST | `/payments/webhook/pawapay` | PawaPay webhook |
| POST | `/payments/webhook/flutterwave` | Flutterwave webhook |

## Key Design Decisions

- All money stored as **integers in pesewas** (GHS × 100) — no floating point errors
- Phone number is the only identity — no email anywhere
- PawaPay fails → Flutterwave takes over **invisibly** — user never sees it
- Evidence scoring: GPS(25) + Photo(25) + Time(25) + Code(25) = 100
- Score 100 → auto-release in 2 hours (pg_cron)
- Score 75+ → 24hr dispute window then auto-release
- 14-day starter lock — new providers cannot receive payment for 14 days
