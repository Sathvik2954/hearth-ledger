// localStorage can be missing, full or blocked (private mode), so every access is guarded
// and the page keeps working without it.

const HOME_KEY = 'hearth-ledger:home'
const PAYMENT_KEYS_KEY = 'hearth-ledger:payment-keys'

export type SavedHome = { id: string; name: string | null }

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not persisted; the in-memory state still works for this session.
  }
}

export function loadSavedHome(): SavedHome | null {
  const value = read(HOME_KEY)
  if (typeof value !== 'object' || value === null || !('id' in value)) return null
  const id = value.id
  const name = 'name' in value ? value.name : null
  return typeof id === 'string' && id.length > 0
    ? { id, name: typeof name === 'string' ? name : null }
    : null
}

export function saveHome(home: SavedHome | null) {
  write(HOME_KEY, home)
}

// --- payment idempotency keys ----------------------------------------------------------
// One key per share, kept until the server confirms the share is paid. A timeout or a
// lost response may hide a payment that succeeded, so the retry must reuse the same key;
// keeping keys in localStorage makes that hold across a page reload too.

const memoryKeys = new Map<string, string>()

function storedKeys(): Record<string, string> {
  const value = read(PAYMENT_KEYS_KEY)
  const keys: Record<string, string> = {}
  if (typeof value === 'object' && value !== null) {
    for (const [shareId, key] of Object.entries(value)) {
      if (typeof key === 'string') keys[shareId] = key
    }
  }
  return keys
}

export function paymentKeyFor(shareId: string): string {
  const existing = memoryKeys.get(shareId) ?? storedKeys()[shareId]
  if (existing) {
    memoryKeys.set(shareId, existing)
    return existing
  }
  const key = crypto.randomUUID()
  memoryKeys.set(shareId, key)
  write(PAYMENT_KEYS_KEY, { ...storedKeys(), [shareId]: key })
  return key
}

export function forgetPaymentKeys(shareIds: readonly string[]) {
  const keys = storedKeys()
  let changed = false
  for (const shareId of shareIds) {
    memoryKeys.delete(shareId)
    if (shareId in keys) {
      delete keys[shareId]
      changed = true
    }
  }
  if (changed) write(PAYMENT_KEYS_KEY, Object.keys(keys).length > 0 ? keys : null)
}
