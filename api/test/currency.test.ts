import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Balance, type Bill, call, type Member, type Share } from './helpers'

type Home = { id: string; name: string; currency: string }

async function createHome(body: Record<string, unknown>) {
  return call<Home>('POST', '/api/homes', { body })
}

async function storedCurrency(homeId: string) {
  const row = await env.DB.prepare('SELECT currency FROM homes WHERE id = ?1')
    .bind(homeId)
    .first<{ currency: string }>()
  return row?.currency
}

describe('home currency', () => {
  it('defaults to INR when currency is omitted', async () => {
    const created = await createHome({ name: 'Flat 4B' })

    expect(created.status).toBe(201)
    expect(created.body).toEqual({ id: expect.any(String), name: 'Flat 4B' })
    expect(await storedCurrency(created.body.id)).toBe('INR')
    const fetched = await call<Home>('GET', `/api/homes/${created.body.id}`)
    expect(fetched.body).toEqual({ id: created.body.id, name: 'Flat 4B', currency: 'INR' })
  })

  it.each(['INR', 'USD', 'EUR', 'GBP', 'AED'])('creates a home in %s', async (currency) => {
    const created = await createHome({ name: 'Flat 4B', currency })

    expect(created.status).toBe(201)
    // The create response keeps the assignment's exact { id, name } shape.
    expect(created.body).toEqual({ id: expect.any(String), name: 'Flat 4B' })
    expect(await storedCurrency(created.body.id)).toBe(currency)

    const fetched = await call<Home>('GET', `/api/homes/${created.body.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body).toEqual({ id: created.body.id, name: 'Flat 4B', currency })
  })

  it.each<{ case: string; currency: unknown }>([
    { case: 'unsupported code', currency: 'JPY' },
    { case: 'unknown code', currency: 'XYZ' },
    { case: 'lowercase code', currency: 'inr' },
    { case: 'padded code', currency: ' INR' },
    { case: 'symbol', currency: '₹' },
    { case: 'empty string', currency: '' },
    { case: 'null', currency: null },
    { case: 'number', currency: 356 },
    { case: 'array', currency: ['INR'] },
  ])('rejects a $case with 422 and creates nothing', async ({ currency }) => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM homes').first<{ n: number }>()

    const created = await createHome({ name: 'Flat 4B', currency })

    expect(created.status).toBe(422)
    expect(created.body).toEqual({ error: 'currency must be one of INR, USD, EUR, GBP, AED' })
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM homes').first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
  })

  it('still validates the name before anything else', async () => {
    const created = await createHome({ name: '  ', currency: 'USD' })

    expect(created.status).toBe(422)
    expect(created.body).toEqual({ error: 'name must not be empty' })
  })

  it('returns a JSON 404 for an unknown home', async () => {
    const fetched = await call('GET', '/api/homes/does-not-exist')

    expect(fetched.status).toBe(404)
    expect(fetched.body).toEqual({ error: 'Home not found' })
  })

  it('enforces homes_currency_supported in the database', async () => {
    const insert = env.DB.prepare(
      "INSERT INTO homes (id, name, currency) VALUES ('h-bad', 'Bad', 'JPY')",
    ).run()

    await expect(insert).rejects.toThrow(/homes_currency_supported|CHECK constraint failed/)
  })

  it.each(['INR', 'AED'])(
    'splits, pays and balances in %s homes exactly as before',
    async (currency) => {
      const home = await createHome({ name: 'Flat 4B', currency })
      const members: Member[] = []
      for (const name of ['Asha', 'Ben', 'Chitra']) {
        const member = await call<Member>('POST', `/api/homes/${home.body.id}/members`, {
          body: { name },
        })
        members.push(member.body)
      }

      // 1000.50 in the home's currency = 100050 minor units.
      const bill = await call<Bill>('POST', `/api/homes/${home.body.id}/bills`, {
        body: { title: 'Rent', totalCents: 100050 },
      })
      expect(bill.status).toBe(201)
      expect(bill.body.shares.map((s) => s.amountCents)).toEqual([33350, 33350, 33350])

      const odd = await call<Bill>('POST', `/api/homes/${home.body.id}/bills`, {
        body: { title: 'Wifi', totalCents: 1000 },
      })
      expect(odd.body.shares.map((s) => s.amountCents)).toEqual([334, 333, 333])

      const first = bill.body.shares[0]
      if (!first) throw new Error('expected a share')
      const path = `/api/bills/${bill.body.id}/shares/${first.id}/pay`
      const [a, b] = await Promise.all([
        call<Share>('POST', path, { headers: { 'Idempotency-Key': 'k-1' } }),
        call<Share>('POST', path, { headers: { 'Idempotency-Key': 'k-2' } }),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      const winner = a.status === 200 ? 'k-1' : 'k-2'
      const replay = await call<Share>('POST', path, { headers: { 'Idempotency-Key': winner } })
      expect(replay.status).toBe(200)
      expect(replay.body).toEqual(a.status === 200 ? a.body : b.body)

      const balances = await call<{ balances: Balance[] }>(
        'GET',
        `/api/homes/${home.body.id}/balances`,
      )
      expect(balances.body).toEqual({
        balances: [
          { memberId: members[0]?.id, name: 'Asha', outstandingCents: 334 },
          { memberId: members[1]?.id, name: 'Ben', outstandingCents: 33350 + 333 },
          { memberId: members[2]?.id, name: 'Chitra', outstandingCents: 33350 + 333 },
        ],
      })
    },
  )
})
