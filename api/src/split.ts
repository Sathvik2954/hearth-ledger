export type SplitShare<Member> = { member: Member; amountCents: number }

// Splits whole cents between `members` (given in insertion order) so that the shares differ
// by at most 1 cent and always sum to `totalCents`. The first `totalCents % members.length`
// members get the extra cent. The output keeps the input order, one share per member.
//
// Integer-only: `%` is exact for integers, and `totalCents - remainder` is divisible by
// the member count, so the division yields an exact integer with no rounding step.
export function splitEvenly<Member>(
  totalCents: number,
  members: readonly Member[],
): SplitShare<Member>[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new RangeError('totalCents must be a non-negative safe integer')
  }
  if (members.length === 0) {
    throw new RangeError('members must not be empty')
  }
  const remainder = totalCents % members.length
  const base = (totalCents - remainder) / members.length
  return members.map((member, i) => ({ member, amountCents: base + (i < remainder ? 1 : 0) }))
}
