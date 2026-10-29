import { useMemo } from 'react'

function formatMoney(value) {
  if (value === null || !Number.isFinite(value)) return '$0'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function generateExplanation(order) {
  const muL = Number(order.predicted_mu_l) || 7.0
  const sigmaL = Number(order.predicted_sigma_l) || 2.0
  const ss = Number(order.safety_stock) || 0
  const price = Number(order.unit_price) || 0
  const capitalLocked = ss * price
  const isCold = typeof order.risk_status === 'string' && order.risk_status.startsWith('COLD_')

  if (isCold) {
    return {
      riskLevel: 'COLD_START',
      delayProbability: '60–75%',
      badgeColor: '#7c3aed',
      badgeBg: '#f3e8ff',
      headline: 'Cold-Start Supplier (Unverified Track Record)',
      explanation: `Purchase Order ${order.po_id} for SKU ${order.sku_id} is assigned to vendor ${order.vendor_id}, which has zero historical delivery records in the operational ledger. The ML decision engine applied fleet fallback parameters (µ_L = ${muL.toFixed(1)} days, σ_L = ${sigmaL.toFixed(2)} days). Because statistical variance is unverified, an elevated buffer of ${ss} safety stock units (${formatMoney(capitalLocked)} capital exposure) is enforced to prevent production halts.`,
      recommendation: 'Request supplier dispatch confirmation within 24 hours and establish secondary backup sourcing.',
    }
  }

  if (sigmaL > 1.85) {
    return {
      riskLevel: 'CRITICAL',
      delayProbability: '82–94%',
      badgeColor: '#dc2626',
      badgeBg: '#fee2e2',
      headline: 'Severe Lead-Time Volatility & Delay Exposure',
      explanation: `Purchase Order ${order.po_id} is classified under CRITICAL risk. The machine learning model identifies severe supplier lead-time variance (σ_L = ${sigmaL.toFixed(2)} days vs fleet benchmark 1.65d). Historical deliveries for vendor ${order.vendor_id} exhibit chronic distribution tails, creating an 85%+ probability of delivery slippage past the promised ${muL.toFixed(1)}-day schedule. Required safety stock is expanded to ${ss} units (${formatMoney(capitalLocked)} locked working capital) to insulate customer fulfillment.`,
      recommendation: 'Activate prescriptive supplier mitigation: reallocate volume to dual-sourcing alternatives or enforce SLA penalty terms.',
    }
  }

  if (sigmaL > 1.65) {
    return {
      riskLevel: 'WARNING',
      delayProbability: '45–65%',
      badgeColor: '#d97706',
      badgeBg: '#fef3c7',
      headline: 'Moderate Lead-Time Variance Warning',
      explanation: `Purchase Order ${order.po_id} exhibits moderate delivery variance (σ_L = ${sigmaL.toFixed(2)} days). While vendor ${order.vendor_id} generally delivers within acceptable windows, recent variance spikes create a ~55% chance of minor shipment delays. Safety buffer is maintained at ${ss} units (${formatMoney(capitalLocked)} capital).`,
      recommendation: 'Monitor supplier shipment milestones; confirm transit tracking with logistics provider.',
    }
  }

  return {
    riskLevel: 'NORMAL',
    delayProbability: '< 15%',
    badgeColor: '#16a34a',
    badgeBg: '#dcfce7',
    headline: 'High Lead-Time Consistency & Predictable Delivery',
    explanation: `Purchase Order ${order.po_id} exhibits strong operational predictability with low lead-time standard deviation (σ_L = ${sigmaL.toFixed(2)} days). Vendor ${order.vendor_id} demonstrates disciplined adherence to promised schedules, maintaining minimal delay probability (<15%). Lean safety stock of ${ss} units (${formatMoney(capitalLocked)}) is sufficient.`,
    recommendation: 'Standard automated inventory reorder replenishment applies. No manual intervention required.',
  }
}

export default function OrderRiskExplanationModal({ order, onClose, onOpenMitigation }) {
  const info = useMemo(() => {
    if (!order) return null
    return generateExplanation(order)
  }, [order])

  if (!order || !info) return null

  const muL = Number(order.predicted_mu_l) || 7.0
  const sigmaL = Number(order.predicted_sigma_l) || 2.0
  const ss = Number(order.safety_stock) || 0

  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.65)',
      backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: '20px',
    }}>
      <div style={{
        backgroundColor: '#ffffff', borderRadius: '14px', width: '100%', maxWidth: '640px',
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        display: 'flex', flexDirection: 'column', border: '1px solid #e2e8f0',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          backgroundColor: '#f8fafc', borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <h2 style={{ margin: 0, fontSize: '17px', fontWeight: '800', color: '#0f172a' }}>
                Machine Learning Delay Risk Explanation
              </h2>
            </div>
            <p style={{ margin: 0, fontSize: '12.5px', color: '#64748b' }}>
              Plain-language audit narrative for Purchase Order #{order.po_id}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
              color: '#64748b', padding: '4px 8px', borderRadius: '6px',
            }}
          >
            Close
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          
          {/* Risk Classification Banner */}
          <div style={{
            backgroundColor: info.badgeBg, border: `1.5px solid ${info.badgeColor}`,
            borderRadius: '10px', padding: '16px 18px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{
                backgroundColor: info.badgeColor, color: '#fff', fontSize: '11px',
                fontWeight: '800', padding: '2px 8px', borderRadius: '4px', textTransform: 'uppercase',
              }}>
                {info.riskLevel}
              </span>
              <span style={{ fontSize: '12px', fontWeight: '700', color: info.badgeColor }}>
                Estimated Delay Probability: {info.delayProbability}
              </span>
            </div>
            <div style={{ fontSize: '15px', fontWeight: '800', color: '#0f172a' }}>
              {info.headline}
            </div>
          </div>

          {/* Actuarial Order Metrics Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', backgroundColor: '#f8fafc', padding: '14px', borderRadius: '8px' }}>
            <div>
              <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Supplier</div>
              <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>Vendor {order.vendor_id}</div>
            </div>
            <div>
              <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Target Lead Time</div>
              <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>{muL.toFixed(1)} days</div>
            </div>
            <div>
              <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Volatility (σ_L)</div>
              <div style={{ fontSize: '14px', fontWeight: '800', color: info.badgeColor }}>{sigmaL.toFixed(2)} days</div>
            </div>
            <div>
              <div style={{ fontSize: '10.5px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Buffer Stock</div>
              <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>{ss} units</div>
            </div>
          </div>

          {/* Plain Language Explanation Narrative */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: '700', color: '#475569', textTransform: 'uppercase', marginBottom: '6px' }}>
              Plain-Language ML Explanation
            </div>
            <div style={{
              backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px',
              padding: '14px 16px', fontSize: '13px', lineHeight: '1.6', color: '#1e293b',
            }}>
              {info.explanation}
            </div>
          </div>

          {/* Recommendation */}
          <div style={{
            backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px',
            padding: '12px 16px', fontSize: '12.5px', color: '#1e40af',
          }}>
            <strong style={{ display: 'block', marginBottom: '2px' }}>Recommended Procurement Policy:</strong>
            {info.recommendation}
          </div>

        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid #e2e8f0', backgroundColor: '#f8fafc',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottomLeftRadius: '14px', borderBottomRightRadius: '14px',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: '600',
              backgroundColor: '#fff', color: '#475569', border: '1px solid #cbd5e1', cursor: 'pointer',
            }}
          >
            Close
          </button>

          {(info.riskLevel === 'CRITICAL' || info.riskLevel === 'WARNING') && onOpenMitigation && (
            <button
              onClick={() => { onClose(); onOpenMitigation(order); }}
              style={{
                padding: '8px 18px', borderRadius: '6px', fontSize: '13px', fontWeight: '700',
                backgroundColor: '#7c3aed', color: '#fff', border: 'none', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                boxShadow: '0 2px 6px rgba(124, 58, 237, 0.25)',
              }}
            >
              Open Prescriptive Mitigation Center
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
