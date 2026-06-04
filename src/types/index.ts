// ============================================================
// TASKA PLATFORM — Core Types v2
// Aligned with Master Plan June 2026
// All money values in PESEWAS (integers, no decimals)
// Phone number is primary identity across all types
// ============================================================

export type Env = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  PAWAPAY_API_KEY: string
  PAWAPAY_CORRESPONDENT_ID: string
  FLUTTERWAVE_SECRET_KEY: string
  DAILY_API_KEY: string
  ENVIRONMENT: string
}

// ============================================================
// USER
// ============================================================
export type UserRole = 'client' | 'provider' | 'guarantor' | 'seller' | 'admin'

export type User = {
  id: string
  phone: string
  full_name: string | null
  role: UserRole
  country_code: string           // GH, NG, KE, TZ, UG, RW, CI, SN, CM, ZA, ZM
  currency_code: string          // GHS, NGN, KES, etc — auto-set from country
  taska_score: number            // 0–100 trust score
  is_blacklisted: boolean
  diaspora_mode: boolean         // true if user is outside Africa booking for someone in Africa
  diaspora_target_country: string | null  // target country for diaspora bookings
  created_at: string
}

// ============================================================
// PROVIDER
// ============================================================
export type VerificationStep =
  | 'start'
  | 'id_upload'
  | 'face_match'
  | 'address'
  | 'service_selection'
  | 'portfolio'
  | 'pricing'
  | 'complete'

export type Provider = {
  id: string
  user_id: string
  business_name: string | null
  bio: string | null
  preferred_language: string     // twi, ga, dagbani, hausa, yoruba, igbo, pidgin, swahili, french, english
  verification_step: VerificationStep
  is_verified: boolean
  is_live: boolean               // false until all steps complete
  starter_lock_until: string     // 14-day lock — no withdrawals before this date
  rating_average: number         // 0.0–5.0
  jobs_completed: number
  response_time_minutes: number
  subscription_tier: 'free' | 'standard' | 'pro' | 'elite'
  voice_registered: boolean      // true if registered via voice onboarding
  created_at: string
}

// ============================================================
// WALLET — Three-wallet architecture
// CLIENT WALLET → TASKA ESCROW → PROVIDER WALLET
// ============================================================
export type WalletType = 'client' | 'escrow' | 'provider' | 'guarantor'

export type Wallet = {
  id: string
  user_id: string
  wallet_type: WalletType
  balance: number                // in pesewas
  currency_code: string
  is_frozen: boolean             // frozen during active dispute
  created_at: string
  updated_at: string
}

export type WalletTransaction = {
  id: string
  wallet_id: string
  booking_id: string | null
  amount: number                 // in pesewas — positive = credit, negative = debit
  transaction_type: WalletTransactionType
  description: string
  created_at: string
}

export type WalletTransactionType =
  | 'deposit'                    // client tops up wallet
  | 'escrow_lock'                // money moves from client wallet to escrow
  | 'labour_release'             // escrow releases labour to provider wallet
  | 'materials_to_guarantor'     // escrow releases materials to guarantor wallet
  | 'guarantor_fee'              // guarantor earns 1.5% of job
  | 'commission_deduction'       // Taska takes commission
  | 'withdrawal'                 // provider withdraws to MoMo
  | 'refund'                     // money returned to client
  | 'marketplace_payment'        // client pays for marketplace materials
  | 'diaspora_conversion'        // foreign currency converted to local

// ============================================================
// BOOKING
// Route 1 = Simple Direct Booking (quick service jobs)
// Route 2 = Guaranteed Booking (big projects with materials)
// ============================================================
export type BookingRoute = 'route_1' | 'route_2'

export type BookingStatus =
  | 'pending'                    // waiting for provider to accept
  | 'accepted'                   // provider accepted
  | 'payment_pending'            // waiting for client to pay into escrow
  | 'in_progress'                // payment confirmed, work started
  | 'withdrawal_requested'       // provider requested payment release
  | 'completed'                  // client confirmed, money released
  | 'disputed'                   // dispute raised, money frozen
  | 'auto_released'              // client silent 72hrs, auto-released to provider
  | 'auto_refunded'              // provider abandoned 7 days, refunded to client
  | 'cancelled'

export type Booking = {
  id: string
  client_id: string
  provider_id: string
  service_id: string
  booking_route: BookingRoute
  status: BookingStatus
  total_amount: number           // in pesewas — full job amount
  labour_amount: number          // in pesewas — provider's cut
  materials_amount: number       // in pesewas — 0 for Route 1
  commission_amount: number      // in pesewas — Taska's cut
  description: string
  location_lat: number | null
  location_lng: number | null
  location_address: string | null
  landmark_description: string | null   // rural fallback
  scheduled_at: string | null
  withdrawal_requested_at: string | null  // when provider tapped REQUEST PAYMENT
  client_pin_confirmed: boolean          // client entered PIN to release
  auto_release_at: string | null         // 72hrs after withdrawal_requested_at
  provider_abandoned_at: string | null   // triggers 7-day refund timer
  created_at: string
}

// ============================================================
// WITHDRAWAL REQUEST
// Provider requests payment → client approves/denies
// ============================================================
export type WithdrawalStatus = 'pending' | 'approved' | 'denied' | 'auto_released' | 'overridden'

export type WithdrawalRequest = {
  id: string
  booking_id: string
  milestone_id: string | null
  provider_id: string
  amount: number                 // in pesewas
  status: WithdrawalStatus
  denial_reason: string | null   // required if client denies
  admin_override: boolean        // admin can override bad-faith denial
  requested_at: string
  resolved_at: string | null
  auto_release_at: string        // requested_at + 72 hours
}

// ============================================================
// MILESTONE — Route 2 only
// ============================================================
export type MilestoneStatus =
  | 'pending'
  | 'in_progress'
  | 'evidence_submitted'
  | 'withdrawal_requested'
  | 'approved'
  | 'released'
  | 'disputed'

export type Milestone = {
  id: string
  booking_id: string
  title: string
  amount: number                 // in pesewas — labour for this milestone
  status: MilestoneStatus
  evidence_score: number         // 0–100
  due_date: string | null
  completed_at: string | null
  created_at: string
}

// ============================================================
// EVIDENCE — GPS + photo + time + confirmation code
// ============================================================
export type Evidence = {
  id: string
  milestone_id: string
  booking_id: string
  provider_id: string
  gps_lat: number | null
  gps_lng: number | null
  gps_score: number              // 0 or 25
  arrival_photo_url: string | null
  completion_photo_url: string | null
  photo_score: number            // 0 or 25
  time_on_site_minutes: number
  time_score: number             // 0 or 25
  confirmation_code: string | null   // 4-digit code client gives provider
  confirmation_score: number     // 0 or 25
  total_score: number            // 0–100
  submitted_at: string
}

// ============================================================
// GUARANTOR
// ============================================================
export type GuarantorType =
  | 'personal'                   // client's own contact
  | 'taska_verified'             // Taska's verified guarantor network
  | 'escrow_only'                // no guarantor, stricter milestones

export type GuarantorStatus =
  | 'invited'                    // SMS sent, waiting for acceptance
  | 'accepted'                   // guarantor accepted role
  | 'registered'                 // completed quick registration
  | 'materials_received'         // materials money in guarantor wallet
  | 'materials_purchased'        // receipt uploaded and approved
  | 'job_confirmed'              // guarantor confirmed job complete
  | 'fee_paid'                   // 1.5% fee paid to guarantor
  | 'declined'
  | 'timed_out'                  // did not respond within 48 hours

export type Guarantor = {
  id: string
  booking_id: string
  user_id: string | null         // null until they register
  guarantor_type: GuarantorType
  phone: string                  // phone number guarantor was invited on
  personal_message: string | null  // client's personal message in the SMS
  materials_amount: number       // in pesewas
  fee_amount: number             // in pesewas — 1.5% of job value
  receipt_url: string | null
  receipt_approved: boolean
  site_visit_confirmed: boolean
  status: GuarantorStatus
  invited_at: string
  accepted_at: string | null
  expires_at: string             // invitation expires after 48 hours
  created_at: string
}

// ============================================================
// MATERIALS PURCHASE — Three options for Route 2
// ============================================================
export type MaterialsOption = 'marketplace' | 'guarantor' | 'hybrid'

export type MaterialsPlan = {
  id: string
  booking_id: string
  option: MaterialsOption
  total_materials_amount: number    // in pesewas
  marketplace_amount: number        // in pesewas — Option A or C
  guarantor_amount: number          // in pesewas — Option B or C
  marketplace_confirmed: boolean
  guarantor_confirmed: boolean
  created_at: string
}

// ============================================================
// MARKETPLACE — Taska materials + products
// ============================================================
export type Seller = {
  id: string
  user_id: string
  business_name: string
  business_type: string          // hardware, cement, fabric, etc
  is_verified: boolean
  is_active: boolean
  location_lat: number | null
  location_lng: number | null
  location_address: string | null
  rating_average: number
  created_at: string
}

export type MarketplaceProduct = {
  id: string
  seller_id: string
  name: string
  description: string | null
  category: string
  price: number                  // in pesewas per unit
  unit: string                   // bag, piece, metre, litre, kg
  stock_available: number
  image_urls: string[]
  is_active: boolean
  created_at: string
}

export type MarketplaceOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'delivering'
  | 'delivered'
  | 'confirmed_by_guarantor'
  | 'seller_paid'
  | 'disputed'

export type MarketplaceOrder = {
  id: string
  booking_id: string
  seller_id: string
  guarantor_id: string           // guarantor confirms delivery at site
  status: MarketplaceOrderStatus
  total_amount: number           // in pesewas
  commission_amount: number      // in pesewas — 3–5% to Taska
  delivery_address: string
  delivery_photo_url: string | null
  confirmed_at: string | null
  created_at: string
}

export type MarketplaceOrderItem = {
  id: string
  order_id: string
  product_id: string
  quantity: number
  unit_price: number             // in pesewas
  total_price: number            // in pesewas
}

// ============================================================
// PAYMENT
// ============================================================
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
export type PaymentProcessor = 'pawapay' | 'flutterwave'
export type PaymentType =
  | 'escrow_deposit'
  | 'labour_release'
  | 'materials_to_guarantor'
  | 'guarantor_fee'
  | 'commission'
  | 'marketplace_payment'
  | 'diaspora_conversion'
  | 'withdrawal'
  | 'refund'
  | 'false_dispute_penalty'      // GHS 50 penalty for bad-faith disputes

export type Payment = {
  id: string
  booking_id: string
  amount: number                 // in pesewas
  payment_type: PaymentType
  processor: PaymentProcessor
  processor_transaction_id: string | null
  status: PaymentStatus
  phone: string
  currency_code: string          // GHS, NGN, KES, GBP, USD — for diaspora
  local_amount: number           // in pesewas after conversion
  created_at: string
}

// ============================================================
// DISPUTE
// ============================================================
export type DisputeStatus = 'open' | 'bot_resolving' | 'escalated' | 'resolved' | 'closed'
export type DisputeRaisedBy = 'client' | 'provider'

export type Dispute = {
  id: string
  booking_id: string
  raised_by: DisputeRaisedBy
  reason: string
  denial_reason: string | null   // from withdrawal denial
  evidence_urls: string[]
  status: DisputeStatus
  resolution: string | null
  resolved_in_favour_of: 'client' | 'provider' | null
  bot_confidence: number | null  // 0–100
  admin_override: boolean
  false_dispute_penalty_applied: boolean  // GHS 50
  created_at: string
}

// ============================================================
// RED FLAG — Automatic fraud detection
// ============================================================
export type RedFlagSeverity = 'critical' | 'warning' | 'monitoring'
export type RedFlagType =
  | 'provider_no_checkin'
  | 'job_exceeded_timeline'
  | 'withdrawal_no_evidence'
  | 'multiple_disputes'
  | 'guarantor_silent'
  | 'large_withdrawal_new_account'
  | 'client_bad_faith_denial'
  | 'duplicate_device'
  | 'external_payment_request'

export type RedFlag = {
  id: string
  booking_id: string | null
  user_id: string
  flag_type: RedFlagType
  severity: RedFlagSeverity
  description: string
  auto_actioned: boolean
  resolved: boolean
  created_at: string
}

// ============================================================
// API RESPONSES
// ============================================================
export type ApiSuccess<T> = {
  success: true
  data: T
}

export type ApiError = {
  success: false
  error: string
  code: string
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError
