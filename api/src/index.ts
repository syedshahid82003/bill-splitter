import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

app.notFound((c) => c.json({ error: 'not found' }, 404))

async function parseBody(c: { req: { json: <T>() => Promise<T> } }): Promise<unknown> {
  try {
    return await c.req.json<unknown>()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// ---------------------------------------------------------------------------
// Part 1 – Homes and Members
// ---------------------------------------------------------------------------

app.post('/api/homes', async (c) => {
  const body = await parseBody(c)
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'request body must be a JSON object' }, 422)
  }
  const { name } = body as Record<string, unknown>
  if (typeof name !== 'string' || name.trim() === '') {
    return c.json({ error: 'name must be a non-empty string' }, 422)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  const body = await parseBody(c)
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'request body must be a JSON object' }, 422)
  }
  const { name } = body as Record<string, unknown>
  if (typeof name !== 'string' || name.trim() === '') {
    return c.json({ error: 'name must be a non-empty string' }, 422)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// ---------------------------------------------------------------------------
// Part 2 – Bills
// ---------------------------------------------------------------------------

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  const body = await parseBody(c)
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'request body must be a JSON object' }, 422)
  }
  const { title, totalCents } = body as Record<string, unknown>

  // totalCents must be a positive integer (not a float, not zero, not negative)
  if (typeof totalCents !== 'number' || !Number.isInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive integer' }, 422)
  }

  // Fetch members in insertion order (rowid = insertion order within D1)
  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string }>()

  if (members.length === 0) {
    return c.json({ error: 'home has no members' }, 422)
  }

  const safeTitle = typeof title === 'string' && title.trim() !== '' ? title : 'Bill'

  const billId = crypto.randomUUID()

  // Split: floor division, first (remainder) members each get +1 cent
  const count = members.length
  const base = Math.floor(totalCents / count)
  const remainder = totalCents % count

  type ShareRow = { id: string; memberId: string; amountCents: number; paidAt: null }

  const shares: ShareRow[] = members.map((member, i) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: i < remainder ? base + 1 : base,
    paidAt: null,
  }))

  // Insert the bill and all shares atomically in a single batch
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, safeTitle, totalCents),
    ...shares.map((s) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(s.id, billId, s.memberId, s.amountCents),
    ),
  ])

  return c.json({ id: billId, homeId, title: safeTitle, totalCents, shares }, 201)
})

// ---------------------------------------------------------------------------
// Part 2 – List bills for a home (with shares in member insertion order)
// ---------------------------------------------------------------------------

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  // Fetch all bills for this home
  const { results: billRows } = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents FROM bills WHERE home_id = ? ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string; home_id: string; title: string; total_cents: number }>()

  // Fetch all shares for those bills, ordered by member insertion order (members.rowid)
  type ShareRow = {
    id: string
    bill_id: string
    member_id: string
    amount_cents: number
    paid_at: string | null
  }

  const { results: shareRows } = await c.env.DB.prepare(
    `SELECT s.id, s.bill_id, s.member_id, s.amount_cents, s.paid_at
     FROM shares s
     JOIN members m ON m.id = s.member_id
     WHERE s.bill_id IN (SELECT id FROM bills WHERE home_id = ?)
     ORDER BY s.bill_id, m.rowid ASC`,
  )
    .bind(homeId)
    .all<ShareRow>()

  // Group shares by bill_id
  const sharesByBill = new Map<string, ShareRow[]>()
  for (const share of shareRows) {
    const list = sharesByBill.get(share.bill_id) ?? []
    list.push(share)
    sharesByBill.set(share.bill_id, list)
  }

  const bills = billRows.map((b) => ({
    id: b.id,
    homeId: b.home_id,
    title: b.title,
    totalCents: b.total_cents,
    shares: (sharesByBill.get(b.id) ?? []).map((s) => ({
      id: s.id,
      memberId: s.member_id,
      amountCents: s.amount_cents,
      paidAt: s.paid_at,
    })),
  }))

  return c.json({ bills })
})

// ---------------------------------------------------------------------------
// Part 2 – Pay a share (idempotent, concurrency-safe)
// ---------------------------------------------------------------------------

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const idempotencyKey = c.req.header('Idempotency-Key')

  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  // Verify the bill exists first
  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(billId).first()
  if (!bill) {
    return c.json({ error: 'bill not found' }, 404)
  }

  // Fetch the share — must belong to this specific bill
  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      member_id: string
      amount_cents: number
      paid_at: string | null
      idempotency_key: string | null
    }>()

  if (!share) {
    return c.json({ error: 'share not found' }, 404)
  }

  // Already paid with the same key — idempotent success
  if (share.paid_at !== null && share.idempotency_key === idempotencyKey) {
    return c.json({
      id: share.id,
      memberId: share.member_id,
      amountCents: share.amount_cents,
      paidAt: share.paid_at,
    })
  }

  // Already paid with a different key — conflict
  if (share.paid_at !== null) {
    return c.json({ error: 'share already paid with a different key' }, 409)
  }

  // Attempt atomic pay — WHERE paid_at IS NULL prevents double payment under concurrency
  const paidAt = new Date().toISOString()
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, idempotencyKey, shareId, billId)
    .run()

  if (result.meta.changes === 0) {
    // A concurrent request won the race — re-read and resolve
    const updated = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
    )
      .bind(shareId, billId)
      .first<{
        id: string
        member_id: string
        amount_cents: number
        paid_at: string | null
        idempotency_key: string | null
      }>()

    if (!updated || updated.paid_at === null) {
      return c.json({ error: 'payment failed unexpectedly' }, 500)
    }

    if (updated.idempotency_key === idempotencyKey) {
      return c.json({
        id: updated.id,
        memberId: updated.member_id,
        amountCents: updated.amount_cents,
        paidAt: updated.paid_at,
      })
    }

    return c.json({ error: 'share already paid with a different key' }, 409)
  }

  return c.json({
    id: share.id,
    memberId: share.member_id,
    amountCents: share.amount_cents,
    paidAt: paidAt,
  })
})

// ---------------------------------------------------------------------------
// Part 2 – Balances
// ---------------------------------------------------------------------------

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  // Sum unpaid share amounts per member, only for bills belonging to this home.
  // Members with no shares at all get 0 via COALESCE.
  // Ordered by rowid = insertion order.
  const { results } = await c.env.DB.prepare(
    `SELECT
       m.id   AS memberId,
       m.name AS name,
       COALESCE(
         SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END),
         0
       ) AS outstandingCents
     FROM members m
     LEFT JOIN shares s
       ON s.member_id = m.id
       AND s.bill_id IN (SELECT id FROM bills WHERE home_id = ?)
     WHERE m.home_id = ?
     GROUP BY m.id, m.name
     ORDER BY m.rowid ASC`,
  )
    .bind(homeId, homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: results })
})

export default app
