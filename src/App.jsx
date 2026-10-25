import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ReferenceLine, Label,
} from 'recharts'

// ── Supabase connection ──────────────────────────────────────────────────────
const supabaseUrl = 'https://bcnhsbkznrebqchaihbo.supabase.co'
const supabaseKey = 'sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl'
const supabase = createClient(supabaseUrl, supabaseKey)

// ── Risk thresholds (must match ml_service.py _risk_status) ─────────────────
const CRITICAL_THRESHOLD = 1.85
const WARNING_THRESHOLD  = 1.65

// ── Cold-start detection (3.4) ───────────────────────────────────────────────
// ml_service.py prefixes risk_status with "COLD_" when a vendor had no
// delivery history at analysis time.  All other logic uses the raw σ_L math.
function isColdStart(order) {
  return typeof order.risk_status === 'string' && order.risk_status.startsWith('COLD_')
}

// ── Financial derivation from stored columns ─────────────────────────────────
// Identity: ROP = µ_d * µ_L + SS  →  µ_d = (ROP − SS) / µ_L
// Cost of risk = σ_L * µ_d * unit_price
function financials(order) {
  const price  = Number(order.unit_price)        || 0
  const ss     = Number(order.safety_stock)      || 0
  const muL    = Number(order.predicted_mu_l)    || 0
  const sigmaL = Number(order.predicted_sigma_l) || 0
  const rop    = Number(order.reorder_point)      || 0
  if (muL <= 0 || rop <= 0) {
    return { capitalLocked: null, stockoutPerDay: null, costOfRisk: null, stale: true }
  }
  const muD = Math.max((rop - ss) / muL, 0)
  return {
    capitalLocked:  ss     * price,
    stockoutPerDay: muD    * price,
    costOfRisk:     sigmaL * muD * price,
    stale: false,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatMoney(value) {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function riskStatus(sigmaL) {
  if (sigmaL > CRITICAL_THRESHOLD) return 'CRITICAL'
  if (sigmaL > WARNING_THRESHOLD)  return 'WARNING'
  return 'NORMAL'
}

const STATUS_COLOR = { CRITICAL: '#dc2626', WARNING: '#d97706', NORMAL: '#16a34a' }
const STATUS_BG    = { CRITICAL: '#fee2e2', WARNING: '#fef9c3', NORMAL: '#dcfce7' }

// RiskBadge shows the severity pill + an optional grey cold-start tag (3.4)
function RiskBadge({ sigmaL, coldStart }) {
  const s = riskStatus(sigmaL)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flexWrap: 'nowrap' }}>
      <span style={{
        backgroundColor: STATUS_BG[s], color: STATUS_COLOR[s],
        padding: '3px 10px', borderRadius: '9999px',
        fontWeight: '600', fontSize: '12px', whiteSpace: 'nowrap',
      }}>
        {s}
      </span>
      {coldStart && (
        <span style={{
          backgroundColor: '#f1f5f9', color: '#64748b',
          padding: '3px 8px', borderRadius: '9999px',
          fontWeight: '500', fontSize: '11px', whiteSpace: 'nowrap',
          border: '1px solid #cbd5e1',
        }}>
          cold-start
        </span>
      )}
    </span>
  )
}

// ── Summary cards ────────────────────────────────────────────────────────────
function SummaryBar({ orders }) {
  const critical   = orders.filter(o => riskStatus(o.predicted_sigma_l) === 'CRITICAL').length
  const warning    = orders.filter(o => riskStatus(o.predicted_sigma_l) === 'WARNING').length
  const coldStarts = orders.filter(isColdStart).length
  const totalRisk  = orders.reduce((s, o) => s + (financials(o).costOfRisk   ?? 0), 0)
  const totalBuffer= orders.reduce((s, o) => s + (financials(o).capitalLocked ?? 0), 0)

  const card = (label, value, accent, dimmed) => (
    <div key={label} style={{
      flex: '1 1 150px', backgroundColor: '#fff',
      border: `1px solid ${accent}33`, borderLeft: `4px solid ${accent}`,
      borderRadius: '8px', padding: '16px 20px',
      opacity: dimmed ? 0.7 : 1,
    }}>
      <div style={{ fontSize: '22px', fontWeight: '700', color: accent }}>{value}</div>
      <div style={{ fontSize: '13px', color: '#64748b', marginTop: '2px' }}>{label}</div>
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '28px' }}>
      {card('Total orders shown',       orders.length,           '#3b82f6')}
      {card('Critical vendors',         critical,                '#dc2626')}
      {card('Warning vendors',          warning,                 '#d97706')}
      {card('Cold-start vendors',       coldStarts,              '#7c3aed', coldStarts === 0)}
      {card('Total revenue at risk',    formatMoney(totalRisk),  '#0891b2')}
      {card('Capital locked in buffer', formatMoney(totalBuffer),'#0f766e')}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3.3 — VENDOR DELIVERY CHARTS
// ═══════════════════════════════════════════════════════════════════════════════

function buildVendorSummary(orders, topN = 20) {
  const map = {}
  for (const o of orders) {
    const vid = o.vendor_id
    if (!map[vid]) {
      map[vid] = {
        vendor_id:  vid,
        sigma_l:    Number(o.predicted_sigma_l) || 0,
        mu_l:       Number(o.predicted_mu_l)    || 0,
        status:     riskStatus(Number(o.predicted_sigma_l)),
        coldStart:  isColdStart(o),
        orderCount: 0,
        totalRisk:  0,
      }
    }
    const m = financials(o)
    map[vid].orderCount++
    map[vid].totalRisk += m.costOfRisk ?? 0
  }
  return Object.values(map)
    .sort((a, b) => b.sigma_l - a.sigma_l)
    .slice(0, topN)
}

function vendorBarColor(status) { return STATUS_COLOR[status] ?? '#94a3b8' }

function ColoredBar(props) {
  const { x, y, width, height, status, coldStart } = props
  if (height <= 0) return null
  // Cold-start bars are shown with a hatched pattern (dashed border style via opacity)
  return (
    <rect
      x={x} y={y} width={width} height={height}
      fill={vendorBarColor(status)}
      fillOpacity={coldStart ? 0.4 : 0.85}
      rx={3}
      strokeDasharray={coldStart ? '4 2' : undefined}
      stroke={coldStart ? vendorBarColor(status) : 'none'}
      strokeWidth={coldStart ? 1.5 : 0}
    />
  )
}

function VendorRankingChart({ orders, onSelect }) {
  const data = buildVendorSummary(orders, 20)
  if (data.length === 0) return null

  const chartData = data.map(d => ({
    name:       String(d.vendor_id),
    sigma_l:    parseFloat(d.sigma_l.toFixed(4)),
    status:     d.status,
    coldStart:  d.coldStart,
    mu_l:       parseFloat(d.mu_l.toFixed(2)),
    orderCount: d.orderCount,
    totalRisk:  d.totalRisk,
  }))

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{
        background: '#1e293b', color: '#f8fafc', padding: '10px 14px',
        borderRadius: '8px', fontSize: '12px', lineHeight: '1.7',
      }}>
        <div style={{ fontWeight: '700', marginBottom: '4px' }}>Vendor {d.name}</div>
        <div>σ_L (std dev): <strong>{d.sigma_l}</strong></div>
        <div>µ_L (mean LT): <strong>{d.mu_l} days</strong></div>
        <div>Orders: <strong>{d.orderCount}</strong></div>
        <div>Revenue at risk: <strong>{formatMoney(d.totalRisk)}</strong></div>
        <div style={{ marginTop: '6px', color: STATUS_COLOR[d.status], fontWeight: '700' }}>{d.status}</div>
        {d.coldStart && (
          <div style={{ color: '#a78bfa', marginTop: '4px', fontSize: '11px' }}>
            ⚠ Cold-start — fleet average in use
          </div>
        )}
        <div style={{ color: '#94a3b8', marginTop: '4px' }}>Click to view delivery history</div>
      </div>
    )
  }

  return (
    <div style={{
      backgroundColor: '#fff', borderRadius: '10px',
      border: '1px solid #e2e8f0', padding: '20px 24px',
      marginBottom: '28px', boxShadow: '0 1px 4px rgba(0,0,0,.05)',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: '700' }}>
          Vendor Risk Ranking — Lead-Time Volatility (σ_L)
        </h2>
        <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
          Top {chartData.length} vendors by σ_L. Faded bars = cold-start (fleet average used). Click any bar to drill into delivery history.
        </p>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={chartData}
          margin={{ top: 10, right: 50, left: 0, bottom: 60 }}
          onClick={e => e?.activePayload?.[0] && onSelect(e.activePayload[0].payload.name)}
          style={{ cursor: 'pointer' }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} angle={-40} textAnchor="end" interval={0} />
          <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={v => v.toFixed(1)}>
            <Label value="σ_L" angle={-90} position="insideLeft" style={{ fontSize: 12, fill: '#94a3b8' }} />
          </YAxis>
          <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f1f5f950' }} />
          <ReferenceLine y={CRITICAL_THRESHOLD} stroke={STATUS_COLOR.CRITICAL} strokeDasharray="4 3"
            label={{ value: 'CRITICAL', position: 'right', fontSize: 10, fill: STATUS_COLOR.CRITICAL }} />
          <ReferenceLine y={WARNING_THRESHOLD} stroke={STATUS_COLOR.WARNING} strokeDasharray="4 3"
            label={{ value: 'WARNING', position: 'right', fontSize: 10, fill: STATUS_COLOR.WARNING }} />
          <Bar dataKey="sigma_l" shape={<ColoredBar />} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Histogram helper ─────────────────────────────────────────────────────────
function buildHistogram(values, bucketSize = 1) {
  if (!values.length) return []
  const min = Math.floor(Math.min(...values))
  const max = Math.ceil(Math.max(...values))
  const buckets = []
  for (let lo = min; lo < max; lo += bucketSize) {
    const hi = lo + bucketSize
    buckets.push({ bucket: `${lo}–${hi}`, count: values.filter(v => v >= lo && v < hi).length })
  }
  if (buckets.length > 0) buckets[buckets.length - 1].count += values.filter(v => v === max).length
  return buckets
}

// ── Vendor Detail Modal (3.3 + 3.4 cold-start notice) ───────────────────────
function VendorModal({ vendorId, onClose, isColdStartVendor }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!vendorId) return
    setLoading(true)
    setError(null)
    supabase
      .from('orders')
      .select('po_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,order_date,risk_status')
      .eq('vendor_id', vendorId)
      .order('order_date', { ascending: true })
      .limit(500)
      .then(({ data, error: err }) => {
        if (err) { setError(err.message); setLoading(false); return }
        const rows = (data || [])
          .filter(r => r.actual_lead_time != null)
          .map((r, i) => ({
            index:  i + 1,
            lt:     Number(r.actual_lead_time),
            po_id:  r.po_id,
            date:   r.order_date ? r.order_date.slice(0, 10) : `#${i + 1}`,
            muL:    Number(r.predicted_mu_l)    || 0,
            sigmaL: Number(r.predicted_sigma_l) || 0,
          }))
        setHistory(rows)
        setLoading(false)
      })
  }, [vendorId])

  const ltValues  = history.map(r => r.lt)
  const muL       = history[0]?.muL   ?? 0
  const sigmaL    = history[0]?.sigmaL ?? 0
  const status    = riskStatus(sigmaL)
  const histogram = buildHistogram(ltValues, 1)

  const TimelineTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{ background: '#1e293b', color: '#f8fafc', padding: '8px 12px', borderRadius: '6px', fontSize: '12px' }}>
        <div>PO: <strong>{d.po_id}</strong></div>
        <div>Date: <strong>{d.date}</strong></div>
        <div>Lead time: <strong>{d.lt} days</strong></div>
      </div>
    )
  }

  const HistTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{ background: '#1e293b', color: '#f8fafc', padding: '8px 12px', borderRadius: '6px', fontSize: '12px' }}>
        <div>Bucket: <strong>{d.bucket} days</strong></div>
        <div>Orders: <strong>{d.count}</strong></div>
      </div>
    )
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15,23,42,0.55)',
      zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor: '#fff', borderRadius: '12px', padding: '28px 32px',
        width: '100%', maxWidth: '860px', maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,.25)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: '700' }}>
              Vendor&nbsp;{vendorId}&nbsp;&nbsp;
              <RiskBadge sigmaL={sigmaL} coldStart={isColdStartVendor} />
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
              µ_L = {muL.toFixed(2)} days · σ_L = {sigmaL.toFixed(4)} · {history.length} deliveries
            </p>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '20px', color: '#94a3b8', lineHeight: 1, padding: '4px',
          }}>✕</button>
        </div>

        {/* 3.4 — Cold-start notice banner */}
        {isColdStartVendor && (
          <div style={{
            backgroundColor: '#faf5ff', border: '1px solid #d8b4fe',
            borderLeft: '4px solid #7c3aed', borderRadius: '8px',
            padding: '12px 16px', marginBottom: '20px', fontSize: '13px', color: '#4c1d95',
          }}>
            <strong>⚠ Cold-start vendor</strong> — No delivery history was available when this
            order was processed. The global fleet-average lead-time statistics
            (µ_L, σ_L) were used as a fallback.
            Safety stock and reorder point are conservative estimates; they will
            automatically sharpen once this vendor accumulates real delivery records
            and you re-run <code>run_all_orders.py</code>.
          </div>
        )}

        {loading && <p style={{ color: '#64748b' }}>Loading delivery history…</p>}
        {error   && <p style={{ color: '#dc2626' }}>Error: {error}</p>}

        {!loading && !error && history.length === 0 && (
          <p style={{ color: '#94a3b8' }}>
            No delivery records with lead-time data found for this vendor.
          </p>
        )}

        {!loading && !error && history.length > 0 && (
          <>
            {/* Stat pills */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
              {[
                ['Mean lead time',    `${muL.toFixed(2)} days`,   STATUS_COLOR[status]],
                ['Std dev (σ_L)',     sigmaL.toFixed(4),          STATUS_COLOR[status]],
                ['Deliveries shown', history.length,              '#3b82f6'],
                ['Min LT',           `${Math.min(...ltValues)} days`, '#64748b'],
                ['Max LT',           `${Math.max(...ltValues)} days`, '#64748b'],
              ].map(([label, val, col]) => (
                <div key={label} style={{
                  flex: '1 1 120px', border: '1px solid #e2e8f0', borderRadius: '8px',
                  padding: '10px 14px', backgroundColor: '#f8fafc',
                }}>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: col }}>{val}</div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Chart 1: Timeline */}
            <h3 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: '600', color: '#374151' }}>
              Lead-Time Timeline
            </h3>
            <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#94a3b8' }}>
              Each dot = one PO delivery. Dashed lines show µ_L ± σ_L.
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <ScatterChart margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="index" type="number" name="Delivery #" tick={{ fontSize: 11 }}>
                  <Label value="Delivery #" position="insideBottom" offset={-2} style={{ fontSize: 11, fill: '#94a3b8' }} />
                </XAxis>
                <YAxis dataKey="lt" type="number" name="Lead time" tick={{ fontSize: 11 }}>
                  <Label value="Days" angle={-90} position="insideLeft" style={{ fontSize: 11, fill: '#94a3b8' }} />
                </YAxis>
                <Tooltip content={<TimelineTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                <ReferenceLine y={muL} stroke="#3b82f6" strokeWidth={1.5}
                  label={{ value: `µ=${muL.toFixed(1)}`, position: 'right', fontSize: 10, fill: '#3b82f6' }} />
                <ReferenceLine y={muL + sigmaL} stroke={STATUS_COLOR[status]} strokeDasharray="4 3"
                  label={{ value: '+σ', position: 'right', fontSize: 10, fill: STATUS_COLOR[status] }} />
                {muL - sigmaL > 0 && (
                  <ReferenceLine y={muL - sigmaL} stroke={STATUS_COLOR[status]} strokeDasharray="4 3"
                    label={{ value: '-σ', position: 'right', fontSize: 10, fill: STATUS_COLOR[status] }} />
                )}
                <Scatter data={history} fill={STATUS_COLOR[status]} fillOpacity={0.7} r={4} />
              </ScatterChart>
            </ResponsiveContainer>

            {/* Chart 2: Distribution histogram */}
            <h3 style={{ margin: '24px 0 4px', fontSize: '14px', fontWeight: '600', color: '#374151' }}>
              Lead-Time Distribution
            </h3>
            <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#94a3b8' }}>
              1-day bins. Wider spread = higher σ_L = more holding cost needed.
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={histogram} margin={{ top: 5, right: 20, left: 0, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0}>
                  <Label value="Lead time (days)" position="insideBottom" offset={-20} style={{ fontSize: 11, fill: '#94a3b8' }} />
                </XAxis>
                <YAxis tick={{ fontSize: 11 }}>
                  <Label value="Orders" angle={-90} position="insideLeft" style={{ fontSize: 11, fill: '#94a3b8' }} />
                </YAxis>
                <Tooltip content={<HistTooltip />} cursor={{ fill: '#f1f5f950' }} />
                <Bar dataKey="count" fill={STATUS_COLOR[status]} fillOpacity={0.8} radius={[3, 3, 0, 0]} maxBarSize={50} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main App
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [orders,         setOrders]         = useState([])
  const [loading,        setLoading]        = useState(true)
  const [filter,         setFilter]         = useState('ALL')
  const [search,         setSearch]         = useState('')
  const [selectedVendor, setSelectedVendor] = useState(null)

  useEffect(() => { fetchOrders() }, [])

  async function fetchOrders() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('po_id,vendor_id,sku_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,safety_stock,reorder_point,risk_status,unit_price')
        .gt('safety_stock', 0)
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

  const openVendor  = useCallback(vid => setSelectedVendor(vid), [])
  const closeVendor = useCallback(() => setSelectedVendor(null), [])

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') closeVendor() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeVendor])

  // Determine if the currently-selected vendor is a cold-start vendor
  // (any of its orders has a COLD_ risk_status)
  const selectedVendorIsColdStart = selectedVendor
    ? orders.some(o => String(o.vendor_id) === selectedVendor && isColdStart(o))
    : false

  // Client-side filter + search
  // 'COLD' filter tab shows only cold-start rows
  const visible = orders.filter(o => {
    if (filter === 'COLD') return isColdStart(o)
    if (filter !== 'ALL' && riskStatus(o.predicted_sigma_l) !== filter) return false
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

      {/* Header */}
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
          <SummaryBar orders={orders} />
          <VendorRankingChart orders={orders} onSelect={openVendor} />

          {/* Toolbar — includes COLD filter tab (3.4) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
            {['ALL', 'CRITICAL', 'WARNING', 'NORMAL', 'COLD'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '6px 16px', borderRadius: '6px', border: '1px solid',
                cursor: 'pointer', fontWeight: filter === f ? '700' : '400', fontSize: '13px',
                borderColor: filter === f
                  ? (f === 'COLD' ? '#7c3aed' : '#3b82f6')
                  : '#cbd5e1',
                backgroundColor: filter === f
                  ? (f === 'COLD' ? '#faf5ff' : '#eff6ff')
                  : '#fff',
                color: filter === f
                  ? (f === 'COLD' ? '#6d28d9' : '#1d4ed8')
                  : '#475569',
              }}>
                {f === 'COLD' ? '⚠ Cold-start' : f}
              </button>
            ))}
            <input
              type="text"
              placeholder="Search PO / Vendor / SKU…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                marginLeft: 'auto', padding: '6px 12px', borderRadius: '6px',
                border: '1px solid #cbd5e1', fontSize: '13px', width: '220px', outline: 'none',
              }}
            />
            <span style={{ fontSize: '13px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
              {visible.length} / {orders.length} rows
            </span>
          </div>

          {/* Orders table */}
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
                  const money   = financials(order)
                  const status  = riskStatus(order.predicted_sigma_l)
                  const cold    = isColdStart(order)
                  const rowBg   = cold
                    ? (i % 2 === 0 ? '#faf5ff' : '#f5f0ff')   // faint purple for cold-start rows
                    : status === 'CRITICAL'
                      ? (i % 2 === 0 ? '#fff5f5' : '#fff8f8')
                      : i % 2 === 0 ? '#ffffff' : '#f8fafc'

                  return (
                    <tr key={order.po_id} style={{ backgroundColor: rowBg, borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '11px 14px', fontWeight: '500', fontFamily: 'monospace' }}>{order.po_id}</td>

                      {/* Vendor ID — clickable */}
                      <td style={{ padding: '11px 14px' }}>
                        <button
                          onClick={() => openVendor(String(order.vendor_id))}
                          style={{
                            background: 'none', border: 'none', padding: 0,
                            cursor: 'pointer', color: '#2563eb', fontWeight: '500',
                            fontSize: '13.5px', textDecoration: 'underline',
                          }}
                          title="View delivery history chart"
                        >
                          {order.vendor_id}
                        </button>
                      </td>

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

                      {/* Financial Impact */}
                      <td style={{ padding: '11px 14px' }}>
                        {money.stale ? (
                          <span style={{ color: '#94a3b8', fontSize: '12px' }}>needs recompute</span>
                        ) : (
                          <>
                            <div style={{ fontWeight: '700', color: money.costOfRisk > 0 ? '#7c3aed' : '#64748b' }}>
                              {formatMoney(money.costOfRisk)} at risk
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: '11.5px', marginTop: '2px' }}>
                              Buffer&nbsp;{formatMoney(money.capitalLocked)}&nbsp;·&nbsp;stockout&nbsp;{formatMoney(money.stockoutPerDay)}/day
                            </div>
                          </>
                        )}
                      </td>

                      <td style={{ padding: '11px 14px' }}>
                        <RiskBadge sigmaL={order.predicted_sigma_l} coldStart={cold} />
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

          {/* Footer */}
          <p style={{ marginTop: '16px', fontSize: '12px', color: '#94a3b8' }}>
            Financial impact: <em>Cost of risk = σ_L × µ_d × unit_price</em> · <em>Capital locked = SS × unit_price</em> · µ_d = (ROP − SS) / µ_L.
            &nbsp;Click any <strong>Vendor ID</strong> to view delivery charts.
            &nbsp;<strong>Cold-start</strong> vendors use the global fleet average until real deliveries accumulate.
          </p>
        </>
      )}

      {/* Vendor detail modal */}
      {selectedVendor && (
        <VendorModal
          vendorId={selectedVendor}
          onClose={closeVendor}
          isColdStartVendor={selectedVendorIsColdStart}
        />
      )}
    </div>
  )
}
