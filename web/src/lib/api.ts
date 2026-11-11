import { type CurrencyCode, isCurrencyCode } from './money'
import type { Balance, Bill, BillShare, Home, Member, PaidShare } from './types'

export const REQUEST_TIMEOUT_MS = 10_000

type ErrorKind = 'http' | 'network' | 'timeout' | 'invalid' | 'cancelled'

// Every failure the page can see. `message` is always safe to show to a user.
export class ApiError extends Error {
  readonly kind: ErrorKind
  readonly status: number | null

  constructor(kind: ErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError('invalid', 'Something unexpected went wrong.')
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

// Shared fetch helper: adds a timeout, turns network/HTTP/JSON problems into ApiError, and
// validates the success body with `parse` (which returns null for an unexpected shape).
async function request<T>(
  path: string,
  parse: (body: unknown) => T | null,
  options: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel)

  let status: number
  let text: string
  try {
    if (options.signal?.aborted) controller.abort()
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    status = response.status
    text = await response.text()
  } catch {
    if (timedOut) {
      throw new ApiError(
        'timeout',
        `The server took longer than ${REQUEST_TIMEOUT_MS / 1000} seconds to respond.`,
      )
    }
    if (options.signal?.aborted) throw new ApiError('cancelled', 'Request cancelled.')
    throw new ApiError('network', 'Could not reach the server. Check your connection.')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }

  const body = parseJson(text)
  if (status < 200 || status >= 300) {
    throw new ApiError('http', errorMessage(status, body), status)
  }
  const parsed = parse(body)
  if (parsed === null) {
    throw new ApiError('invalid', 'The server sent a response this page did not understand.')
  }
  return parsed
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorMessage(status: number, body: unknown): string {
  // 5xx bodies are never shown: they may come from a proxy or contain internals.
  if (status >= 500) return 'The server had a problem. Please try again.'
  if (isRecord(body) && typeof body.error === 'string' && body.error.length > 0) {
    return body.error
  }
  return `Request failed (HTTP ${status}).`
}

// --- response validation ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseList<T>(value: unknown, item: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const items: T[] = []
  for (const entry of value) {
    const parsed = item(entry)
    if (parsed === null) return null
    items.push(parsed)
  }
  return items
}

// An unknown currency is a malformed response, never a silent fallback to another symbol.
function parseHome(v: unknown): Home | null {
  return isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    isCurrencyCode(v.currency)
    ? { id: v.id, name: v.name, currency: v.currency }
    : null
}

function parseCreatedHome(v: unknown): { id: string; name: string } | null {
  return isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string'
    ? { id: v.id, name: v.name }
    : null
}

function parseMember(v: unknown): Member | null {
  return isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.homeId === 'string' &&
    typeof v.name === 'string'
    ? { id: v.id, homeId: v.homeId, name: v.name }
    : null
}

function parseBillShare(v: unknown): BillShare | null {
  return isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.memberId === 'string' &&
    typeof v.memberName === 'string' &&
    isCents(v.amountCents) &&
    (v.paidAt === null || typeof v.paidAt === 'string')
    ? {
        id: v.id,
        memberId: v.memberId,
        memberName: v.memberName,
        amountCents: v.amountCents,
        paidAt: v.paidAt,
      }
    : null
}

function parseBill(v: unknown): Bill | null {
  if (
    !isRecord(v) ||
    typeof v.id !== 'string' ||
    typeof v.homeId !== 'string' ||
    typeof v.title !== 'string' ||
    !isCents(v.totalCents)
  ) {
    return null
  }
  const shares = parseList(v.shares, parseBillShare)
  return shares && { id: v.id, homeId: v.homeId, title: v.title, totalCents: v.totalCents, shares }
}

function parsePaidShare(v: unknown): PaidShare | null {
  return isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.memberId === 'string' &&
    isCents(v.amountCents) &&
    typeof v.paidAt === 'string'
    ? { id: v.id, memberId: v.memberId, amountCents: v.amountCents, paidAt: v.paidAt }
    : null
}

function parseBalance(v: unknown): Balance | null {
  return isRecord(v) &&
    typeof v.memberId === 'string' &&
    typeof v.name === 'string' &&
    isCents(v.outstandingCents)
    ? { memberId: v.memberId, name: v.name, outstandingCents: v.outstandingCents }
    : null
}

function parseCreatedId(v: unknown): string | null {
  return isRecord(v) && typeof v.id === 'string' ? v.id : null
}

// --- endpoints ---------------------------------------------------------------------------

// The response is { id, name } only; the dashboard reads the currency via getHome.
export function createHome(
  name: string,
  currency: CurrencyCode,
): Promise<{ id: string; name: string }> {
  return request('/api/homes', parseCreatedHome, { method: 'POST', body: { name, currency } })
}

export function getHome(homeId: string, signal?: AbortSignal): Promise<Home> {
  return request(`/api/homes/${encodeURIComponent(homeId)}`, parseHome, { signal })
}

export function addMember(homeId: string, name: string): Promise<Member> {
  return request(`/api/homes/${encodeURIComponent(homeId)}/members`, parseMember, {
    method: 'POST',
    body: { name },
  })
}

// Returns the new bill's id; the page reloads the list to show it with member names.
export function createBill(homeId: string, title: string, totalCents: number): Promise<string> {
  return request(`/api/homes/${encodeURIComponent(homeId)}/bills`, parseCreatedId, {
    method: 'POST',
    body: { title, totalCents },
  })
}

export function payShare(billId: string, shareId: string, idempotencyKey: string) {
  return request(
    `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
    parsePaidShare,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
  )
}

export function getBills(homeId: string, signal?: AbortSignal): Promise<Bill[]> {
  return request(
    `/api/homes/${encodeURIComponent(homeId)}/bills`,
    (body) => (isRecord(body) ? parseList(body.bills, parseBill) : null),
    { signal },
  )
}

export function getBalances(homeId: string, signal?: AbortSignal): Promise<Balance[]> {
  return request(
    `/api/homes/${encodeURIComponent(homeId)}/balances`,
    (body) => (isRecord(body) ? parseList(body.balances, parseBalance) : null),
    { signal },
  )
}
