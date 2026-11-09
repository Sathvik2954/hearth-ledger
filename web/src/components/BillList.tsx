import { formatCents, formatTimestamp } from '../lib/money'
import type { Bill, BillShare } from '../lib/types'

export type PaymentState = { pending: boolean; error: string | null }

type Props = {
  bills: Bill[]
  payments: Record<string, PaymentState>
  canCreate: boolean
  onPay: (billId: string, shareId: string) => void
  onCreateFirst: () => void
}

export function BillList({ bills, payments, canCreate, onPay, onCreateFirst }: Props) {
  if (bills.length === 0) {
    return (
      <section className="card empty-state" aria-labelledby="bills-heading">
        <h2 id="bills-heading">Bills</h2>
        <p className="empty-text">No bills yet. Each bill is split equally between members.</p>
        {canCreate && (
          <button type="button" className="button button--primary" onClick={onCreateFirst}>
            Create the first bill
          </button>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby="bills-heading">
      <h2 id="bills-heading" className="section-heading">
        Bills
      </h2>
      <ul className="bill-list">
        {bills.map((bill) => (
          <li key={bill.id}>
            <BillCard bill={bill} payments={payments} onPay={onPay} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function BillCard({
  bill,
  payments,
  onPay,
}: {
  bill: Bill
  payments: Record<string, PaymentState>
  onPay: (billId: string, shareId: string) => void
}) {
  const paidCount = bill.shares.filter((share) => share.paidAt !== null).length
  const outstanding = bill.shares.reduce(
    (sum, share) => (share.paidAt === null ? sum + share.amountCents : sum),
    0,
  )
  const settled = paidCount === bill.shares.length

  return (
    <article className="card bill">
      <header className="bill__header">
        <div>
          <h3 className="bill__title">{bill.title}</h3>
          <p className="bill__meta">
            {paidCount} of {bill.shares.length} paid
            {!settled && <> · {formatCents(outstanding)} outstanding</>}
          </p>
        </div>
        <div className="bill__total">
          <span className="amount amount--large">{formatCents(bill.totalCents)}</span>
          {settled && <span className="badge badge--paid">Settled</span>}
        </div>
      </header>
      <ul className="share-list">
        {bill.shares.map((share) => (
          <ShareRow
            key={share.id}
            share={share}
            payment={payments[share.id]}
            onPay={() => onPay(bill.id, share.id)}
          />
        ))}
      </ul>
    </article>
  )
}

function ShareRow({
  share,
  payment,
  onPay,
}: {
  share: BillShare
  payment: PaymentState | undefined
  onPay: () => void
}) {
  const paid = share.paidAt !== null
  const pending = payment?.pending ?? false
  const error = payment?.error ?? null

  return (
    <li className={`share ${paid ? 'share--paid' : 'share--unpaid'}`}>
      <span className="share__name">{share.memberName}</span>
      <span className="amount">{formatCents(share.amountCents)}</span>
      <span className="share__status">
        {share.paidAt !== null ? (
          <span className="badge badge--paid">
            Paid <time dateTime={share.paidAt}>{formatTimestamp(share.paidAt)}</time>
          </span>
        ) : (
          <>
            <span className="badge badge--unpaid">Unpaid</span>
            <button
              type="button"
              className="button button--small button--primary"
              onClick={onPay}
              disabled={pending}
              aria-label={`${error ? 'Retry payment' : 'Pay'} ${formatCents(share.amountCents)} for ${share.memberName}`}
            >
              {pending ? 'Paying…' : error ? 'Retry' : 'Pay'}
            </button>
          </>
        )}
      </span>
      {!paid && error && (
        <p className="share__error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
