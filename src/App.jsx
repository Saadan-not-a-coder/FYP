import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// ── Supabase connection ──────────────────────────────────────────────────────
const supabaseUrl = 'https://bcnhsbkznrebqchaihbo.supabase.co'
const supabaseKey = 'sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl'
const supabase = createClient(supabaseUrl, supabaseKey)

// ── Risk thresholds (must match ml_service.py _risk_status) ─────────────────
const CRITICAL_THRESHOLD = 1.85
const WARNING_THRESHOLD  = 1.65

// ── Financial derivation from stored columns ─────────────────────────────────
// Identity: ROP = µ_d * µ_L + SS  →  µ_d = (ROP − SS) / µ_L
// Cost of risk = σ_L * µ_d * unit_price   (aligns with badge ranking)
// Capital locked = SS * unit_price
// Stockout / day = µ_d * unit_price
function financials(order) {
  const price  = Number(order.unit_price)        || 0
  const ss     = Number(order.safety_stock)      || 0
  const muL    = Number(order.predicted_mu_l)    || 0
  const sigmaL = Number(order.predicted_sigma_l) || 0
  const rop    = Number(order.reorder_point)      || 0

  // Guard: if muL is 0 or rop/ss look like pre-3.1 stale data, return nulls
  // so the UI can show a "needs recompute" indicator instead of wrong money.
  if (muL <= 0 || rop <= 0) {
    return { capitalLocked: null, stockoutPerDay: null, costOfRisk: null, stale: true }
  }

  const muD = Math.max((rop - ss) / muL, 0)
  return {
    capitalLocked:   ss     * price,
    stockoutPerDay:  muD    * price,
    costOfRisk:      sigmaL * muD * price,
    stale: false,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatMoney(value) {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function riskStatus(sigmaL) {
  if (sigmaL > CRITICAL_THRESHOLD) return 'CRITICAL'
  if (sigmaL > WARNING_THRESHOLD)  return 'WARNING'
  return 'NORMAL'
}

const STATUS_STYLE = {
  CRITICAL: { backgroundColor: '#fee2e2', color: '#991b1b' },
  WARNING:  { backgroundColor: '#fef9c3', color: '#854d0e' },
  NORMAL:   { backgroundColor: '#dcfce7', color: '#166534' },
}

function RiskBadge({ sigmaL }) {
  const status = riskStatus(sigmaL)
  return (
    <span style={{
      ...STATUS_STYLE[status],
      padding: '3px 10px',
      borderRadius: '9999px',
      fontWeight: '600',
      fontSize: '12px',
      whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ── Summary bar ──────────────────────────────────────────────────────────────
function SummaryBar({ orders }) {
  const critical   = orders.filter(o => riskStatus(o.predicted_sigma_l) === 'CRITICAL').length
  const warning    = orders.filter(o => riskStatus(o.predicted_sigma_l) === 'WARNING').length
  const totalRisk  = orders.reduce((sum, o) => {
    const m = financials(o)
    return sum + (m.costOfRisk ?? 0)
  }, 0)
  const totalBuffer = orders.reduce((sum, o) => {
    const m = financials(o)
    return sum + (m.capitalLocked ?? 0)
  }, 0)

  const card = (label, value, accent) => (
    <div style={{
      flex: '1 1 180px',
      backgroundColor: '#fff',
      border: `1px solid ${accent}33`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: '8px',
      padding: '16px 20px',
    }}>
      <div style={{ fontSize: '22px', fontWeight: '700', color: accent }}>{value}</div>
      <div style={{ fontSize: '13px', color: '#64748b', marginTop: '2px' }}>{label}</div>
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '28px' }}>
      {card('Total orders shown',  orders.length,          '#3b82f6')}
      {card('Critical vendors',    critical,               '#dc2626')}
      {card('Warning vendors',     warning,                '#d97706')}
      {card('Total revenue at risk', formatMoney(totalRisk), '#7c3aed')}
      {card('Capital locked in buffer', formatMoney(totalBuffer), '#0891b2')}
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [orders,  setOrders]  = useState([])
  const [loading, setLoading] = useState(true)
  const [filter,  setFilter]  = useState('ALL')   // ALL | CRITICAL | WARNING | NORMAL
  const [search,  setSearch]  = useState('')

  useEffect(() => { fetchOrders() }, [])

  async function fetchOrders() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('po_id,vendor_id,sku_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,safety_stock,reorder_point,risk_status,unit_price')
        .gt('safety_stock', 0)           // only ML-processed rows
        .order('predicted_sigma_l', { ascending: false })
        .limit(500)

      if (error) throw error
      setOrders(data || [])
    } catch (err) {
      console.error('Supabase error:', err.message)
      alert('Database error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  // Client-side filter + search
  const visible = orders.filter(o => {
    const status = riskStatus(o.predicted_sigma_l)
    if (filter !== 'ALL' && status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        String(o.po_id).includes(q) ||
        String(o.vendor_id).toLowerCase().includes(q) ||
        String(o.sku_id).toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div style={{ padding: '36px 40px', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '1440px', margin: '0 auto', color: '#0f172a' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ margin: '0 0 6px', fontSize: '24px', fontWeight: '700' }}>
          Supply Chain Risk Dashboard
        </h1>
        <p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>
          Order-level lead-time variance · risk-adjusted safety stock · financial cost of delay
        </p>
      </div>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading data from cloud…</p>
      ) : orders.length === 0 ? (
        <div style={{ padding: '20px', backgroundColor: '#fff7ed', color: '#9a3412', borderRadius: '8px', border: '1px solid #fed7aa' }}>
          <strong>No processed data found.</strong>&nbsp;
          Run the ML pipeline first: <code>python run_all_orders.py</code>
        </div>
      ) : (
        <>
          {/* ── Summary cards ── */}
          <SummaryBar orders={orders} />

          {/* ── Toolbar: filter tabs + search ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
            {['ALL', 'CRITICAL', 'WARNING', 'NORMAL'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '6px 16px',
                borderRadius: '6px',
                border: '1px solid',
                cursor: 'pointer',
                fontWeight: filter === f ? '700' : '400',
                fontSize: '13px',
                borderColor: filter === f ? '#3b82f6' : '#cbd5e1',
                backgroundColor: filter === f ? '#eff6ff' : '#fff',
                color: filter === f ? '#1d4ed8' : '#475569',
              }}>
                {f}
              </button>
            ))}
            <input
              type="text"
              placeholder="Search PO / Vendor / SKU…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                marginLeft: 'auto',
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '13px',
                width: '220px',
                outline: 'none',
              }}
            />
            <span style={{ fontSize: '13px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
              {visible.length} / {orders.length} rows
            </span>
          </div>

          {/* ── Data table ── */}
          <div style={{ overflowX: 'auto', borderRadius: '10px', border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,.05)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' }}>
              <thead>
                <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                  {['PO ID', 'Vendor ID', 'SKU ID', 'Actual LT', 'Pred. µ_L', 'Pred. σ_L', 'Safety Stock', 'Reorder Point', 'Financial Impact', 'Risk'].map(h => (
                    <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontWeight: '600', color: '#475569', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((order, i) => {
                  const money  = financials(order)
                  const status = riskStatus(order.predicted_sigma_l)
                  const rowBg  = status === 'CRITICAL'
                    ? (i % 2 === 0 ? '#fff5f5' : '#fff8f8')
                    : i % 2 === 0 ? '#ffffff' : '#f8fafc'

                  return (
                    <tr key={order.po_id} style={{ backgroundColor: rowBg, borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '11px 14px', fontWeight: '500', fontFamily: 'monospace' }}>{order.po_id}</td>
                      <td style={{ padding: '11px 14px' }}>{order.vendor_id}</td>
                      <td style={{ padding: '11px 14px', color: '#64748b' }}>{order.sku_id}</td>
                      <td style={{ padding: '11px 14px' }}>
                        {order.actual_lead_time != null ? `${order.actual_lead_time} days` : '—'}
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        {order.predicted_mu_l != null ? Number(order.predicted_mu_l).toFixed(2) : '—'}
                      </td>
                      <td style={{ padding: '11px 14px', fontWeight: '600' }}>
                        {order.predicted_sigma_l != null ? Number(order.predicted_sigma_l).toFixed(4) : '—'}
                      </td>
                      <td style={{ padding: '11px 14px', fontWeight: '600' }}>
                        {order.safety_stock} units
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        {order.reorder_point != null ? `${order.reorder_point} units` : '—'}
                      </td>

                      {/* ── Financial Impact cell ── */}
                      <td style={{ padding: '11px 14px' }}>
                        {money.stale ? (
                          <span style={{ color: '#94a3b8', fontSize: '12px' }}>needs recompute</span>
                        ) : (
                          <>
                            <div style={{ fontWeight: '700', color: money.costOfRisk > 0 ? '#7c3aed' : '#64748b' }}>
                              {formatMoney(money.costOfRisk)} at risk
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: '11.5px', marginTop: '2px' }}>
                              Buffer&nbsp;{formatMoney(money.capitalLocked)}
                              &nbsp;·&nbsp;
                              stockout&nbsp;{formatMoney(money.stockoutPerDay)}/day
                            </div>
                          </>
                        )}
                      </td>

                      <td style={{ padding: '11px 14px' }}>
                        <RiskBadge sigmaL={order.predicted_sigma_l} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {visible.length === 0 && (
              <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>
                No orders match the current filter.
              </div>
            )}
          </div>

          {/* ── Footer note ── */}
          <p style={{ marginTop: '16px', fontSize: '12px', color: '#94a3b8' }}>
            Financial impact formula:&nbsp;
            <em>Cost of risk = σ_L × µ_d × unit_price</em>&nbsp;·&nbsp;
            <em>Capital locked = SS × unit_price</em>&nbsp;·&nbsp;
            µ_d derived as (ROP − SS) / µ_L
          </p>
        </>
      )}
    </div>
  )
}
