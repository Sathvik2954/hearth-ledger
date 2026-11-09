// Shapes of the API responses the page uses. api.ts checks every response against these
// at runtime, so a malformed body becomes an error instead of a crash.

export type Home = { id: string; name: string }

export type Member = { id: string; homeId: string; name: string }

export type BillShare = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}

export type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: BillShare[]
}

export type PaidShare = { id: string; memberId: string; amountCents: number; paidAt: string }

export type Balance = { memberId: string; name: string; outstandingCents: number }
