import { getSupabase } from './supabase'
import { isProjectStalled } from './pricing'
import type { Env } from '../types'

// ============================================================
// STALLED PROJECT SCAN
// Route 2 only. "Activity" = any milestone funded/completed, any
// project update posted, any project message sent, or any change
// order proposed. If none of that has happened in 14+ days on an
// otherwise-active project, it's stalled — flag it and notify
// the client, provider, AND guarantor (not just one side).
//
// Intended to run on a schedule (see `scheduled` export in
// src/index.ts + [triggers] in wrangler.toml), but is also safe to
// call on demand via the admin-only /admin/scan-stalled-projects route.
// ============================================================

const ACTIVE_BOOKING_STATUSES = ['awaiting_guarantor', 'in_progress', 'withdrawal_requested']

export async function scanStalledProjects(env: Env) {
  const supabase = getSupabase(env)
  const results = { scanned: 0, flagged: 0, alreadyFlagged: 0 }

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, client_id, provider_id, created_at, providers(user_id)')
    .eq('booking_route', 'route_2')
    .in('status', ACTIVE_BOOKING_STATUSES)

  for (const booking of bookings ?? []) {
    results.scanned++

    const [milestones, updates, messages, changeOrders, existingFlag] = await Promise.all([
      supabase.from('milestones').select('funded_at, completed_at').eq('booking_id', booking.id),
      supabase.from('project_updates').select('created_at').eq('booking_id', booking.id).order('created_at', { ascending: false }).limit(1),
      supabase.from('project_messages').select('created_at').eq('booking_id', booking.id).order('created_at', { ascending: false }).limit(1),
      supabase.from('change_orders').select('created_at').eq('booking_id', booking.id).order('created_at', { ascending: false }).limit(1),
      supabase.from('red_flags').select('id').eq('booking_id', booking.id).eq('flag_type', 'project_stalled').eq('resolved', false).maybeSingle(),
    ])

    if (existingFlag.data) {
      results.alreadyFlagged++
      continue  // don't double-flag — admin needs to resolve the existing one first
    }

    const activityDates: Date[] = [new Date(booking.created_at)]
    for (const m of milestones.data ?? []) {
      if (m.funded_at) activityDates.push(new Date(m.funded_at))
      if (m.completed_at) activityDates.push(new Date(m.completed_at))
    }
    if (updates.data?.[0]) activityDates.push(new Date(updates.data[0].created_at))
    if (messages.data?.[0]) activityDates.push(new Date(messages.data[0].created_at))
    if (changeOrders.data?.[0]) activityDates.push(new Date(changeOrders.data[0].created_at))

    const lastActivity = new Date(Math.max(...activityDates.map(d => d.getTime())))

    if (!isProjectStalled(lastActivity)) continue

    const providerUserId = (booking as any).providers?.user_id ?? booking.provider_id

    await supabase.from('red_flags').insert({
      booking_id: booking.id,
      user_id: providerUserId,
      flag_type: 'project_stalled',
      severity: 'medium',
      description: `No progress update, message, or milestone activity in 14+ days. Last activity: ${lastActivity.toISOString()}.`,
      auto_actioned: false,
      resolved: false,
    })

    const { data: guarantor } = await supabase
      .from('guarantors').select('user_id').eq('booking_id', booking.id).single()

    const recipients = [booking.client_id, providerUserId, guarantor?.user_id]
      .filter((id): id is string => !!id)

    await supabase.from('notifications').insert(
      recipients.map(id => ({
        user_id: id,
        type: 'project_stalled',
        title: 'This project has gone quiet',
        body: 'No activity in 14+ days. Post an update, fund the next milestone, or reach out in the project chat to keep things moving.',
        data: { booking_id: booking.id },
        is_read: false,
      }))
    )

    results.flagged++
  }

  return results
}
