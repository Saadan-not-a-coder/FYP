import { useState, useMemo } from 'react'

function formatMoney(value) {
  if (value === null || !Number.isFinite(value)) return '$0'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function buildScorecardsFromOrders(orders) {
  const vendorMap = {}

  orders.forEach(o => {
    const vid = o.vendor_id ? String(o.vendor_id).trim() : 'UNKNOWN'
    const actualLt = o.actual_lead_time != null ? Number(o.actual_lead_time) : null
    const muL = o.predicted_mu_l != null ? Number(o.predicted_mu_l) : 7.0
    const sigmaL = o.predicted_sigma_l != null ? Number(o.predicted_sigma_l) : 2.0
    const qty = Number(o.quantity) > 0 ? Number(o.quantity) : 1
    const price = Number(o.unit_price) >= 0 ? Number(o.unit_price) : 0
    const spend = qty * price
    const isCold = typeof o.risk_status === 'string' && o.risk_status.startsWith('COLD_')

    if (!vendorMap[vid]) {
      vendorMap[vid] = {
        vendor_id: vid,
        total_orders: 0,
        completed_orders: 0,
        on_time_orders: 0,
        delayed_orders: 0,
        total_delay_days: 0,
        max_delay_days: 0,
        total_spend: 0,
        total_units: 0,
        mu_l: muL,
        sigma_l: sigmaL,
        is_cold_start: isCold,
        sample_po: o.po_id,
      }
    }

    const v = vendorMap[vid]
    v.total_orders += 1
    v.total_spend += spend
    v.total_units += qty
    v.mu_l = muL
    v.sigma_l = sigmaL
    if (isCold) v.is_cold_start = true

    if (actualLt !== null && !isNaN(actualLt)) {
      v.completed_orders += 1
      const delay = actualLt - muL
      if (delay <= 0) {
        v.on_time_orders += 1
      } else {
        v.delayed_orders += 1
        v.total_delay_days += delay
        if (delay > v.max_delay_days) v.max_delay_days = delay
      }
    }
  })

  return Object.values(vendorMap).map(v => {
    const onTimeRate = v.completed_orders > 0
      ? Number(((v.on_time_orders / v.completed_orders) * 100).toFixed(1))
      : (v.is_cold_start ? 50.0 : 85.0)

    const avgDelayDays = v.delayed_orders > 0
      ? Number((v.total_delay_days / v.delayed_orders).toFixed(1))
      : 0.0

    let grade = 'B'
    let tier = 'Approved'
    let tierColor = '#2563eb'
    let badgeBg = '#dbeafe'

    if (v.is_cold_start) {
      grade = 'COLD'
      tier = 'Cold-Start'
      tierColor = '#7c3aed'
      badgeBg = '#f3e8ff'
    } else if (onTimeRate >= 90 && v.sigma_l < 1.65) {
      grade = 'A'
      tier = 'Preferred'
      tierColor = '#16a34a'
      badgeBg = '#dcfce7'
    } else if (onTimeRate >= 80 && v.sigma_l <= 1.85) {
      grade = 'B'
      tier = 'Approved'
      tierColor = '#2563eb'
      badgeBg = '#dbeafe'
    } else if (onTimeRate >= 70) {
      grade = 'C'
      tier = 'Conditional'
      tierColor = '#d97706'
      badgeBg = '#fef3c7'
    } else {
      grade = 'F'
      tier = 'High-Risk'
      tierColor = '#dc2626'
      badgeBg = '#fee2e2'
    }

    let plainLanguageSummary = ''
    if (v.is_cold_start) {
      plainLanguageSummary = `Supplier ${v.vendor_id} has zero historical delivery records. Scored using fleet fallback parameters (µ_L = ${v.mu_l.toFixed(1)}d, σ_L = ${v.sigma_l.toFixed(2)}d). High predictive uncertainty requires active delivery monitoring.`
    } else if (grade === 'A') {
      plainLanguageSummary = `Supplier ${v.vendor_id} demonstrates elite performance with an on-time delivery rate of ${onTimeRate}% across ${v.completed_orders} shipments. Lead-time consistency is high (σ_L = ${v.sigma_l.toFixed(2)}d) with minimal delay exposure.`
    } else if (grade === 'B') {
      plainLanguageSummary = `Supplier ${v.vendor_id} meets standard procurement requirements with an ${onTimeRate}% on-time rate. Moderate delivery variance (σ_L = ${v.sigma_l.toFixed(2)}d) with average delay of +${avgDelayDays}d on late shipments.`
    } else if (grade === 'C') {
      plainLanguageSummary = `Supplier ${v.vendor_id} is flagged under conditional status. On-time delivery has declined to ${onTimeRate}% with an average delay of +${avgDelayDays}d (max delay +${v.max_delay_days.toFixed(1)}d). Buffer safety stock should be maintained.`
    } else {
      plainLanguageSummary = `CRITICAL ALERT: Supplier ${v.vendor_id} exhibits chronic delivery delays with only ${onTimeRate}% on-time rate and severe lead-time volatility (σ_L = ${v.sigma_l.toFixed(2)}d). Average shipment delay is +${avgDelayDays} days. Recommend initiating dual-sourcing mitigation or SLA enforcement.`
    }

    return {
      vendor_id: v.vendor_id,
      total_orders: v.total_orders,
      completed_orders: v.completed_orders,
      on_time_orders: v.on_time_orders,
      delayed_orders: v.delayed_orders,
      on_time_rate: onTimeRate,
      avg_delay_days: avgDelayDays,
      max_delay_days: Number(v.max_delay_days.toFixed(1)),
      mu_l: Number(v.mu_l.toFixed(2)),
      sigma_l: Number(v.sigma_l.toFixed(2)),
      total_spend: Number(v.total_spend.toFixed(2)),
      total_units: v.total_units,
      grade,
      tier,
      tierColor,
      badgeBg,
      is_cold_start: v.is_cold_start,
      plainLanguageSummary,
    }
  })
}

export default function VendorScorecardsView({ orders = [], onSelectVendor, onOpenMitigation }) {
  const [tierFilter, setTierFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('spend') // 'spend' | 'ontime_asc' | 'ontime_desc' | 'delay_desc' | 'volatility_desc'

  const scorecards = useMemo(() => {
    return buildScorecardsFromOrders(orders)
  }, [orders])

  // Fleet summary statistics
  const fleetStats = useMemo(() => {
    if (!scorecards.length) {
      return { avgOnTime: 0, avgDelay: 0, preferredCount: 0, highRiskCount: 0, totalSpend: 0 }
    }
    const totalCompleted = scorecards.reduce((sum, s) => sum + s.completed_orders, 0)
    const totalOnTime = scorecards.reduce((sum, s) => sum + s.on_time_orders, 0)
    const totalDelayDays = scorecards.reduce((sum, s) => sum + (s.avg_delay_days * s.delayed_orders), 0)
    const totalDelayedOrders = scorecards.reduce((sum, s) => sum + s.delayed_orders, 0)

    const avgOnTime = totalCompleted > 0 ? Number(((totalOnTime / totalCompleted) * 100).toFixed(1)) : 85.0
    const avgDelay = totalDelayedOrders > 0 ? Number((totalDelayDays / totalDelayedOrders).toFixed(1)) : 0.0

    const preferredCount = scorecards.filter(s => s.grade === 'A').length
    const highRiskCount = scorecards.filter(s => s.grade === 'F').length
    const totalSpend = scorecards.reduce((sum, s) => sum + s.total_spend, 0)

    return {
      avgOnTime,
      avgDelay,
      preferredCount,
      highRiskCount,
      totalSpend,
      totalVendors: scorecards.length,
    }
  }, [scorecards])

  // Filter & sort
  const visibleScorecards = useMemo(() => {
    let list = scorecards.filter(s => {
      if (tierFilter !== 'ALL' && s.tier !== tierFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (!s.vendor_id.toLowerCase().includes(q)) return false
      }
      return true
    })

    list.sort((a, b) => {
      if (sortBy === 'spend') return b.total_spend - a.total_spend
      if (sortBy === 'ontime_desc') return b.on_time_rate - a.on_time_rate
      if (sortBy === 'ontime_asc') return a.on_time_rate - b.on_time_rate
      if (sortBy === 'delay_desc') return b.avg_delay_days - a.avg_delay_days
      if (sortBy === 'volatility_desc') return b.sigma_l - a.sigma_l
      return 0
    })

    return list
  }, [scorecards, tierFilter, search, sortBy])

  // CSV Export
  const handleExportCSV = () => {
    const headers = [
      'VENDOR_ID', 'GRADE', 'TIER', 'ON_TIME_RATE_PCT', 'AVG_DELAY_DAYS',
      'MAX_DELAY_DAYS', 'EXPECTED_LEAD_TIME_DAYS', 'VOLATILITY_SIGMA_L',
      'TOTAL_ORDERS', 'COMPLETED_ORDERS', 'TOTAL_SPEND_USD', 'COLD_START', 'ASSESSMENT_SUMMARY'
    ]
    const rows = visibleScorecards.map(s => [
      `"${s.vendor_id}"`,
      `"${s.grade}"`,
      `"${s.tier}"`,
      `${s.on_time_rate}%`,
      s.avg_delay_days,
      s.max_delay_days,
      s.mu_l,
      s.sigma_l,
      s.total_orders,
      s.completed_orders,
      s.total_spend.toFixed(2),
      s.is_cold_start ? 'YES' : 'NO',
      `"${s.plainLanguageSummary.replace(/"/g, '""')}"`,
    ])

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `vendor_historical_scorecards_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* Header & Export */}
      <div style={{
        backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px',
        padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', marginBottom: '16px' }}>
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: '800', color: '#0f172a' }}>
              ⭐ Vendor Historical Scorecards & On-Time Performance Scoring
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
              Track supplier delivery reliability, average delays, and ML volatility scoring with attached plain-language explanations.
            </p>
          </div>
          <button
            onClick={handleExportCSV}
            style={{
              padding: '9px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: '700',
              backgroundColor: '#0f766e', color: '#fff', border: 'none', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              boxShadow: '0 2px 6px rgba(15, 118, 110, 0.25)',
            }}
          >
            📥 Export Vendor Scorecards (CSV)
          </button>
        </div>

        {/* Filter Toolbar */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>
              Reliability Tier
            </label>
            <select
              value={tierFilter}
              onChange={e => setTierFilter(e.target.value)}
              style={{
                padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1',
                fontSize: '13px', backgroundColor: '#fff', color: '#1e293b', minWidth: '160px',
              }}
            >
              <option value="ALL">All Tiers ({scorecards.length})</option>
              <option value="Preferred">Preferred (Grade A)</option>
              <option value="Approved">Approved (Grade B)</option>
              <option value="Conditional">Conditional (Grade C)</option>
              <option value="High-Risk">High-Risk (Grade F)</option>
              <option value="Cold-Start">Cold-Start</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>
              Sort Order
            </label>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              style={{
                padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1',
                fontSize: '13px', backgroundColor: '#fff', color: '#1e293b', minWidth: '180px',
              }}
            >
              <option value="spend">Total Spend (High to Low)</option>
              <option value="ontime_desc">On-Time Rate (Best First)</option>
              <option value="ontime_asc">On-Time Rate (Worst First)</option>
              <option value="delay_desc">Average Delay (Longest First)</option>
              <option value="volatility_desc">Volatility σ_L (Highest First)</option>
            </select>
          </div>

          <div style={{ flex: 1, minWidth: '200px' }}>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>
              Search Vendor ID
            </label>
            <input
              type="text"
              placeholder="Search by vendor ID (e.g. 52, 104)..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                width: '100%', padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1',
                fontSize: '13px', boxSizing: 'border-box',
              }}
            />
          </div>

          {(tierFilter !== 'ALL' || search) && (
            <button
              onClick={() => { setTierFilter('ALL'); setSearch('') }}
              style={{
                padding: '6px 12px', marginTop: '18px', borderRadius: '6px', border: '1px solid #cbd5e1',
                backgroundColor: '#f1f5f9', color: '#475569', fontSize: '12px', cursor: 'pointer',
              }}
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Fleet Overview KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '16px' }}>
        
        {/* Fleet On-Time Rate */}
        <div style={{
          backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px',
          padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{ fontSize: '11.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>
            Fleet Avg On-Time Rate
          </div>
          <div style={{ fontSize: '26px', fontWeight: '800', color: fleetStats.avgOnTime >= 85 ? '#15803d' : '#d97706', margin: '4px 0 2px' }}>
            {fleetStats.avgOnTime}%
          </div>
          <div style={{ fontSize: '12px', color: '#64748b' }}>
            Across {fleetStats.totalVendors} suppliers
          </div>
        </div>

        {/* Avg Delay Days */}
        <div style={{
          backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px',
          padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{ fontSize: '11.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>
            Avg Delay on Late Orders
          </div>
          <div style={{ fontSize: '26px', fontWeight: '800', color: '#dc2626', margin: '4px 0 2px' }}>
            +{fleetStats.avgDelay} Days
          </div>
          <div style={{ fontSize: '12px', color: '#64748b' }}>
            Late shipment delay impact
          </div>
        </div>

        {/* Preferred Tier Count */}
        <div style={{
          backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px',
          padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{ fontSize: '11.5px', color: '#166534', fontWeight: '700', textTransform: 'uppercase' }}>
            Preferred Suppliers (Grade A)
          </div>
          <div style={{ fontSize: '26px', fontWeight: '800', color: '#15803d', margin: '4px 0 2px' }}>
            {fleetStats.preferredCount} Vendors
          </div>
          <div style={{ fontSize: '12px', color: '#166534' }}>
            On-time ≥ 90% and low volatility
          </div>
        </div>

        {/* High Risk Tier Count */}
        <div style={{
          backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px',
          padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{ fontSize: '11.5px', color: '#991b1b', fontWeight: '700', textTransform: 'uppercase' }}>
            High-Risk Suppliers (Grade F)
          </div>
          <div style={{ fontSize: '26px', fontWeight: '800', color: '#dc2626', margin: '4px 0 2px' }}>
            {fleetStats.highRiskCount} Vendors
          </div>
          <div style={{ fontSize: '12px', color: '#991b1b' }}>
            Require dual-sourcing mitigation
          </div>
        </div>

      </div>

      {/* Vendor Scorecard Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: '20px' }}>
        {visibleScorecards.map(scorecard => (
          <div
            key={scorecard.vendor_id}
            style={{
              backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px',
              padding: '20px 22px', boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
              display: 'flex', flexDirection: 'column', gap: '14px',
            }}
          >
            {/* Card Header: Vendor ID & Grade Badge */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                  width: '38px', height: '38px', borderRadius: '8px',
                  backgroundColor: scorecard.badgeBg, color: scorecard.tierColor,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: '800', fontSize: '16px', border: `1.5px solid ${scorecard.tierColor}`,
                }}>
                  {scorecard.grade}
                </div>
                <div>
                  <div style={{ fontWeight: '800', fontSize: '15px', color: '#0f172a' }}>
                    Vendor {scorecard.vendor_id}
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#64748b' }}>
                    {formatMoney(scorecard.total_spend)} spend · {scorecard.completed_orders} orders
                  </div>
                </div>
              </div>

              <span style={{
                backgroundColor: scorecard.badgeBg, color: scorecard.tierColor,
                padding: '3px 10px', borderRadius: '9999px', fontSize: '11.5px', fontWeight: '700',
              }}>
                {scorecard.tier}
              </span>
            </div>

            {/* Performance Progress & Key Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', backgroundColor: '#f8fafc', padding: '12px 14px', borderRadius: '8px' }}>
              <div>
                <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>On-Time Rate</div>
                <div style={{ fontSize: '17px', fontWeight: '800', color: scorecard.on_time_rate >= 85 ? '#15803d' : (scorecard.on_time_rate >= 70 ? '#d97706' : '#dc2626') }}>
                  {scorecard.on_time_rate}%
                </div>
                <div style={{ fontSize: '10px', color: '#64748b' }}>{scorecard.on_time_orders}/{scorecard.completed_orders} on-time</div>
              </div>

              <div>
                <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Avg Delay</div>
                <div style={{ fontSize: '17px', fontWeight: '800', color: scorecard.avg_delay_days > 0 ? '#dc2626' : '#15803d' }}>
                  {scorecard.avg_delay_days > 0 ? `+${scorecard.avg_delay_days}d` : '0d'}
                </div>
                <div style={{ fontSize: '10px', color: '#64748b' }}>max: +{scorecard.max_delay_days}d</div>
              </div>

              <div>
                <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Lead Time (µ ± σ)</div>
                <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b', marginTop: '2px' }}>
                  {scorecard.mu_l.toFixed(1)}d ± {scorecard.sigma_l.toFixed(2)}d
                </div>
                <div style={{ fontSize: '10px', color: '#64748b' }}>target schedule</div>
              </div>
            </div>

            {/* Visual Progress Bar for On-Time Rate */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>
                <span>Delivery Reliability Track Record</span>
                <span style={{ fontWeight: '700' }}>{scorecard.on_time_rate}%</span>
              </div>
              <div style={{ width: '100%', height: '7px', borderRadius: '4px', backgroundColor: '#e2e8f0', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(100, Math.max(0, scorecard.on_time_rate))}%`,
                  height: '100%',
                  backgroundColor: scorecard.on_time_rate >= 90 ? '#16a34a' : (scorecard.on_time_rate >= 75 ? '#d97706' : '#dc2626'),
                }} />
              </div>
            </div>

            {/* Plain-Language Explanation */}
            <div style={{
              backgroundColor: scorecard.grade === 'F' ? '#fff5f5' : (scorecard.grade === 'A' ? '#f0fdf4' : '#f8fafc'),
              borderLeft: `3px solid ${scorecard.tierColor}`,
              padding: '10px 12px', borderRadius: '6px', fontSize: '12px', color: '#334155', lineHeight: '1.45',
            }}>
              <span style={{ fontWeight: '700', display: 'block', color: scorecard.tierColor, marginBottom: '2px', fontSize: '11px' }}>
                💡 Attached Performance Assessment
              </span>
              {scorecard.plainLanguageSummary}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: '6px' }}>
              <button
                onClick={() => onSelectVendor(scorecard.vendor_id)}
                style={{
                  padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
                  backgroundColor: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                }}
              >
                🔍 Inspect Delivery History
              </button>

              {(scorecard.grade === 'F' || scorecard.grade === 'C') && onOpenMitigation && (
                <button
                  onClick={() => onOpenMitigation(scorecard.vendor_id)}
                  style={{
                    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: '700',
                    backgroundColor: '#fee2e2', color: '#dc2626', border: '1px solid #fecaca', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                  }}
                >
                  ⚡ Mitigate Risk
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}
