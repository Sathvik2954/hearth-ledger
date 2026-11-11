import { useCallback, useEffect, useState } from 'react'
import { type ApiError, getBalances, getBills, getHome, toApiError } from './api'
import type { Balance, Bill, Home, PaidShare } from './types'

// `home` carries the currency every amount on the dashboard is formatted with.
export type HomeData = { home: Home; bills: Bill[]; balances: Balance[] }

export type HomeDataState = {
  data: HomeData | null
  // Latest load failure. With data present it means "showing older data".
  error: ApiError | null
  loading: boolean
  reload: () => void
  applyPaidShare: (billId: string, paid: PaidShare) => void
}

// Loads the home, its bills and balances together. Each load aborts the previous one, and a
// result is only applied if its request was not aborted, so a slow old response can never
// overwrite newer data. The dashboard is keyed by home id, so switching homes starts fresh.
export function useHomeData(homeId: string): HomeDataState {
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the reload trigger.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    Promise.all([
      getHome(homeId, controller.signal),
      getBills(homeId, controller.signal),
      getBalances(homeId, controller.signal),
    ])
      .then(([home, bills, balances]) => {
        if (controller.signal.aborted) return
        setData({ home, bills, balances })
        setError(null)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(toApiError(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [homeId, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])

  // Shows a server-confirmed payment immediately, before the follow-up reload lands.
  const applyPaidShare = useCallback((billId: string, paid: PaidShare) => {
    setData(
      (current) =>
        current && {
          ...current,
          bills: current.bills.map((bill) =>
            bill.id !== billId
              ? bill
              : {
                  ...bill,
                  shares: bill.shares.map((share) =>
                    share.id === paid.id ? { ...share, paidAt: paid.paidAt } : share,
                  ),
                },
          ),
        },
    )
  }, [])

  return { data, error, loading, reload, applyPaidShare }
}
