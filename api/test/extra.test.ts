import { describe, expect, it } from 'vitest'
import { type Bill, call, createBill, createHome, type Share } from './helpers'

// ---------------------------------------------------------------------------
// Helper: pay a share
// ---------------------------------------------------------------------------

function pay(billId: string, shareId: string, key?: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: key !== undefined ? { 'Idempotency-Key': key } : {},
  })
}

// ---------------------------------------------------------------------------
// Concurrent pay — different keys
// ---------------------------------------------------------------------------

describe('concurrent pay with different keys', () => {
  it('allows exactly one 200 and returns 409 for the rest', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    // Fire 10 simultaneous requests, each with a unique key
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pay(bill.body.id, share.id, crypto.randomUUID())),
    )

    const statuses = results.map((r) => r.status)
    const successCount = statuses.filter((s) => s === 200).length
    const conflictCount = statuses.filter((s) => s === 409).length

    expect(successCount).toBe(1)
    expect(conflictCount).toBe(9)
    expect(successCount + conflictCount).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Concurrent pay — same key (idempotency)
// ---------------------------------------------------------------------------

describe('concurrent pay with the same key', () => {
  it('returns 200 for all requests and always the same paidAt', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const key = crypto.randomUUID()

    // Fire 10 simultaneous requests with the same idempotency key
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pay(bill.body.id, share.id, key)),
    )

    for (const result of results) {
      expect(result.status).toBe(200)
    }

    // All responses must report the same paidAt timestamp
    const timestamps = results.map((r) => r.body.paidAt)
    const unique = new Set(timestamps)
    expect(unique.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Invalid JSON body
// ---------------------------------------------------------------------------

describe('invalid JSON body', () => {
  it('returns JSON { error: string } for a malformed body on POST /homes', async () => {
    const res = await call('POST', '/api/homes', {
      body: 'not-json' as unknown as Record<string, unknown>,
    })
    // The body we send is a plain string; the server receives invalid JSON
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(typeof (res.body as { error?: unknown }).error).toBe('string')
  })

  it('returns JSON { error: string } for an empty body on POST /homes/:id/members', async () => {
    const { homeId } = await createHome(['Asha'])
    // Send null as the body — parsed by the helper as JSON "null"
    const res = await call('POST', `/api/homes/${homeId}/members`, { body: null })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(typeof (res.body as { error?: unknown }).error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Valid shareId with wrong billId → 404
// ---------------------------------------------------------------------------

describe('wrong billId for a valid shareId', () => {
  it('returns 404', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    // Use a different (non-existent) billId with a real shareId
    const res = await pay('does-not-exist', share.id, crypto.randomUUID())

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Remainder distribution
// ---------------------------------------------------------------------------

describe('remainder distribution', () => {
  it('1 cent between 3 members → 201 with shares [1, 0, 0] summing to 1', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    const bill = await createBill(homeId, 1)

    expect(bill.status).toBe(201)

    const amounts = bill.body.shares.map((s) => s.amountCents)
    expect(amounts).toEqual([1, 0, 0])
    expect(amounts.reduce((sum, a) => sum + a, 0)).toBe(1)
  })

  it('2 cents between 5 members → [1, 1, 0, 0, 0] summing to 2', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra', 'Dev', 'Esha'])
    const bill = await createBill(homeId, 2)

    expect(bill.status).toBe(201)

    const amounts = bill.body.shares.map((s) => s.amountCents)
    expect(amounts).toEqual([1, 1, 0, 0, 0])
    expect(amounts.reduce((sum, a) => sum + a, 0)).toBe(2)
  })

  it('4 cents between 3 members → [2, 1, 1] summing to 4', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    const bill = await createBill(homeId, 4)

    expect(bill.status).toBe(201)

    const amounts = bill.body.shares.map((s) => s.amountCents)
    expect(amounts).toEqual([2, 1, 1])
    expect(amounts.reduce((sum, a) => sum + a, 0)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// GET /api/homes/:homeId/bills — missing home → 404
// ---------------------------------------------------------------------------

describe('GET /api/homes/:homeId/bills', () => {
  it('returns 404 with { error: string } when the home does not exist', async () => {
    const res = await call<{ bills: Bill[] }>('GET', '/api/homes/does-not-exist/bills')

    expect(res.status).toBe(404)
    expect(typeof (res.body as { error?: unknown }).error).toBe('string')
  })

  it('returns 200 with an empty bills array for a home with no bills', async () => {
    const { homeId } = await createHome(['Asha'])
    const res = await call<{ bills: Bill[] }>('GET', `/api/homes/${homeId}/bills`)

    expect(res.status).toBe(200)
    expect(res.body.bills).toEqual([])
  })

  it('returns existing bills with their shares after creation', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    await createBill(homeId, 1000)
    await createBill(homeId, 500)

    const res = await call<{ bills: Bill[] }>('GET', `/api/homes/${homeId}/bills`)

    expect(res.status).toBe(200)
    expect(res.body.bills).toHaveLength(2)
    for (const bill of res.body.bills) {
      expect(bill.shares).toHaveLength(2)
      expect(bill.shares.every((s) => s.paidAt === null)).toBe(true)
    }
  })
})
