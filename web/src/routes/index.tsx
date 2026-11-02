import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { api } from '../api'
import type { Balance, Bill, Member, Share } from '../types'

export const Route = createFileRoute('/')({
  component: App,
})

// ---------------------------------------------------------------------------
// localStorage helpers — wrapped in try/catch; SSR / private-mode safe
// ---------------------------------------------------------------------------

const LS_KEY = 'bill-splitter-last-home-id'

function saveHomeId(id: string): void {
  try {
    localStorage.setItem(LS_KEY, id)
  } catch {
    // storage unavailable — silently ignore
  }
}

function loadSavedHomeId(): string | null {
  try {
    return localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

function clearHomeId(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    // ignore
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Local bill state — shares carry per-share UI state (paying / payError)
// ---------------------------------------------------------------------------

type LocalShare = Share & { payError: string | null; paying: boolean }
type LocalBill = Omit<Bill, 'shares'> & { shares: LocalShare[] }

type BillAction =
  | { type: 'set'; bills: Bill[] }
  | { type: 'paying'; billId: string; shareId: string }
  | { type: 'paid'; billId: string; shareId: string; share: Share }
  | { type: 'payError'; billId: string; shareId: string; error: string }

function toLocal(bill: Bill): LocalBill {
  return {
    ...bill,
    shares: bill.shares.map((s) => ({ ...s, payError: null, paying: false })),
  }
}

function billsReducer(state: LocalBill[], action: BillAction): LocalBill[] {
  switch (action.type) {
    case 'set':
      return action.bills.map(toLocal)
    case 'paying':
      return state.map((b) =>
        b.id !== action.billId
          ? b
          : {
              ...b,
              shares: b.shares.map((s) =>
                s.id !== action.shareId ? s : { ...s, paying: true, payError: null },
              ),
            },
      )
    case 'paid':
      return state.map((b) =>
        b.id !== action.billId
          ? b
          : {
              ...b,
              shares: b.shares.map((s) =>
                s.id !== action.shareId ? s : { ...action.share, paying: false, payError: null },
              ),
            },
      )
    case 'payError':
      return state.map((b) =>
        b.id !== action.billId
          ? b
          : {
              ...b,
              shares: b.shares.map((s) =>
                s.id !== action.shareId ? s : { ...s, paying: false, payError: action.error },
              ),
            },
      )
  }
}

// ---------------------------------------------------------------------------
// BillCard
// ---------------------------------------------------------------------------

function BillCard({
  bill,
  memberMap,
  onPay,
}: {
  bill: LocalBill
  memberMap: Map<string, string>
  onPay: (billId: string, shareId: string) => void
}) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{bill.title}</strong>
        <span style={{ color: '#555' }}>{formatCents(bill.totalCents)} total</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={th}>Member</th>
            <th style={th}>Amount</th>
            <th style={th}>Status</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {bill.shares.map((share) => {
            const paid = share.paidAt !== null
            return (
              <tr key={share.id} style={{ opacity: paid ? 0.6 : 1 }}>
                <td style={td}>{memberMap.get(share.memberId) ?? share.memberId}</td>
                <td style={td}>{formatCents(share.amountCents)}</td>
                <td style={td}>
                  {paid ? `Paid ${new Date(share.paidAt as string).toLocaleString()}` : 'Unpaid'}
                </td>
                <td style={td}>
                  {!paid && (
                    <button
                      type="button"
                      onClick={() => onPay(bill.id, share.id)}
                      disabled={share.paying}
                      style={btnSmall}
                    >
                      {share.paying ? 'Paying…' : 'Pay'}
                    </button>
                  )}
                  {share.payError && <span style={errorInline}>{share.payError}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CreateHomePanel
// ---------------------------------------------------------------------------

function CreateHomePanel({ onCreated }: { onCreated: (homeId: string) => void }) {
  const [homeName, setHomeName] = useState('')
  const [memberInput, setMemberInput] = useState('')
  const [memberNames, setMemberNames] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addMember() {
    const name = memberInput.trim()
    if (name) {
      setMemberNames((prev) => [...prev, name])
      setMemberInput('')
    }
  }

  async function create() {
    const name = homeName.trim()
    if (!name) return
    setBusy(true)
    setError(null)

    const homeRes = await api.post<{ id: string; name: string }>('/api/homes', { name })
    if (homeRes.error !== null) {
      setError(homeRes.error)
      setBusy(false)
      return
    }

    const homeId = homeRes.data.id
    for (const memberName of memberNames) {
      const mRes = await api.post<Member>(`/api/homes/${homeId}/members`, { name: memberName })
      if (mRes.error !== null) {
        setError(`Home created (${homeId}) but failed to add member "${memberName}": ${mRes.error}`)
        setBusy(false)
        onCreated(homeId)
        return
      }
    }

    setBusy(false)
    onCreated(homeId)
  }

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={{ margin: '0 0 12px' }}>Create a new home</h3>
      {error && <p style={errorBox}>{error}</p>}

      <label style={labelStyle}>
        Home name
        <input
          style={inputStyle}
          value={homeName}
          onChange={(e) => setHomeName(e.target.value)}
          placeholder="e.g. Flat 4B"
        />
      </label>

      <label style={labelStyle}>
        Add members
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={memberInput}
            onChange={(e) => setMemberInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addMember()
            }}
            placeholder="Member name, press Enter"
          />
          <button type="button" onClick={addMember} style={btnSecondary}>
            Add
          </button>
        </div>
      </label>

      {memberNames.length > 0 && (
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          {memberNames.map((n, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static list before submit
            <li key={i}>
              {n}{' '}
              <button
                type="button"
                onClick={() => setMemberNames((prev) => prev.filter((_, j) => j !== i))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c00' }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void create()}
        disabled={busy || homeName.trim() === ''}
        style={btnPrimary}
      >
        {busy ? 'Creating…' : 'Create home'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AddBillPanel
// ---------------------------------------------------------------------------

function AddBillPanel({ homeId, onAdded }: { homeId: string; onAdded: (bill: Bill) => void }) {
  const [title, setTitle] = useState('')
  const [dollars, setDollars] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const totalCents = Math.round(Number.parseFloat(dollars) * 100)
    if (!title.trim() || !Number.isFinite(totalCents) || totalCents <= 0) {
      setError('Enter a valid title and a positive dollar amount.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await api.post<Bill>(`/api/homes/${homeId}/bills`, {
      title: title.trim(),
      totalCents,
    })
    setBusy(false)
    if (res.error !== null) {
      setError(res.error)
      return
    }
    setTitle('')
    setDollars('')
    onAdded(res.data)
  }

  return (
    <div style={{ ...card, background: '#f0f7ff' }}>
      <h3 style={{ margin: '0 0 12px' }}>Add a bill</h3>
      {error && <p style={errorBox}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          style={{ ...inputStyle, flex: 2, minWidth: 120 }}
          placeholder="Title (e.g. Electricity)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 80 }}
          placeholder="Amount ($)"
          value={dollars}
          type="number"
          min="0.01"
          step="0.01"
          onChange={(e) => setDollars(e.target.value)}
        />
        <button type="button" onClick={() => void submit()} disabled={busy} style={btnPrimary}>
          {busy ? 'Adding…' : 'Add bill'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

function App() {
  const [inputId, setInputId] = useState('')
  const [homeId, setHomeId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const [members, setMembers] = useState<Member[]>([])
  const [bills, dispatch] = useReducer(billsReducer, [])
  const [balances, setBalances] = useState<Balance[]>([])

  const [loading, setLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [billsError, setBillsError] = useState<string | null>(null)

  // Ref so async callbacks always see the current homeId without stale closures
  const homeIdRef = useRef<string | null>(null)
  homeIdRef.current = homeId

  const memberMap = new Map(members.map((m) => [m.id, m.name]))

  // Refresh balances from the server
  const refreshBalances = useCallback(async (id: string) => {
    const res = await api.get<{ balances: Balance[] }>(`/api/homes/${id}/balances`)
    if (res.error !== null) {
      setPageError(res.error)
      return
    }
    setBalances(res.data.balances)
  }, [])

  // Load a home by ID — fetches balances (member list + outstanding) and bills in parallel
  const loadHome = useCallback(async (id: string) => {
    setLoading(true)
    setPageError(null)
    setBillsError(null)
    dispatch({ type: 'set', bills: [] })
    setBalances([])
    setMembers([])

    const [balRes, billsRes] = await Promise.all([
      api.get<{ balances: Balance[] }>(`/api/homes/${id}/balances`),
      api.get<{ bills: Bill[] }>(`/api/homes/${id}/bills`),
    ])

    if (balRes.error !== null) {
      setPageError(balRes.error)
      setHomeId(null)
      setLoading(false)
      return
    }

    setBalances(balRes.data.balances)
    setMembers(balRes.data.balances.map((b) => ({ id: b.memberId, homeId: id, name: b.name })))

    if (billsRes.error === null) {
      dispatch({ type: 'set', bills: billsRes.data.bills })
    } else {
      setBillsError(billsRes.error)
    }

    setHomeId(id)
    saveHomeId(id)
    setLoading(false)
  }, [])

  // On mount, auto-load the last home the user opened
  useEffect(() => {
    const saved = loadSavedHomeId()
    if (saved) void loadHome(saved)
  }, [loadHome])

  // Retry only the bills fetch — keeps balances visible
  const retryBills = useCallback(async () => {
    const id = homeIdRef.current
    if (!id) return
    setBillsError(null)
    const res = await api.get<{ bills: Bill[] }>(`/api/homes/${id}/bills`)
    if (res.error !== null) {
      setBillsError(res.error)
      return
    }
    dispatch({ type: 'set', bills: res.data.bills })
  }, [])

  // Pay a share — disables the button while in-flight, shows error on failure
  const handlePay = useCallback(
    async (billId: string, shareId: string) => {
      dispatch({ type: 'paying', billId, shareId })
      const key = crypto.randomUUID()
      const res = await api.post<Share>(`/api/bills/${billId}/shares/${shareId}/pay`, undefined, {
        'Idempotency-Key': key,
      })
      if (res.error !== null) {
        dispatch({ type: 'payError', billId, shareId, error: res.error })
        return
      }
      dispatch({ type: 'paid', billId, shareId, share: res.data })
      const id = homeIdRef.current
      if (id) await refreshBalances(id)
    },
    [refreshBalances],
  )

  // Bill added — append to list and refresh balances
  const handleBillAdded = useCallback(
    (bill: Bill) => {
      dispatch({ type: 'set', bills: [...bills, bill] })
      const id = homeIdRef.current
      if (id) void refreshBalances(id)
    },
    [bills, refreshBalances],
  )

  function closeHome() {
    setHomeId(null)
    setInputId('')
    dispatch({ type: 'set', bills: [] })
    setBalances([])
    setMembers([])
    setPageError(null)
    setBillsError(null)
    setShowCreate(false)
    clearHomeId()
  }

  function handleLookup() {
    const id = inputId.trim()
    if (id) void loadHome(id)
  }

  function handleCreated(id: string) {
    setShowCreate(false)
    setInputId(id)
    void loadHome(id)
  }

  return (
    <main style={page}>
      <h1 style={{ margin: '0 0 4px' }}>🏠 Bill Splitter</h1>
      <p style={{ margin: '0 0 24px', color: '#666' }}>Split household bills between members.</p>

      {/* Home lookup / create */}
      {!homeId && (
        <section style={section}>
          <h2 style={sectionTitle}>Open a home</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              placeholder="Paste a home ID"
              value={inputId}
              onChange={(e) => setInputId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLookup()
              }}
            />
            <button type="button" onClick={handleLookup} style={btnPrimary}>
              Open
            </button>
          </div>

          {pageError && <p style={errorBox}>{pageError}</p>}

          <button type="button" onClick={() => setShowCreate((v) => !v)} style={btnSecondary}>
            {showCreate ? 'Cancel' : '+ Create a new home'}
          </button>

          {showCreate && <CreateHomePanel onCreated={handleCreated} />}
        </section>
      )}

      {/* Loading spinner */}
      {loading && <div style={{ textAlign: 'center', padding: 48, color: '#888' }}>Loading…</div>}

      {/* Home dashboard */}
      {homeId && !loading && (
        <>
          <section style={section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={sectionTitle}>Home: {homeId}</h2>
              <button type="button" onClick={closeHome} style={btnSecondary}>
                ✕ Close
              </button>
            </div>

            {pageError && <p style={errorBox}>{pageError}</p>}

            {members.length === 0 ? (
              <p style={{ color: '#888' }}>No members yet.</p>
            ) : (
              <p style={{ margin: '4px 0 0', color: '#555' }}>
                Members: {members.map((m) => m.name).join(', ')}
              </p>
            )}
          </section>

          <section style={section}>
            <AddBillPanel homeId={homeId} onAdded={handleBillAdded} />
          </section>

          <section style={section}>
            <h2 style={sectionTitle}>Bills</h2>
            {billsError !== null ? (
              <div style={errorBox}>
                <p style={{ margin: '0 0 8px' }}>Could not load bills: {billsError}</p>
                <button type="button" onClick={() => void retryBills()} style={btnSecondary}>
                  Retry
                </button>
              </div>
            ) : bills.length === 0 ? (
              <p style={{ color: '#888' }}>No bills yet — add one above.</p>
            ) : (
              bills.map((bill) => (
                <BillCard key={bill.id} bill={bill} memberMap={memberMap} onPay={handlePay} />
              ))
            )}
          </section>

          <section style={section}>
            <h2 style={sectionTitle}>Balances</h2>
            {balances.length === 0 ? (
              <p style={{ color: '#888' }}>No outstanding balances.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Member</th>
                    <th style={th}>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b) => (
                    <tr key={b.memberId}>
                      <td style={td}>{b.name}</td>
                      <td
                        style={{
                          ...td,
                          fontWeight: b.outstandingCents > 0 ? 'bold' : 'normal',
                          color: b.outstandingCents > 0 ? '#c00' : '#0a0',
                        }}
                      >
                        {formatCents(b.outstandingCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const page: React.CSSProperties = {
  maxWidth: 680,
  margin: '0 auto',
  padding: '32px 16px 64px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 15,
  color: '#111',
}

const section: React.CSSProperties = { marginBottom: 32 }

const sectionTitle: React.CSSProperties = { margin: '0 0 12px', fontSize: 18, fontWeight: 600 }

const card: React.CSSProperties = {
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
  background: '#fff',
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #ccc',
  borderRadius: 6,
  fontSize: 14,
  width: '100%',
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 12,
  fontSize: 14,
  fontWeight: 500,
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 16px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

const btnSecondary: React.CSSProperties = {
  padding: '8px 16px',
  background: '#f3f4f6',
  color: '#111',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  whiteSpace: 'nowrap',
}

const btnSmall: React.CSSProperties = {
  padding: '4px 10px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
}

const errorBox: React.CSSProperties = {
  margin: '8px 0',
  padding: '10px 14px',
  background: '#fef2f2',
  border: '1px solid #fca5a5',
  borderRadius: 6,
  color: '#991b1b',
  fontSize: 14,
}

const errorInline: React.CSSProperties = { color: '#c00', fontSize: 12, marginLeft: 6 }

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  borderBottom: '1px solid #e5e7eb',
  fontSize: 13,
  color: '#555',
  fontWeight: 600,
}

const td: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid #f3f4f6',
  fontSize: 14,
  verticalAlign: 'middle',
}
