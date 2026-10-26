import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ReferenceLine, Label,
} from 'recharts'

// ── Supabase connection ──────────────────────────────────────────────────────
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? 'https://bcnhsbkznrebqchaihbo.supabase.co'
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY ?? 'sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl'
const supabase = createClient(supabaseUrl, supabaseKey)

// ── Risk thresholds (must match ml_service.py _risk_status) ─────────────────
const CRITICAL_THRESHOLD = 1.85
const WARNING_THRESHOLD  = 1.65

// ── Cold-start detection (3.4) ───────────────────────────────────────────────
function isColdStart(order) {
  return typeof order.risk_status === 'string' && order.risk_status.startsWith('COLD_')
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

// ── Financial derivation & What-If Simulation Engine (3.2 & 3.6) ─────────────
// Identity: ROP = µ_d * µ_L + SS  →  µ_d = (ROP − SS) / µ_L
// SS = Z * sqrt(µ_L * σ_d^2 + µ_d^2 * σ_L^2)
function computeOrderMetrics(order, scenario = null) {
  const price  = Number(order.unit_price)        || 0
  const ssBase = Number(order.safety_stock)      || 0
  const muLBase= Number(order.predicted_mu_l)    || 0
  const sigmaLBase = Number(order.predicted_sigma_l) || 0
  const ropBase= Number(order.reorder_point)      || 0

  if (muLBase <= 0 || ropBase <= 0) {
    return {
      capitalLocked: null, stockoutPerDay: null, costOfRisk: null, stale: true,
      muD: 0, sigmaD: 0, simulated: null,
    }
  }

  const muD = Math.max((ropBase - ssBase) / muLBase, 0)
  // Recover historical demand sigma σ_d from the 3.1 combined SS formula
  const varTotal = Math.pow(ssBase / 1.65, 2)
  const leadTimeVarPart = Math.pow(muD, 2) * Math.pow(sigmaLBase, 2)
  const demandVarPart = Math.max(0, varTotal - leadTimeVarPart)
  const sigmaD = muLBase > 0 ? Math.sqrt(demandVarPart / muLBase) : 0

  const baseline = {
    safetyStock: ssBase,
    reorderPoint: ropBase,
    muL: muLBase,
    sigmaL: sigmaLBase,
    muD,
    sigmaD,
    status: riskStatus(sigmaLBase),
    capitalLocked: ssBase * price,
    stockoutPerDay: muD * price,
    costOfRisk: sigmaLBase * muD * price,
    stale: false,
  }

  if (!scenario || !scenario.enabled) {
    return { ...baseline, simulated: null }
  }

  // ── 3.6: What-If Perturbations ──
  const zSim = Number(scenario.serviceLevelZ) || 1.65
  const muLSim = Math.max(0.1, muLBase + (Number(scenario.leadTimeDelay) || 0))
  const volMult = Math.max(0.1, Number(scenario.volatilityMultiplier) || 1.0)
  const sigmaLSim = sigmaLBase * volMult
  const demMult = Math.max(0.1, Number(scenario.demandMultiplier) || 1.0)
  const muDSim = muD * demMult
  const sigmaDSim = sigmaD * demMult

  // Combined SS under scenario
  const ssSimRaw = zSim * Math.sqrt((muLSim * Math.pow(sigmaDSim, 2)) + (Math.pow(muDSim, 2) * Math.pow(sigmaLSim, 2)))
  const ssSim = Math.round(ssSimRaw)
  const ropSim = Math.round((muDSim * muLSim) + ssSim)
  const statusSim = riskStatus(sigmaLSim)
  const capitalLockedSim = ssSim * price
  const stockoutPerDaySim = muDSim * price
  const costOfRiskSim = sigmaLSim * muDSim * price

  return {
    ...baseline,
    simulated: {
      safetyStock: ssSim,
      reorderPoint: ropSim,
      muL: muLSim,
      sigmaL: sigmaLSim,
      muD: muDSim,
      sigmaD: sigmaDSim,
      status: statusSim,
      capitalLocked: capitalLockedSim,
      stockoutPerDay: stockoutPerDaySim,
      costOfRisk: costOfRiskSim,
      deltaSS: ssSim - ssBase,
      deltaROP: ropSim - ropBase,
      deltaCapital: capitalLockedSim - baseline.capitalLocked,
      deltaCostOfRisk: costOfRiskSim - baseline.costOfRisk,
    },
  }
}

// ── Badges & UI Sub-components ───────────────────────────────────────────────
function RiskBadge({ sigmaL, coldStart, simulatedStatus }) {
  const s = simulatedStatus || riskStatus(sigmaL)
  const isEscalated = simulatedStatus && simulatedStatus !== riskStatus(sigmaL)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flexWrap: 'nowrap' }}>
      <span style={{
        backgroundColor: STATUS_BG[s], color: STATUS_COLOR[s],
        padding: '3px 10px', borderRadius: '9999px',
        fontWeight: '600', fontSize: '12px', whiteSpace: 'nowrap',
        border: isEscalated ? `1px dashed ${STATUS_COLOR[s]}` : 'none',
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

function SummaryBar({ orders, scenario }) {
  const isSim = scenario && scenario.enabled

  const computedOrders = useMemo(() => {
    return orders.map(o => ({
      order: o,
      m: computeOrderMetrics(o, scenario),
    }))
  }, [orders, scenario])

  const criticalBase = computedOrders.filter(x => x.m.status === 'CRITICAL').length
  const warningBase  = computedOrders.filter(x => x.m.status === 'WARNING').length
  const coldStarts   = orders.filter(isColdStart).length
  const totalRiskBase= computedOrders.reduce((s, x) => s + (x.m.costOfRisk ?? 0), 0)
  const totalCapBase = computedOrders.reduce((s, x) => s + (x.m.capitalLocked ?? 0), 0)

  const criticalSim = isSim ? computedOrders.filter(x => x.m.simulated?.status === 'CRITICAL').length : criticalBase
  const warningSim  = isSim ? computedOrders.filter(x => x.m.simulated?.status === 'WARNING').length : warningBase
  const totalRiskSim= isSim ? computedOrders.reduce((s, x) => s + (x.m.simulated?.costOfRisk ?? 0), 0) : totalRiskBase
  const totalCapSim = isSim ? computedOrders.reduce((s, x) => s + (x.m.simulated?.capitalLocked ?? 0), 0) : totalCapBase

  const card = (label, baseVal, simVal, accent, isMoney = false) => {
    const hasDelta = isSim && simVal !== undefined && simVal !== baseVal
    const deltaNum = isSim ? (simVal - baseVal) : 0
    return (
      <div key={label} style={{
        flex: '1 1 150px', backgroundColor: '#fff',
        border: `1px solid ${accent}33`, borderLeft: `4px solid ${accent}`,
        borderRadius: '8px', padding: '16px 20px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '22px', fontWeight: '700', color: accent }}>
            {isMoney ? formatMoney(isSim ? simVal : baseVal) : (isSim ? simVal : baseVal)}
          </span>
          {hasDelta && (
            <span style={{
              fontSize: '11px', fontWeight: '700',
              padding: '2px 6px', borderRadius: '4px',
              backgroundColor: deltaNum > 0 ? '#fee2e2' : '#dcfce7',
              color: deltaNum > 0 ? '#991b1b' : '#166534',
            }}>
              {deltaNum > 0 ? '+' : ''}{isMoney ? formatMoney(deltaNum) : deltaNum}
            </span>
          )}
        </div>
        <div style={{ fontSize: '13px', color: '#64748b', marginTop: '2px' }}>{label}</div>
        {hasDelta && (
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>
            Baseline: {isMoney ? formatMoney(baseVal) : baseVal}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
      {card('Total orders shown',       orders.length, orders.length, '#3b82f6')}
      {card('Critical vendors',         criticalBase, criticalSim, '#dc2626')}
      {card('Warning vendors',          warningBase, warningSim, '#d97706')}
      {card('Cold-start vendors',       coldStarts, coldStarts, '#7c3aed')}
      {card('Total revenue at risk',    totalRiskBase, totalRiskSim, '#0891b2', true)}
      {card('Capital locked in buffer', totalCapBase, totalCapSim, '#0f766e', true)}
    </div>
  )
}

// ── Tooltip components declared at module scope ──────────────────────────────
function VendorRankingTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: '#1e293b', color: '#f8fafc', padding: '10px 14px',
      borderRadius: '8px', fontSize: '12px', lineHeight: '1.7',
    }}>
      <div style={{ fontWeight: '700', marginBottom: '4px' }}>Vendor {d.name}</div>
      <div>σ_L: <strong>{d.sigma_l}</strong> {d.isSim && <span style={{ color: '#a78bfa' }}>(simulated)</span>}</div>
      <div>µ_L: <strong>{d.mu_l} days</strong></div>
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

function TimelineTooltip({ active, payload }) {
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

function HistTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{ background: '#1e293b', color: '#f8fafc', padding: '8px 12px', borderRadius: '6px', fontSize: '12px' }}>
      <div>Bucket: <strong>{d.bucket} days</strong></div>
      <div>Orders: <strong>{d.count}</strong></div>
    </div>
  )
}

// ── Vendor Ranking Chart (3.3 & 3.6 scenario-aware) ─────────────────────────
function buildVendorSummary(orders, scenario, topN = 20) {
  const isSim = scenario && scenario.enabled
  const map = {}
  for (const o of orders) {
    const vid = o.vendor_id
    const m = computeOrderMetrics(o, scenario)
    const effectiveSigma = isSim && m.simulated ? m.simulated.sigmaL : m.sigmaL
    const effectiveMuL   = isSim && m.simulated ? m.simulated.muL : m.muL
    const effectiveRisk  = isSim && m.simulated ? m.simulated.costOfRisk : m.costOfRisk
    const effectiveStatus= isSim && m.simulated ? m.simulated.status : m.status

    if (!map[vid]) {
      map[vid] = {
        vendor_id:  vid,
        sigma_l:    effectiveSigma,
        mu_l:       effectiveMuL,
        status:     effectiveStatus,
        coldStart:  isColdStart(o),
        orderCount: 0,
        totalRisk:  0,
        isSim,
      }
    }
    map[vid].orderCount++
    map[vid].totalRisk += effectiveRisk ?? 0
  }
  return Object.values(map)
    .sort((a, b) => b.sigma_l - a.sigma_l)
    .slice(0, topN)
}

function vendorBarColor(status) { return STATUS_COLOR[status] ?? '#94a3b8' }

function ColoredBar(props) {
  const { x, y, width, height, status, coldStart } = props
  if (height <= 0) return null
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

function VendorRankingChart({ orders, scenario, onSelect }) {
  const data = useMemo(() => buildVendorSummary(orders, scenario, 20), [orders, scenario])
  if (data.length === 0) return null

  const chartData = data.map(d => ({
    name:       String(d.vendor_id),
    sigma_l:    parseFloat(d.sigma_l.toFixed(4)),
    status:     d.status,
    coldStart:  d.coldStart,
    mu_l:       parseFloat(d.mu_l.toFixed(2)),
    orderCount: d.orderCount,
    totalRisk:  d.totalRisk,
    isSim:      d.isSim,
  }))

  return (
    <div style={{
      backgroundColor: '#fff', borderRadius: '10px',
      border: '1px solid #e2e8f0', padding: '20px 24px',
      marginBottom: '28px', boxShadow: '0 1px 4px rgba(0,0,0,.05)',
    }}>
      <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: '700' }}>
            Vendor Risk Ranking — Lead-Time Volatility (σ_L)
          </h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
            Top {chartData.length} vendors by σ_L. Faded bars = cold-start. Click any bar to inspect delivery history.
          </p>
        </div>
        {scenario?.enabled && (
          <span style={{
            backgroundColor: '#faf5ff', color: '#7c3aed', border: '1px solid #d8b4fe',
            padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
          }}>
            ⚡ Showing Scenario Simulated Volatility
          </span>
        )}
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
          <Tooltip content={<VendorRankingTooltip />} cursor={{ fill: '#f1f5f950' }} />
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

// ── Vendor Detail Modal (3.3 & 3.4) ─────────────────────────────────────────
function VendorModal({ vendorId, onClose, isColdStartVendor }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!vendorId) return
    let active = true
    supabase
      .from('orders')
      .select('po_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,order_date,risk_status')
      .eq('vendor_id', vendorId)
      .order('order_date', { ascending: true })
      .limit(500)
      .then(({ data, error: err }) => {
        if (!active) return
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
    return () => { active = false }
  }, [vendorId])

  const ltValues  = history.map(r => r.lt)
  const muL       = history[0]?.muL   ?? 0
  const sigmaL    = history[0]?.sigmaL ?? 0
  const status    = riskStatus(sigmaL)
  const histogram = buildHistogram(ltValues, 1)

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

        {/* Cold-start notice banner */}
        {isColdStartVendor && (
          <div style={{
            backgroundColor: '#faf5ff', border: '1px solid #d8b4fe',
            borderLeft: '4px solid #7c3aed', borderRadius: '8px',
            padding: '12px 16px', marginBottom: '20px', fontSize: '13px', color: '#4c1d95',
          }}>
            <strong>⚠ Cold-start vendor</strong> — No delivery history was available when this
            order was processed. Global fleet-average statistics were used as a fallback.
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

// ── 3.6: What-If Scenario Stress-Testing Drawer / Panel ───────────────────────
function ScenarioSimulatorPanel({ scenario, onChange, onReset }) {
  const serviceLevelOptions = [
    { label: '90% (Z=1.28)', z: 1.28 },
    { label: '95% (Z=1.65)', z: 1.65 },
    { label: '98% (Z=2.05)', z: 2.05 },
    { label: '99% (Z=2.33)', z: 2.33 },
  ]

  return (
    <div style={{
      backgroundColor: '#f8fafc', border: '1px solid #cbd5e1',
      borderLeft: '5px solid #7c3aed', borderRadius: '10px',
      padding: '20px 24px', marginBottom: '24px',
      boxShadow: '0 2px 6px rgba(124, 58, 237, 0.08)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h3 style={{ margin: '0 0 2px', fontSize: '15px', fontWeight: '700', color: '#1e1b4b' }}>
            ⚡ What-If Scenario Simulation & Disruption Stress Testing
          </h3>
          <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
            Perturb supply chain parameters across all loaded orders to model inventory buffers under shocks.
          </p>
        </div>
        <button
          onClick={onReset}
          style={{
            padding: '5px 12px', fontSize: '12px', fontWeight: '600',
            backgroundColor: '#fff', border: '1px solid #cbd5e1',
            borderRadius: '6px', cursor: 'pointer', color: '#475569',
          }}
        >
          Reset to Baseline
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
        {/* Control 1: Service Level Policy */}
        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: '#334155', marginBottom: '6px' }}>
            Target Service Level (Z-score)
          </label>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {serviceLevelOptions.map(opt => (
              <button
                key={opt.z}
                onClick={() => onChange({ ...scenario, serviceLevelZ: opt.z })}
                style={{
                  padding: '5px 9px', borderRadius: '5px', fontSize: '11.5px', cursor: 'pointer',
                  border: scenario.serviceLevelZ === opt.z ? '1px solid #7c3aed' : '1px solid #cbd5e1',
                  backgroundColor: scenario.serviceLevelZ === opt.z ? '#7c3aed' : '#fff',
                  color: scenario.serviceLevelZ === opt.z ? '#fff' : '#475569',
                  fontWeight: scenario.serviceLevelZ === opt.z ? '700' : '400',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Control 2: Lead Time Delay (Days) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: '600', color: '#334155' }}>
              Lead-Time Disruption (Δµ_L)
            </label>
            <span style={{ fontSize: '12px', fontWeight: '700', color: '#7c3aed' }}>
              +{scenario.leadTimeDelay} days
            </span>
          </div>
          <input
            type="range" min="0" max="5" step="0.5"
            value={scenario.leadTimeDelay}
            onChange={e => onChange({ ...scenario, leadTimeDelay: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: '#7c3aed' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8' }}>
            <span>0 days (baseline)</span>
            <span>+5 days shock</span>
          </div>
        </div>

        {/* Control 3: Lead Time Volatility (Multiplier) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: '600', color: '#334155' }}>
              Supplier Volatility (×σ_L)
            </label>
            <span style={{ fontSize: '12px', fontWeight: '700', color: '#7c3aed' }}>
              {scenario.volatilityMultiplier.toFixed(1)}x
            </span>
          </div>
          <input
            type="range" min="1.0" max="2.5" step="0.1"
            value={scenario.volatilityMultiplier}
            onChange={e => onChange({ ...scenario, volatilityMultiplier: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: '#7c3aed' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8' }}>
            <span>1.0x (normal)</span>
            <span>2.5x (severe)</span>
          </div>
        </div>

        {/* Control 4: Demand Surge (Multiplier) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: '600', color: '#334155' }}>
              Demand Surge (×µ_d)
            </label>
            <span style={{ fontSize: '12px', fontWeight: '700', color: '#7c3aed' }}>
              {scenario.demandMultiplier.toFixed(1)}x
            </span>
          </div>
          <input
            type="range" min="1.0" max="2.0" step="0.1"
            value={scenario.demandMultiplier}
            onChange={e => onChange({ ...scenario, demandMultiplier: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: '#7c3aed' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8' }}>
            <span>1.0x (baseline)</span>
            <span>2.0x (peak promo)</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 3.6: CSV Export Helper ───────────────────────────────────────────────────
function exportOrdersToCSV(orders, scenario) {
  const isSim = scenario && scenario.enabled
  const headers = [
    'PO ID', 'Vendor ID', 'SKU ID', 'Actual Lead Time (days)',
    'Pred mu_L (days)', 'Pred sigma_L', 'Safety Stock (units)', 'Reorder Point (units)',
    'Unit Price ($)', 'Capital Locked ($)', 'Stockout Cost / Day ($)', 'Cost of Risk ($)',
    'Risk Status', 'Cold Start',
  ]

  if (isSim) {
    headers.push(
      'Simulated mu_L (days)', 'Simulated sigma_L', 'Simulated Safety Stock', 'Simulated ROP',
      'Simulated Capital Locked ($)', 'Simulated Cost of Risk ($)', 'Simulated Risk Status',
      'Delta Capital Locked ($)', 'Delta Cost of Risk ($)'
    )
  }

  const rows = orders.map(o => {
    const m = computeOrderMetrics(o, scenario)
    const baseRow = [
      `"${o.po_id}"`,
      `"${o.vendor_id}"`,
      `"${o.sku_id}"`,
      o.actual_lead_time != null ? o.actual_lead_time : '',
      m.muL != null ? m.muL.toFixed(2) : '',
      m.sigmaL != null ? m.sigmaL.toFixed(4) : '',
      m.safetyStock ?? '',
      m.reorderPoint ?? '',
      o.unit_price != null ? Number(o.unit_price).toFixed(2) : '',
      m.capitalLocked != null ? m.capitalLocked.toFixed(2) : '',
      m.stockoutPerDay != null ? m.stockoutPerDay.toFixed(2) : '',
      m.costOfRisk != null ? m.costOfRisk.toFixed(2) : '',
      m.status,
      isColdStart(o) ? 'YES' : 'NO',
    ]

    if (isSim && m.simulated) {
      baseRow.push(
        m.simulated.muL.toFixed(2),
        m.simulated.sigmaL.toFixed(4),
        m.simulated.safetyStock,
        m.simulated.reorderPoint,
        m.simulated.capitalLocked.toFixed(2),
        m.simulated.costOfRisk.toFixed(2),
        m.simulated.status,
        m.simulated.deltaCapital.toFixed(2),
        m.simulated.deltaCostOfRisk.toFixed(2)
      )
    }

    return baseRow.join(',')
  })

  const csvContent = [headers.join(','), ...rows].join('\r\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const dateStr = new Date().toISOString().slice(0, 10)
  link.setAttribute('href', url)
  link.setAttribute('download', `supply_chain_risk_report_${dateStr}.csv`)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
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

  // ── 3.6: Scenario state ──
  const [scenario, setScenario] = useState({
    enabled: false,
    serviceLevelZ: 1.65,
    leadTimeDelay: 0,
    volatilityMultiplier: 1.0,
    demandMultiplier: 1.0,
  })

  const fetchOrders = useCallback(async () => {
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
  }, [])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  const openVendor  = useCallback(vid => setSelectedVendor(vid), [])
  const closeVendor = useCallback(() => setSelectedVendor(null), [])

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') closeVendor() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeVendor])

  const selectedVendorIsColdStart = selectedVendor
    ? orders.some(o => String(o.vendor_id) === selectedVendor && isColdStart(o))
    : false

  // Client-side filter + search (evaluates either base or simulated status)
  const visible = useMemo(() => {
    return orders.filter(o => {
      const m = computeOrderMetrics(o, scenario)
      const effectiveStatus = (scenario.enabled && m.simulated) ? m.simulated.status : m.status

      if (filter === 'COLD') return isColdStart(o)
      if (filter !== 'ALL' && effectiveStatus !== filter) return false
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
  }, [orders, filter, search, scenario])

  const handleResetScenario = () => {
    setScenario({
      enabled: true,
      serviceLevelZ: 1.65,
      leadTimeDelay: 0,
      volatilityMultiplier: 1.0,
      demandMultiplier: 1.0,
    })
  }

  return (
    <div style={{ padding: '36px 40px', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '1440px', margin: '0 auto', color: '#0f172a' }}>

      {/* Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: '24px', fontWeight: '700' }}>
            Supply Chain Risk Dashboard
          </h1>
          <p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>
            Order-level lead-time variance · risk-adjusted safety stock · financial cost of delay
          </p>
        </div>

        {/* 3.6 What-If Simulator Toggle & CSV Export */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={() => setScenario(prev => ({ ...prev, enabled: !prev.enabled }))}
            style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: '700',
              cursor: 'pointer', transition: 'all 0.2s',
              backgroundColor: scenario.enabled ? '#7c3aed' : '#fff',
              color: scenario.enabled ? '#fff' : '#7c3aed',
              border: '1.5px solid #7c3aed',
              boxShadow: scenario.enabled ? '0 2px 8px rgba(124, 58, 237, 0.25)' : 'none',
            }}
          >
            {scenario.enabled ? '⚡ Simulator Active' : '⚡ Simulate What-If'}
          </button>

          <button
            onClick={() => exportOrdersToCSV(visible, scenario)}
            disabled={loading || visible.length === 0}
            style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: '600',
              cursor: loading || visible.length === 0 ? 'not-allowed' : 'pointer',
              backgroundColor: '#fff', color: '#0f766e',
              border: '1.5px solid #0f766e',
              display: 'inline-flex', alignItems: 'center', gap: '6px',
            }}
            title="Download CSV report of current view"
          >
            📥 Export Report (CSV)
          </button>
        </div>
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
          {/* 3.6: What-If Scenario Stress-Testing Drawer */}
          {scenario.enabled && (
            <ScenarioSimulatorPanel
              scenario={scenario}
              onChange={setScenario}
              onReset={handleResetScenario}
            />
          )}

          {/* KPI Summary Cards */}
          <SummaryBar orders={orders} scenario={scenario} />

          {/* 3.3 & 3.6: Vendor Ranking Chart */}
          <VendorRankingChart orders={orders} scenario={scenario} onSelect={openVendor} />

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
                  const m      = computeOrderMetrics(order, scenario)
                  const cold   = isColdStart(order)
                  const isSim  = scenario.enabled && m.simulated != null
                  const activeStatus = isSim ? m.simulated.status : m.status

                  const rowBg   = cold
                    ? (i % 2 === 0 ? '#faf5ff' : '#f5f0ff')
                    : activeStatus === 'CRITICAL'
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
                        {isSim ? (
                          <span>
                            <strong>{m.simulated.muL.toFixed(2)}</strong>
                            <span style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>was {m.muL.toFixed(2)}</span>
                          </span>
                        ) : (
                          m.muL != null ? m.muL.toFixed(2) : '—'
                        )}
                      </td>
                      <td style={{ padding: '11px 14px', fontWeight: '600' }}>
                        {isSim ? (
                          <span>
                            <strong style={{ color: STATUS_COLOR[m.simulated.status] }}>{m.simulated.sigmaL.toFixed(4)}</strong>
                            <span style={{ color: '#94a3b8', fontSize: '11px', display: 'block', fontWeight: 'normal' }}>was {m.sigmaL.toFixed(4)}</span>
                          </span>
                        ) : (
                          m.sigmaL != null ? m.sigmaL.toFixed(4) : '—'
                        )}
                      </td>
                      <td style={{ padding: '11px 14px', fontWeight: '600' }}>
                        {isSim ? (
                          <span>
                            <strong>{m.simulated.safetyStock} units</strong>
                            <span style={{
                              color: m.simulated.deltaSS > 0 ? '#dc2626' : '#16a34a',
                              fontSize: '11px', display: 'block',
                            }}>
                              {m.simulated.deltaSS >= 0 ? `+${m.simulated.deltaSS}` : m.simulated.deltaSS} units
                            </span>
                          </span>
                        ) : (
                          `${m.safetyStock} units`
                        )}
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        {isSim ? (
                          <span>
                            <strong>{m.simulated.reorderPoint} units</strong>
                            <span style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>was {m.reorderPoint}</span>
                          </span>
                        ) : (
                          m.reorderPoint != null ? `${m.reorderPoint} units` : '—'
                        )}
                      </td>

                      {/* Financial Impact */}
                      <td style={{ padding: '11px 14px' }}>
                        {m.stale ? (
                          <span style={{ color: '#94a3b8', fontSize: '12px' }}>needs recompute</span>
                        ) : isSim ? (
                          <>
                            <div style={{ fontWeight: '700', color: m.simulated.costOfRisk > 0 ? '#7c3aed' : '#64748b' }}>
                              {formatMoney(m.simulated.costOfRisk)} at risk
                              <span style={{ fontSize: '11px', marginLeft: '6px', color: m.simulated.deltaCostOfRisk > 0 ? '#dc2626' : '#16a34a' }}>
                                ({m.simulated.deltaCostOfRisk >= 0 ? '+' : ''}{formatMoney(m.simulated.deltaCostOfRisk)})
                              </span>
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: '11.5px', marginTop: '2px' }}>
                              Buffer&nbsp;{formatMoney(m.simulated.capitalLocked)}&nbsp;·&nbsp;stockout&nbsp;{formatMoney(m.simulated.stockoutPerDay)}/day
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontWeight: '700', color: m.costOfRisk > 0 ? '#7c3aed' : '#64748b' }}>
                              {formatMoney(m.costOfRisk)} at risk
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: '11.5px', marginTop: '2px' }}>
                              Buffer&nbsp;{formatMoney(m.capitalLocked)}&nbsp;·&nbsp;stockout&nbsp;{formatMoney(m.stockoutPerDay)}/day
                            </div>
                          </>
                        )}
                      </td>

                      <td style={{ padding: '11px 14px' }}>
                        <RiskBadge
                          sigmaL={isSim ? m.simulated.sigmaL : m.sigmaL}
                          coldStart={cold}
                          simulatedStatus={isSim ? m.simulated.status : null}
                        />
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
            &nbsp;<strong>What-If Simulator</strong> allows interactive stress testing with real-time recalculation.
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
