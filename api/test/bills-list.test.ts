import { describe, expect, it } from 'vitest'
import { call, createBill, createHome } from './helpers'

type ListedShare = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
type ListedBill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: ListedShare[]
}

function listBills(homeId: string) {
  return call<{ bills: ListedBill[] }>('GET', `/api/homes/${homeId}/bills`)
}

describe('list bills', () => {
  it('returns a JSON 404 for a missing home', async () => {
    const response = await listBills('does-not-exist')

    expect(response).toEqual({ status: 404, body: { error: 'Home not found' } })
  })

  it('returns an empty list for a home without members or bills', async () => {
    const { homeId } = await createHome([])

    expect(await listBills(homeId)).toEqual({ status: 200, body: { bills: [] } })
  })

  it('returns an empty list for a home with members but no bills', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])

    expect(await listBills(homeId)).toEqual({ status: 200, body: { bills: [] } })
  })

  it('returns one bill with its shares, member names and payment state', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra'])
    const created = await createBill(homeId, 1000)
    const firstShare = created.body.shares[0]
    if (!firstShare) throw new Error('missing share')
    const paid = await call<{ paidAt: string }>(
      'POST',
      `/api/bills/${created.body.id}/shares/${firstShare.id}/pay`,
      { headers: { 'Idempotency-Key': crypto.randomUUID() } },
    )

    const response = await listBills(homeId)

    expect(response).toEqual({
      status: 200,
      body: {
        bills: [
          {
            id: created.body.id,
            homeId,
            title: 'Electricity',
            totalCents: 1000,
            shares: [
              {
                id: firstShare.id,
                memberId: members[0]?.id,
                memberName: 'Asha',
                amountCents: 334,
                paidAt: paid.body.paidAt,
              },
              {
                id: created.body.shares[1]?.id,
                memberId: members[1]?.id,
                memberName: 'Ben',
                amountCents: 333,
                paidAt: null,
              },
              {
                id: created.body.shares[2]?.id,
                memberId: members[2]?.id,
                memberName: 'Chitra',
                amountCents: 333,
                paidAt: null,
              },
            ],
          },
        ],
      },
    })
  })

  it('lists several bills newest first', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const first = await createBill(homeId, 100)
    const second = await createBill(homeId, 200)
    const third = await createBill(homeId, 300)

    const response = await listBills(homeId)

    expect(response.body.bills.map((bill) => bill.id)).toEqual([
      third.body.id,
      second.body.id,
      first.body.id,
    ])
    expect(response.body.bills.map((bill) => bill.totalCents)).toEqual([300, 200, 100])
    expect(response.body.bills.every((bill) => bill.shares.length === 2)).toBe(true)
  })

  it('orders shares by member insertion order, not by name', async () => {
    const { homeId, members } = await createHome(['Zed', 'Asha', 'Mo'])
    await createBill(homeId, 5)

    const [bill] = (await listBills(homeId)).body.bills

    expect(bill?.shares.map((share) => share.memberId)).toEqual(members.map((m) => m.id))
    expect(bill?.shares.map((share) => share.memberName)).toEqual(['Zed', 'Asha', 'Mo'])
    expect(bill?.shares.map((share) => share.amountCents)).toEqual([2, 2, 1])
  })

  it('never includes bills or shares from another home', async () => {
    const mine = await createHome(['Asha'])
    const other = await createHome(['Ben', 'Chitra'])
    const myBill = await createBill(mine.homeId, 500)
    await createBill(other.homeId, 900)

    const response = await listBills(mine.homeId)

    expect(response.body.bills.map((bill) => bill.id)).toEqual([myBill.body.id])
    expect(response.body.bills[0]?.shares.map((share) => share.memberName)).toEqual(['Asha'])
  })
})
