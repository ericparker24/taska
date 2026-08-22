// ============================================================
// TASKA COMMISSION CALCULATOR — Aligned with Master Plan v2
// All amounts in PESEWAS (GHS × 100)
// ============================================================

// Commission tiers (pesewas)
const GHS_500   = 50_000
const GHS_5000  = 500_000
const GHS_20000 = 2_000_000

export function calculateCommission(amountPesewas: number): number {
  if (amountPesewas < GHS_500)   return Math.round(amountPesewas * 0.10)  // 10% under GHS 500
  if (amountPesewas < GHS_5000)  return Math.round(amountPesewas * 0.08)  // 8%
  if (amountPesewas < GHS_20000) return Math.round(amountPesewas * 0.06)  // 6%
  return Math.round(amountPesewas * 0.05)                                   // 5% above GHS 20,000
}

// Marketplace commission: 3–5%
export function calculateMarketplaceCommission(amountPesewas: number): number {
  if (amountPesewas < GHS_500)  return Math.round(amountPesewas * 0.05)   // 5%
  if (amountPesewas < GHS_5000) return Math.round(amountPesewas * 0.04)   // 4%
  return Math.round(amountPesewas * 0.03)                                   // 3%
}

// Guarantor fee breakdown
// 2.5% total → 1.5% to guarantor, 1% to Taska
export function calculateGuarantorFees(amountPesewas: number) {
  const toGuarantor = Math.round(amountPesewas * 0.015)
  const toTaska     = Math.round(amountPesewas * 0.010)
  return { total: toGuarantor + toTaska, toGuarantor, toTaska }
}

// Route 2 amount split
// Materials = 50% of total, Labour = 50% minus commission
export function splitBookingAmounts(totalPesewas: number, hasGuarantor: boolean) {
  const commission = calculateCommission(totalPesewas)
  if (hasGuarantor) {
    const materialsAmount = Math.round(totalPesewas * 0.5)
    const labourAmount    = totalPesewas - materialsAmount - commission
    return { materialsAmount, labourAmount, commission }
  }
  return { materialsAmount: 0, labourAmount: totalPesewas - commission, commission }
}

// Evidence auto-release scoring
// GPS(25) + Photo(25) + Time(25) + ConfirmationCode(25) = 100
export function calculateEvidenceScore(evidence: {
  hasGps: boolean
  hasPhoto: boolean
  timeOnSiteMinutes: number
  hasConfirmationCode: boolean
  expectedDurationMinutes?: number
}): number {
  let score = 0
  if (evidence.hasGps)              score += 25
  if (evidence.hasPhoto)            score += 25
  if (evidence.hasConfirmationCode) score += 25

  const expected = evidence.expectedDurationMinutes ?? 60
  const ratio    = evidence.timeOnSiteMinutes / expected
  if      (ratio >= 0.8) score += 25
  else if (ratio >= 0.5) score += 15
  else if (ratio >= 0.25) score += 5

  return Math.min(score, 100)
}

// Auto-release timing rules (master plan):
// Client silent 72 hours after withdrawal request → auto-release to provider
// Provider no activity for 7 days → auto-refund to client
export function getAutoReleaseAt(withdrawalRequestedAt: Date): Date {
  return new Date(withdrawalRequestedAt.getTime() + 72 * 60 * 60 * 1000)
}

export function getAbandonmentRefundAt(lastActivityAt: Date): Date {
  return new Date(lastActivityAt.getTime() + 7 * 24 * 60 * 60 * 1000)
}

// False dispute penalty: GHS 50 = 5000 pesewas
export const FALSE_DISPUTE_PENALTY_PESEWAS = 5_000

// Rolling escrow: when milestone N is approved/released, the *next*
// unfunded milestone should be prompted for funding — not the whole project.
// Returns null if there's nothing left to fund (project complete).
export function getNextMilestoneToFund(
  milestones: { id: string; sequence: number; status: string }[]
): { id: string; sequence: number } | null {
  const unfunded = milestones
    .filter(m => m.status === 'pending')
    .sort((a, b) => a.sequence - b.sequence)
  return unfunded.length ? { id: unfunded[0].id, sequence: unfunded[0].sequence } : null
}

// Project stalled check — Route 2 only.
// No progress update AND no milestone status change in 14+ days.
export function isProjectStalled(lastActivityAt: Date): boolean {
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000
  return Date.now() - lastActivityAt.getTime() > fourteenDaysMs
}

// A milestone is overdue if its due_date has passed and it hasn't
// reached a payment-resolution state yet. Released/withdrawal_requested
// milestones are done or settling — being "late" no longer matters.
const ACTIVE_MILESTONE_STATUSES = ['pending', 'funded', 'in_progress', 'evidence_submitted']
export function isMilestoneOverdue(dueDate: string | null, status: string): boolean {
  if (!dueDate || !ACTIVE_MILESTONE_STATUSES.includes(status)) return false
  return new Date(dueDate) < new Date()
}

// Guarantor gate — a guarantor only needs to have *accepted* the role
// (not necessarily completed registration/materials yet) before the
// client can start funding milestones. Anything before 'accepted'
// (invited, declined, timed_out) keeps the project blocked.
const GUARANTOR_READY_STATUSES = [
  'accepted', 'registered', 'materials_received',
  'materials_purchased', 'job_confirmed', 'fee_paid',
]
export function isGuarantorReady(status: string): boolean {
  return GUARANTOR_READY_STATUSES.includes(status)
}

// Cancellation auto-confirm rule:
// If the other party doesn't respond within 48 hours, the
// cancellation finalizes automatically (shorter than the 72hr
// payment-release window since no funds are being released here —
// just stopping the project).
export function getCancellationConfirmAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + 48 * 60 * 60 * 1000)
}

// Convert GHS ↔ pesewas
export const ghsToPesewas  = (ghs: number)     => Math.round(ghs * 100)
export const pesewasToGhs  = (pesewas: number) => pesewas / 100
