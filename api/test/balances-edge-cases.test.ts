import { describe, expect, it } from 'vitest'
import { type Balance, call, createBill, createHome } from './helpers'

function balances(homeId: string) {
  return call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
}

async function outstanding(homeId: string) {
  return (await balances(homeId)).body.balances.map((balance) => balance.outstandingCents)
}

function pay(billId: string, shareId: string) {
  return call('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })
}

describe('balances', () => {
  it('lists every member at 0 before any bill, with exactly the documented fields', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben'])

    const response = await balances(homeId)

    expect(response).toEqual({
      status: 200,
      body: {
        balances: [
          { memberId: members[0]?.id, name: 'Asha', outstandingCents: 0 },
          { memberId: members[1]?.id, name: 'Ben', outstandingCents: 0 },
        ],
      },
    })
  })

  it('reflects one bill', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    await createBill(homeId, 1000)

    expect(await outstanding(homeId)).toEqual([334, 333, 333])
  })

  it('adds up several bills', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    await createBill(homeId, 1000)
    await createBill(homeId, 1001)
    await createBill(homeId, 3)

    expect(await outstanding(homeId)).toEqual([334 + 334 + 1, 333 + 334 + 1, 333 + 333 + 1])
  })

  it('drops a paid share and keeps the member at 0', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const asha = bill.body.shares[0]
    if (!asha) throw new Error('missing share')

    await pay(bill.body.id, asha.id)

    expect(await outstanding(homeId)).toEqual([0, 500])
  })

  it('decreases only by the paid share when other bills stay unpaid', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const rent = await createBill(homeId, 2000)
    await createBill(homeId, 300)
    const benRent = rent.body.shares[1]
    if (!benRent) throw new Error('missing share')

    expect(await outstanding(homeId)).toEqual([1150, 1150])
    await pay(rent.body.id, benRent.id)

    expect(await outstanding(homeId)).toEqual([1150, 150])
  })

  it('is unaffected by zero-value shares', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    const bill = await createBill(homeId, 1)
    const zero = bill.body.shares[2]
    if (!zero) throw new Error('missing share')

    expect(await outstanding(homeId)).toEqual([1, 0, 0])
    await pay(bill.body.id, zero.id)
    expect(await outstanding(homeId)).toEqual([1, 0, 0])
  })

  it('keeps insertion order, not name order', async () => {
    const { homeId, members } = await createHome(['Zed', 'Asha', 'Mo'])
    await createBill(homeId, 5)

    const response = await balances(homeId)

    expect(response.body.balances.map((balance) => balance.memberId)).toEqual(
      members.map((m) => m.id),
    )
    expect(response.body.balances.map((balance) => balance.name)).toEqual(['Zed', 'Asha', 'Mo'])
    expect(response.body.balances.map((balance) => balance.outstandingCents)).toEqual([2, 2, 1])
  })

  it('ignores other homes', async () => {
    const mine = await createHome(['Asha'])
    const other = await createHome(['Ben'])
    await createBill(other.homeId, 9999)

    expect(await outstanding(mine.homeId)).toEqual([0])
    expect(await outstanding(other.homeId)).toEqual([9999])
  })

  it('returns an empty list for a home with no members', async () => {
    const { homeId } = await createHome([])

    expect(await balances(homeId)).toEqual({ status: 200, body: { balances: [] } })
  })

  it('returns a JSON 404 for a missing home', async () => {
    const response = await call('GET', '/api/homes/does-not-exist/balances')

    expect(response).toEqual({ status: 404, body: { error: 'Home not found' } })
  })
})
