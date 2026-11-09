import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { type Bill, call, createBill, createHome } from './helpers'

function postBill(homeId: string, body: unknown) {
  return call<{ error: string }>('POST', `/api/homes/${homeId}/bills`, { body })
}

async function rowCounts(homeId: string) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bills WHERE home_id = ?1) AS bills,
            (SELECT COUNT(*) FROM shares WHERE home_id = ?1) AS shares`,
  )
    .bind(homeId)
    .first<{ bills: number; shares: number }>()
  return row
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bill creation', () => {
  it.each([
    { total: 4999, count: 1, expected: [4999] },
    { total: 3000, count: 3, expected: [1000, 1000, 1000] },
    { total: 1000, count: 3, expected: [334, 333, 333] },
    { total: 1001, count: 3, expected: [334, 334, 333] },
    { total: 1000, count: 4, expected: [250, 250, 250, 250] },
    { total: 1, count: 3, expected: [1, 0, 0] },
    { total: 7, count: 2, expected: [4, 3] },
  ])('splits $total between $count members as $expected', async ({ total, count, expected }) => {
    const { homeId } = await createHome(Array.from({ length: count }, (_, i) => `M${i}`))

    const bill = await createBill(homeId, total)

    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((share) => share.amountCents)).toEqual(expected)
  })

  it('returns exactly the documented shape with a trimmed title', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben'])

    const bill = await call<Bill>('POST', `/api/homes/${homeId}/bills`, {
      body: { title: '  Electricity Bill  ', totalCents: 1001 },
    })

    expect(bill.status).toBe(201)
    expect(bill.body).toEqual({
      id: expect.any(String),
      homeId,
      title: 'Electricity Bill',
      totalCents: 1001,
      shares: [
        { id: expect.any(String), memberId: members[0]?.id, amountCents: 501, paidAt: null },
        { id: expect.any(String), memberId: members[1]?.id, amountCents: 500, paidAt: null },
      ],
    })
  })

  it('orders shares by insertion order, not by name or id', async () => {
    const { homeId, members } = await createHome(['Zed', 'Asha', 'Mo'])

    const bill = await createBill(homeId, 2)

    expect(bill.body.shares.map((share) => share.memberId)).toEqual(members.map((m) => m.id))
    expect(bill.body.shares.map((share) => share.amountCents)).toEqual([1, 1, 0])
  })

  it('stores one share per member, summing to the total, with unique ids', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra', 'Dev'])

    const bill = await createBill(homeId, 100003)

    const { results } = await env.DB.prepare(
      `SELECT shares.id, shares.member_id, shares.amount_cents, shares.paid_at
       FROM shares JOIN members ON members.id = shares.member_id
       WHERE shares.bill_id = ?1
       ORDER BY members.position`,
    )
      .bind(bill.body.id)
      .all<{ id: string; member_id: string; amount_cents: number; paid_at: string | null }>()

    expect(results.map((row) => row.member_id)).toEqual(members.map((m) => m.id))
    expect(results.reduce((sum, row) => sum + row.amount_cents, 0)).toBe(100003)
    expect(results.map((row) => row.id)).toEqual(bill.body.shares.map((share) => share.id))
    expect(new Set([bill.body.id, ...results.map((row) => row.id)]).size).toBe(5)
    expect(results.every((row) => row.paid_at === null)).toBe(true)
  })
})

describe('bill validation', () => {
  it('returns 404 for a missing home', async () => {
    const bill = await postBill('does-not-exist', { title: 'Rent', totalCents: 1000 })

    expect(bill).toEqual({ status: 404, body: { error: expect.any(String) } })
  })

  it('returns 422 for a home with no members and writes nothing', async () => {
    const { homeId } = await createHome([])

    const bill = await postBill(homeId, { title: 'Rent', totalCents: 1000 })

    expect(bill).toEqual({ status: 422, body: { error: expect.any(String) } })
    expect(await rowCounts(homeId)).toEqual({ bills: 0, shares: 0 })
  })

  it.each([
    { case: 'missing title', body: { totalCents: 1000 } },
    { case: 'blank title', body: { title: '   ', totalCents: 1000 } },
    { case: 'non-string title', body: { title: 42, totalCents: 1000 } },
    { case: 'title over 100 characters', body: { title: 'x'.repeat(101), totalCents: 1000 } },
    { case: 'missing totalCents', body: { title: 'Rent' } },
    { case: 'string totalCents', body: { title: 'Rent', totalCents: '1000' } },
    { case: 'decimal totalCents', body: { title: 'Rent', totalCents: 100.5 } },
    { case: 'zero totalCents', body: { title: 'Rent', totalCents: 0 } },
    { case: 'negative totalCents', body: { title: 'Rent', totalCents: -500 } },
    { case: 'unsafe integer totalCents', body: { title: 'Rent', totalCents: 2 ** 53 } },
    { case: 'boolean totalCents', body: { title: 'Rent', totalCents: true } },
    { case: 'null totalCents', body: { title: 'Rent', totalCents: null } },
    { case: 'array body', body: [] },
  ])('returns 422 for $case and writes nothing', async ({ body }) => {
    const { homeId } = await createHome(['Asha', 'Ben'])

    const bill = await postBill(homeId, body)

    expect(bill).toEqual({ status: 422, body: { error: expect.any(String) } })
    expect(await rowCounts(homeId)).toEqual({ bills: 0, shares: 0 })
  })

  it('returns 400 for malformed JSON', async () => {
    const { homeId } = await createHome(['Asha'])

    const response = await exports.default.fetch(
      new Request(`http://localhost/api/homes/${homeId}/bills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"title": "Rent", "totalCents": ',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.any(String) })
  })
})

describe('bill atomicity and failures', () => {
  // These call the app directly with the test `env`, so the spies on env.DB are the
  // binding the handler actually uses.
  function postBillDirect(homeId: string) {
    return app.fetch(
      new Request(`http://localhost/api/homes/${homeId}/bills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Rent', totalCents: 1000 }),
      }),
      env,
    )
  }

  it('rolls back the bill and every share when a later statement fails', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    const realBatch = env.DB.batch.bind(env.DB)
    // Append a statement that violates homes_name_not_blank, so the batch fails after
    // the bill and share inserts have already run inside it.
    vi.spyOn(env.DB, 'batch').mockImplementation((statements) =>
      realBatch([
        ...statements,
        env.DB.prepare('INSERT INTO homes (id, name) VALUES (?1, ?2)').bind('x', ''),
      ]),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await postBillDirect(homeId)

    expect(response.status).toBe(500)
    expect(await rowCounts(homeId)).toEqual({ bills: 0, shares: 0 })
  })

  it('answers an unexpected database error with a generic JSON 500', async () => {
    const { homeId } = await createHome(['Asha'])
    vi.spyOn(env.DB, 'batch').mockRejectedValue(
      new Error('D1_ERROR: no such table: shares: SQLITE_ERROR'),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await postBillDirect(homeId)
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' })
    expect(text).not.toMatch(/SQLITE|D1_ERROR|shares/)
    expect(logged).toHaveBeenCalled()
  })
})
