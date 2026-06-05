import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getSupabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { calculateMarketplaceCommission } from '../lib/pricing'
import type { Env } from '../types'

const marketplace = new Hono<{ Bindings: Env }>()

// -------------------------------------------------------
// GET /marketplace/products
// Browse products near job site — auto-shown when booking materials job
// -------------------------------------------------------
marketplace.get('/products', async (c) => {
  const supabase  = getSupabase(c.env)
  const category  = c.req.query('category') ?? ''
  const bookingId = c.req.query('booking_id') ?? ''

  let query = supabase
    .from('marketplace_products')
    .select(`*, sellers(business_name, location_address, rating_average)`)
    .eq('is_active', true)
    .gt('stock_available', 0)
    .order('created_at', { ascending: false })
    .limit(30)

  if (category) query = query.eq('category', category)

  const { data: products, error } = await query

  if (error) {
    return c.json({ success: false, error: 'Could not load products', code: 'DB_ERROR' }, 500)
  }

  return c.json({ success: true, data: { products: products ?? [], count: products?.length ?? 0 } })
})

// -------------------------------------------------------
// POST /marketplace/orders
// Client places a materials order for a booking
// -------------------------------------------------------
marketplace.post('/orders',
  requireAuth,
  zValidator('json', z.object({
    booking_id:       z.string().uuid(),
    guarantor_id:     z.string().uuid(),
    delivery_address: z.string(),
    items: z.array(z.object({
      product_id: z.string().uuid(),
      quantity:   z.number().int().positive(),
    })).min(1),
  })),
  async (c) => {
    const userId = c.get('userId')
    const body   = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Verify booking belongs to client
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, materials_amount')
      .eq('id', body.booking_id)
      .eq('client_id', userId)
      .single()

    if (!booking) {
      return c.json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404)
    }

    // Fetch product prices
    const productIds = body.items.map(i => i.product_id)
    const { data: products } = await supabase
      .from('marketplace_products')
      .select('id, price, seller_id, stock_available')
      .in('id', productIds)

    if (!products || products.length !== productIds.length) {
      return c.json({ success: false, error: 'Some products not found', code: 'PRODUCT_NOT_FOUND' }, 404)
    }

    // Calculate total
    let totalAmount = 0
    const orderItems = body.items.map(item => {
      const product   = products.find(p => p.id === item.product_id)!
      const itemTotal = product.price * item.quantity
      totalAmount    += itemTotal
      return { product_id: item.product_id, quantity: item.quantity, unit_price: product.price, total_price: itemTotal }
    })

    const commission = calculateMarketplaceCommission(totalAmount)
    const sellerId   = products[0].seller_id  // assuming single seller per order for MVP

    // Create order
    const { data: order, error } = await supabase
      .from('marketplace_orders')
      .insert({
        booking_id:       body.booking_id,
        seller_id:        sellerId,
        guarantor_id:     body.guarantor_id,
        status:           'pending',
        total_amount:     totalAmount,
        commission_amount: commission,
        delivery_address: body.delivery_address,
        delivery_photo_url: null,
      })
      .select()
      .single()

    if (error || !order) {
      return c.json({ success: false, error: 'Could not create order', code: 'DB_ERROR' }, 500)
    }

    // Insert order items
    await supabase.from('marketplace_order_items').insert(
      orderItems.map(item => ({ order_id: order.id, ...item }))
    )

    // Notify seller
    await supabase.from('notifications').insert({
      user_id: sellerId,
      type:    'new_order',
      title:   'New materials order',
      body:    `You have a new order for delivery to ${body.delivery_address}`,
      data:    { order_id: order.id },
      is_read: false,
    })

    return c.json({
      success: true,
      data: {
        order_id:         order.id,
        total_amount:     totalAmount,
        commission:       commission,
        message:          'Order placed. Seller will confirm and deliver to the job site.',
      }
    }, 201)
  }
)

// -------------------------------------------------------
// POST /marketplace/orders/:id/confirm-delivery
// Guarantor confirms delivery at job site with photo
// -------------------------------------------------------
marketplace.post('/orders/:id/confirm-delivery',
  requireAuth,
  zValidator('json', z.object({
    delivery_photo_url: z.string().url(),
  })),
  async (c) => {
    const orderId  = c.req.param('id')
    const userId   = c.get('userId')
    const { delivery_photo_url } = c.req.valid('json')
    const supabase = getSupabase(c.env)

    // Only guarantor can confirm delivery
    const { data: order } = await supabase
      .from('marketplace_orders')
      .select('*, guarantors!inner(user_id), sellers(user_id)')
      .eq('id', orderId)
      .single()

    if (!order || order.guarantors?.user_id !== userId) {
      return c.json({ success: false, error: 'Only the guarantor can confirm delivery', code: 'FORBIDDEN' }, 403)
    }

    await supabase.from('marketplace_orders').update({
      status:             'confirmed_by_guarantor',
      delivery_photo_url,
      confirmed_at:       new Date().toISOString(),
    }).eq('id', orderId)

    // Release payment to seller (minus commission)
    const sellerAmount = order.total_amount - order.commission_amount
    await supabase.from('notifications').insert({
      user_id: order.sellers?.user_id,
      type:    'delivery_confirmed',
      title:   'Delivery confirmed!',
      body:    `Your delivery was confirmed by the guarantor. Payment of GHS ${(sellerAmount / 100).toFixed(2)} is on its way.`,
      data:    { order_id: orderId },
      is_read: false,
    })

    return c.json({
      success: true,
      data: { message: 'Delivery confirmed. Seller will be paid.' }
    })
  }
)

export { marketplace as marketplaceRoutes }
