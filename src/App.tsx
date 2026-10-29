import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ReferenceLine,
  Label,
} from "recharts"
import OrdersTable from "./components/OrdersTable"
import RiskBadge from "./components/RiskBadge"
// @ts-ignore
import DataIngestionModal from "./DataIngestionModal.jsx"
// @ts-ignore
import SpendAnalyticsView from "./SpendAnalyticsView.jsx"
// @ts-ignore
import VendorScorecardsView from "./VendorScorecardsView.jsx"
// @ts-ignore
import OrderRiskExplanationModal from "./OrderRiskExplanationModal.jsx"
import {
  classifyRisk,
  fetchProcessedOrders,
  supabase,
  type Order,
  type RiskLevel,
} from "./lib/orders"

type Tab = "overview" | "spend" | "vendors"
type LoadState = "loading" | "ready" | "error"

interface ScenarioConfig {
  enabled: boolean
  serviceLevelZ: number
  leadTimeDelay: number
  volatilityMultiplier: number
  demandMultiplier: number
}

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return currencyFormatter.format(value)
}

function SpendSenseLogo() {
  return (
    <svg className="flow-guard-logo" viewBox="0 0 40 40" role="img" aria-label="SpendSense">
      <path
        d="M20 4.5 32 9v9.2c0 7.8-4.7 13.8-12 17.3-7.3-3.5-12-9.5-12-17.3V9l12-4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <path
        d="M12 18h16M12 23h11"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.4"
      />
    </svg>
  )
}

// ── Vendor Ranking Tooltip for Recharts ───────────────────────────────────────
function VendorRankingTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div
      style={{
        background: "#17201f",
        color: "#faf9f5",
        padding: "10px 14px",
        borderRadius: "4px",
        fontSize: "12px",
        lineHeight: 1.6,
        boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: "4px" }}>Vendor {d.name}</div>
      <div>
        Predicted σL: <strong>{d.sigma_l}</strong>
      </div>
      <div>
        Average lead time: <strong>{d.mu_l} days</strong>
      </div>
      <div>
        Orders in fleet: <strong>{d.orderCount}</strong>
      </div>
      <div>
        Buffer capital locked: <strong>{formatMoney(d.totalLocked)}</strong>
      </div>
      <div style={{ marginTop: "4px", fontWeight: 700, color: d.statusColor }}>
        {d.status} {d.coldStart ? "(Cold-Start Baseline)" : ""}
      </div>
    </div>
  )
}

// ── Vendor Delivery History Modal ───────────────────────────────────────────
function buildHistogram(values: number[], bucketSize = 1) {
  if (!values.length) return []
  const min = Math.floor(Math.min(...values))
  const max = Math.ceil(Math.max(...values))
  const buckets = []
  for (let lo = min; lo < max; lo += bucketSize) {
    const hi = lo + bucketSize
    buckets.push({ bucket: `${lo}–${hi}`, count: values.filter((v) => v >= lo && v < hi).length })
  }
  if (buckets.length > 0) buckets[buckets.length - 1].count += values.filter((v) => v === max).length
  return buckets
}

function VendorModal({
  vendorId,
  onClose,
  onOpenMitigation,
}: {
  vendorId: string
  onClose: () => void
  onOpenMitigation?: (vendorId: string) => void
}) {
  const [history, setHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!vendorId) return
    let active = true
    supabase
      .from("orders")
      .select("po_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,order_date,risk_status")
      .eq("vendor_id", vendorId)
      .order("order_date", { ascending: true })
      .limit(500)
      .then(({ data }) => {
        if (!active) return
        const rows = (data || [])
          .filter((r) => r.actual_lead_time != null)
          .map((r, i) => ({
            index: i + 1,
            lt: Number(r.actual_lead_time),
            po_id: r.po_id,
            date: r.order_date ? String(r.order_date).slice(0, 10) : `#${i + 1}`,
            muL: Number(r.predicted_mu_l) || 7.0,
            sigmaL: Number(r.predicted_sigma_l) || 2.0,
          }))
        setHistory(rows)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [vendorId])

  const ltValues = history.map((r) => r.lt)
  const muL = history[0]?.muL ?? 7.0
  const sigmaL = history[0]?.sigmaL ?? 2.0
  const histogram = buildHistogram(ltValues, 1)

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(23, 32, 31, 0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line-strong)",
          borderRadius: "4px",
          width: "min(100%, 860px)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "28px 32px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
          <div>
            <p className="eyebrow" style={{ marginBottom: "6px" }}>Historical Lead-Time Distribution</p>
            <h2 style={{ fontSize: "24px", margin: 0 }}>Vendor {vendorId} Performance Profile</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid var(--line)",
              padding: "4px 10px",
              cursor: "pointer",
              borderRadius: "2px",
              fontWeight: 600,
            }}
          >
            Close
          </button>
        </div>

        {loading ? (
          <p style={{ color: "var(--ink-soft)" }}>Loading historical delivery events…</p>
        ) : history.length === 0 ? (
          <p style={{ color: "var(--ink-soft)" }}>No verified shipment deliveries found for vendor {vendorId}.</p>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px", marginBottom: "24px" }}>
              <div style={{ background: "var(--surface-strong)", padding: "12px 14px", border: "1px solid var(--line)" }}>
                <span style={{ fontSize: "11px", color: "var(--ink-faint)", textTransform: "uppercase" }}>Deliveries</span>
                <strong style={{ display: "block", fontSize: "20px" }}>{history.length}</strong>
              </div>
              <div style={{ background: "var(--surface-strong)", padding: "12px 14px", border: "1px solid var(--line)" }}>
                <span style={{ fontSize: "11px", color: "var(--ink-faint)", textTransform: "uppercase" }}>Mean Lead Time (µL)</span>
                <strong style={{ display: "block", fontSize: "20px" }}>{muL.toFixed(1)} d</strong>
              </div>
              <div style={{ background: "var(--surface-strong)", padding: "12px 14px", border: "1px solid var(--line)" }}>
                <span style={{ fontSize: "11px", color: "var(--ink-faint)", textTransform: "uppercase" }}>Volatility (σL)</span>
                <strong style={{ display: "block", fontSize: "20px", color: sigmaL > 1.85 ? "var(--critical)" : "var(--teal)" }}>
                  {sigmaL.toFixed(2)} d
                </strong>
              </div>
            </div>

            <div style={{ marginBottom: "24px" }}>
              <h4 style={{ fontSize: "13px", margin: "0 0 10px", color: "var(--ink-soft)" }}>
                Delivery History Timeline (Actual Lead Time vs Mean Band)
              </h4>
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="index" name="Order #" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="lt" name="Lead Time" tick={{ fontSize: 11 }} unit=" d" />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} />
                  <ReferenceLine y={muL} stroke="#1e655e" strokeWidth={2} label={{ value: `µL: ${muL.toFixed(1)}d`, fill: "#1e655e", fontSize: 10 }} />
                  <ReferenceLine y={muL + sigmaL} stroke="#a43c33" strokeDasharray="3 3" label={{ value: "+1σ", fill: "#a43c33", fontSize: 10 }} />
                  <Scatter name="Actual Deliveries" data={history} fill="#1e655e" />
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            <div>
              <h4 style={{ fontSize: "13px", margin: "0 0 10px", color: "var(--ink-soft)" }}>
                Lead-Time Frequency Histogram (1-day increments)
              </h4>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={histogram} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} unit="d" />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#1e655e" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Prescriptive Dual-Sourcing Mitigation Modal ──────────────────────────────
function MitigationModal({
  order,
  allOrders,
  onClose,
}: {
  order: Order
  allOrders: Order[]
  onClose: () => void
}) {
  const currentVendor = order.vendorId
  const currentSigma = order.predictedSigmaL ?? 2.0
  const currentSS = order.safetyStock
  const currentCapital = currentSS * order.unitPrice

  // Candidate vendor discovery
  const candidates = useMemo(() => {
    const map = new Map<string, { vid: string; muL: number; sigmaL: number; count: number }>()
    allOrders.forEach((o) => {
      const vid = o.vendorId
      if (vid !== currentVendor && o.predictedSigmaL !== null) {
        if (!map.has(vid)) {
          map.set(vid, {
            vid,
            muL: o.predictedMuL ?? 7.0,
            sigmaL: o.predictedSigmaL ?? 2.0,
            count: 1,
          })
        } else {
          map.get(vid)!.count += 1
        }
      }
    })

    return Array.from(map.values())
      .filter((c) => c.sigmaL < currentSigma)
      .map((c) => {
        const estSS = Math.round(1.65 * Math.sqrt(c.muL * 9 + 100 * Math.pow(c.sigmaL, 2)))
        const estCapital = estSS * order.unitPrice
        const savings = Math.max(0, currentCapital - estCapital)
        return {
          ...c,
          recommendedSS: estSS,
          capitalLocked: estCapital,
          savings,
          reliability: Math.min(98, Math.max(60, Math.round(100 - c.sigmaL * 25 + Math.min(c.count * 1.5, 15)))),
        }
      })
      .sort((a, b) => b.savings - a.savings)
      .slice(0, 3)
  }, [allOrders, currentVendor, currentSigma, currentCapital, order.unitPrice])

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(23, 32, 31, 0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line-strong)",
          borderRadius: "4px",
          width: "min(100%, 780px)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "28px 32px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
          <div>
            <p className="eyebrow" style={{ color: "var(--critical)", marginBottom: "6px" }}>Prescriptive Risk Mitigation</p>
            <h2 style={{ fontSize: "24px", margin: 0 }}>Alternative Supplier Reallocation</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid var(--line)",
              padding: "4px 10px",
              cursor: "pointer",
              borderRadius: "2px",
              fontWeight: 600,
            }}
          >
            Close
          </button>
        </div>

        <div style={{ background: "var(--surface-strong)", border: "1px solid var(--line)", padding: "16px 20px", marginBottom: "24px" }}>
          <span style={{ fontSize: "11px", color: "var(--ink-faint)", textTransform: "uppercase" }}>Current Incumbent Supplier</span>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "4px" }}>
            <strong style={{ fontSize: "18px" }}>{order.vendorId} (PO {order.poId})</strong>
            <span style={{ color: "var(--critical)", fontWeight: 700 }}>
              Lead-time volatility σL: {currentSigma.toFixed(2)}d
            </span>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: "13px", color: "var(--ink-soft)" }}>
            High volatility forces an elevated buffer of <strong>{currentSS} units</strong>, locking up{" "}
            <strong>{formatMoney(currentCapital)}</strong> in working capital.
          </p>
        </div>

        <h3 style={{ fontSize: "15px", margin: "0 0 12px" }}>Recommended Vetted Alternatives (Lower Variance)</h3>

        {candidates.length === 0 ? (
          <p style={{ color: "var(--ink-soft)" }}>No lower-variance suppliers currently available in database.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "24px" }}>
            {candidates.map((cand, idx) => (
              <div
                key={cand.vid}
                style={{
                  background: "var(--surface-strong)",
                  border: "1px solid var(--line)",
                  borderLeft: "4px solid var(--teal)",
                  padding: "16px 20px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div>
                    <span style={{ fontSize: "11px", color: "var(--ink-faint)" }}>Option #{idx + 1}</span>
                    <strong style={{ display: "block", fontSize: "16px" }}>Supplier {cand.vid}</strong>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: "11px", color: "var(--teal)", fontWeight: 700 }}>Reliability: {cand.reliability}%</span>
                    <strong style={{ display: "block", fontSize: "16px", color: "var(--teal)" }}>
                      +{formatMoney(cand.savings)} Capital Unlocked
                    </strong>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginTop: "12px", fontSize: "12px", color: "var(--ink-soft)" }}>
                  <div>Predicted σL: <strong>{cand.sigmaL.toFixed(2)}d</strong></div>
                  <div>Recommended Buffer: <strong>{cand.recommendedSS} units</strong></div>
                  <div>Working Capital: <strong>{formatMoney(cand.capitalLocked)}</strong></div>
                </div>

                <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px dashed var(--line)", fontSize: "12px", color: "var(--ink)" }}>
                  <strong>Policy Recommendation:</strong> Execute a <strong>70% / 30% dual-sourcing split</strong>. Allocate 70% of upcoming PO quantity to {cand.vid} to capture buffer savings while maintaining 30% volume with {order.vendorId} for relationship continuity.
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main App Shell with Unified Navigation Rail ──────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("overview")
  const [isRailCollapsed, setIsRailCollapsed] = useState(false)
  const [orders, setOrders] = useState<Order[]>([])
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [errorMessage, setErrorMessage] = useState("")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Interactive Modals State
  const [isIngestionOpen, setIsIngestionOpen] = useState(false)
  const [selectedVendorModal, setSelectedVendorModal] = useState<string | null>(null)
  const [explainingOrder, setExplainingOrder] = useState<Order | null>(null)
  const [mitigatingOrder, setMitigatingOrder] = useState<Order | null>(null)
  const [isScenarioOpen, setIsScenarioOpen] = useState(false)

  // What-If Simulation Config
  const [scenario, setScenario] = useState<ScenarioConfig>({
    enabled: false,
    serviceLevelZ: 1.65,
    leadTimeDelay: 0,
    volatilityMultiplier: 1.0,
    demandMultiplier: 1.0,
  })

  const loadOrders = useCallback(async (refresh = false) => {
    if (refresh) setIsRefreshing(true)
    else setLoadState("loading")

    setErrorMessage("")

    try {
      const nextOrders = await fetchProcessedOrders()
      setOrders(nextOrders)
      setLastUpdated(new Date())
      setLoadState("ready")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load orders from Supabase."
      setErrorMessage(message)
      if (!refresh) setLoadState("error")
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  // Summary Metrics Computation
  const summaryMetrics = useMemo(() => {
    const totalOrders = orders.length
    let criticalCount = 0
    let warningCount = 0
    let normalCount = 0
    let totalCapitalLocked = 0
    let totalCostOfRisk = 0

    orders.forEach((o) => {
      const risk = classifyRisk(o.predictedSigmaL, o.riskStatus)
      if (risk === "CRITICAL") criticalCount++
      else if (risk === "WARNING") warningCount++
      else if (risk === "NORMAL") normalCount++

      const price = o.unitPrice > 0 ? o.unitPrice : 35.0
      const cap = o.safetyStock * price
      const riskCost = (o.predictedSigmaL ?? 2.0) * (o.reorderPoint > o.safetyStock ? (o.reorderPoint - o.safetyStock) / 7.0 : 5.0) * price
      totalCapitalLocked += cap
      totalCostOfRisk += riskCost
    })

    return {
      totalOrders,
      criticalCount,
      warningCount,
      normalCount,
      totalCapitalLocked,
      totalCostOfRisk,
    }
  }, [orders])

  // Distribution percentages
  const distribution = useMemo(() => {
    const total = orders.length || 1
    return ([
      { risk: "CRITICAL" as RiskLevel, count: summaryMetrics.criticalCount, percentage: (summaryMetrics.criticalCount / total) * 100 },
      { risk: "WARNING" as RiskLevel, count: summaryMetrics.warningCount, percentage: (summaryMetrics.warningCount / total) * 100 },
      { risk: "NORMAL" as RiskLevel, count: summaryMetrics.normalCount, percentage: (summaryMetrics.normalCount / total) * 100 },
    ])
  }, [orders.length, summaryMetrics])

  // Top 20 Vendors by Volatility
  const vendorRankingData = useMemo(() => {
    const vendorMap = new Map<string, { name: string; sigma_l: number; mu_l: number; orderCount: number; totalLocked: number; status: string; statusColor: string; coldStart: boolean }>()

    orders.forEach((o) => {
      const vid = o.vendorId
      const sig = o.predictedSigmaL ?? 2.0
      const mul = o.predictedMuL ?? 7.0
      const cap = o.safetyStock * o.unitPrice
      const risk = classifyRisk(sig, o.riskStatus)
      const isCold = Boolean(o.riskStatus && o.riskStatus.startsWith("COLD_"))
      const color = risk === "CRITICAL" ? "#a43c33" : risk === "WARNING" ? "#93651d" : "#3f6755"

      if (!vendorMap.has(vid)) {
        vendorMap.set(vid, {
          name: vid,
          sigma_l: Number(sig.toFixed(2)),
          mu_l: Number(mul.toFixed(1)),
          orderCount: 1,
          totalLocked: cap,
          status: risk,
          statusColor: color,
          coldStart: isCold,
        })
      } else {
        const item = vendorMap.get(vid)!
        item.orderCount += 1
        item.totalLocked += cap
      }
    })

    return Array.from(vendorMap.values())
      .sort((a, b) => b.sigma_l - a.sigma_l)
      .slice(0, 20)
  }, [orders])

  const updatedLabel = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "Awaiting sync"

  return (
    <div className={`app-shell${isRailCollapsed ? " app-shell--rail-collapsed" : ""}`}>
      {/* ── 1. Yaman's Navigation Rail ─────────────────────────────────────── */}
      <aside className="navigation-rail" aria-label="Primary navigation">
        <div className="brand">
          <button
            className="brand__mark"
            type="button"
            onClick={() => setIsRailCollapsed((collapsed) => !collapsed)}
            aria-label={isRailCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={isRailCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <SpendSenseLogo />
          </button>
          <span className="brand__name">
            Spend
            <br />
            Sense
          </span>
        </div>

        <nav aria-label="Dashboard sections">
          <div
            className={`nav-item${activeTab === "overview" ? " nav-item--active" : ""}`}
            onClick={() => setActiveTab("overview")}
            role="button"
            tabIndex={0}
          >
            <span className="nav-item__index">01</span>
            <span className="nav-item__label">Risk & Supply</span>
            <span className="nav-item__tooltip">Risk & Supply: monitor order risk and supply volatility</span>
          </div>

          <div
            className={`nav-item${activeTab === "spend" ? " nav-item--active" : ""}`}
            onClick={() => setActiveTab("spend")}
            role="button"
            tabIndex={0}
          >
            <span className="nav-item__index">02</span>
            <span className="nav-item__label">Spend Analytics</span>
            <span className="nav-item__tooltip">Spend Analytics: review purchasing and vendor concentration</span>
          </div>

          <div
            className={`nav-item${activeTab === "vendors" ? " nav-item--active" : ""}`}
            onClick={() => setActiveTab("vendors")}
            role="button"
            tabIndex={0}
          >
            <span className="nav-item__index">03</span>
            <span className="nav-item__label">Vendor Scores</span>
            <span className="nav-item__tooltip">Vendor Scores: compare supplier performance and reliability</span>
          </div>
        </nav>
      </aside>

      {/* ── 2. Main Content Area ───────────────────────────────────────────── */}
      <main className="main-content">
        <header className="page-header">
          <div className="page-header__copy">
            <p className="eyebrow">
              {activeTab === "overview" && "Operations Control / Lead-Time Volatility"}
              {activeTab === "spend" && "Executive Procurement / Spend Analytics"}
              {activeTab === "vendors" && "Supplier Performance / SLA Track Record"}
            </p>
            <h1>
              {activeTab === "overview" && "Supply chain risk & mitigation"}
              {activeTab === "spend" && "Spend concentration & HHI analytics"}
              {activeTab === "vendors" && "Vendor historical scorecards"}
            </h1>
            <p>
              {activeTab === "overview" &&
                "Empirical lead-time volatility monitoring, two-stage hurdle delay inference, and risk-adjusted safety stock replenishment."}
              {activeTab === "spend" &&
                "Antitrust Herfindahl-Hirschman Index (HHI) concentration metrics, Pareto purchasing breakdown, and zero-leakage reconciliation."}
              {activeTab === "vendors" &&
                "Empirical on-time delivery percentages, average delay on slippages, and multi-tier reliability scorecards."}
            </p>
          </div>

          <div className="page-header__actions">
            <div className="sync-status" aria-live="polite">
              <span
                className={`status-dot${loadState === "error" ? " status-dot--error" : ""}`}
                aria-hidden="true"
              />
              <div>
                <strong>
                  {loadState === "error"
                    ? "Data unavailable"
                    : isRefreshing
                    ? "Refreshing data…"
                    : "Data current"}
                </strong>
                <span>Last updated {updatedLabel}</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setIsIngestionOpen(true)}
                style={{
                  minHeight: "38px",
                  padding: "0 14px",
                  border: "1px solid var(--teal)",
                  borderRadius: "2px",
                  background: "var(--teal-soft)",
                  color: "var(--teal)",
                  fontSize: "12px",
                  fontWeight: 650,
                  cursor: "pointer",
                }}
              >
                Ingest CSV
              </button>

              {activeTab === "overview" && (
                <button
                  type="button"
                  onClick={() => setIsScenarioOpen((prev) => !prev)}
                  style={{
                    minHeight: "38px",
                    padding: "0 14px",
                    border: "1px solid var(--line-strong)",
                    borderRadius: "2px",
                    background: isScenarioOpen ? "var(--ink)" : "var(--surface)",
                    color: isScenarioOpen ? "var(--surface)" : "var(--ink)",
                    fontSize: "12px",
                    fontWeight: 650,
                    cursor: "pointer",
                  }}
                >
                  What-If Simulator
                </button>
              )}

              <button
                className="refresh-button"
                type="button"
                onClick={() => void loadOrders(true)}
                disabled={isRefreshing || loadState === "loading"}
              >
                {isRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
        </header>

        {errorMessage && loadState === "ready" ? (
          <div className="inline-alert" role="alert" style={{ marginTop: "20px" }}>
            <span>Refresh failed. Stored database state remains visible.</span>
            <strong>{errorMessage}</strong>
          </div>
        ) : null}

        {/* ── 3. Tab Views ──────────────────────────────────────────────────── */}
        <div className="content-stack" style={{ marginTop: "34px" }}>
          {activeTab === "overview" && (
            <>
              {/* Numbered Metrics Grid */}
              <div className="metrics-grid">
                <article className="metric">
                  <div className="metric__header">
                    <span className="metric__marker metric__marker--neutral" />
                    <span>01</span>
                  </div>
                  <strong>{numberFormatter.format(summaryMetrics.totalOrders)}</strong>
                  <span className="metric__label">Orders Monitored</span>
                  <span className="metric__note">Active purchase records</span>
                </article>

                <article className="metric">
                  <div className="metric__header">
                    <span className="metric__marker metric__marker--critical" />
                    <span>02</span>
                  </div>
                  <strong>{numberFormatter.format(summaryMetrics.criticalCount)}</strong>
                  <span className="metric__label">Critical Volatility</span>
                  <span className="metric__note">σL above 1.85 days</span>
                </article>

                <article className="metric">
                  <div className="metric__header">
                    <span className="metric__marker metric__marker--warning" />
                    <span>03</span>
                  </div>
                  <strong>{numberFormatter.format(summaryMetrics.warningCount)}</strong>
                  <span className="metric__label">Warning Volatility</span>
                  <span className="metric__note">1.65 &lt; σL ≤ 1.85 days</span>
                </article>

                <article className="metric">
                  <div className="metric__header">
                    <span className="metric__marker metric__marker--normal" />
                    <span>04</span>
                  </div>
                  <strong>{numberFormatter.format(summaryMetrics.normalCount)}</strong>
                  <span className="metric__label">Normal Stability</span>
                  <span className="metric__note">Consistent supplier lead times</span>
                </article>

                <article className="metric">
                  <div className="metric__header">
                    <span className="metric__marker metric__marker--neutral" />
                    <span>05</span>
                  </div>
                  <strong>{formatMoney(summaryMetrics.totalCapitalLocked)}</strong>
                  <span className="metric__label">Buffer Capital Locked</span>
                  <span className="metric__note">Tied up in safety stock</span>
                </article>

                <article className="metric">
                  <div className="metric__header">
                    <span className="metric__marker metric__marker--warning" />
                    <span>06</span>
                  </div>
                  <strong>{formatMoney(summaryMetrics.totalCostOfRisk)}</strong>
                  <span className="metric__label">Total Cost of Risk</span>
                  <span className="metric__note">Expected volatility exposure</span>
                </article>
              </div>

              {/* Distribution Bar */}
              <div className="distribution" style={{ marginTop: "24px" }}>
                <div className="distribution__intro">
                  <span className="distribution__title">Fleet Risk Profile</span>
                  <span>Categorized by lead-time standard deviation</span>
                </div>
                <div className="distribution__bar" role="img">
                  {distribution.map(({ risk, percentage }) =>
                    percentage > 0 ? (
                      <span
                        className={`distribution__segment distribution__segment--${risk.toLowerCase()}`}
                        key={risk}
                        style={{ width: `${percentage}%` }}
                      />
                    ) : null
                  )}
                </div>
                <div className="distribution__legend">
                  {distribution.map(({ risk, count, percentage }) => (
                    <div className="distribution__item" key={risk}>
                      <RiskBadge risk={risk} compact />
                      <strong>{count}</strong>
                      <span>{percentage.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* What-If Simulation Controls Panel */}
              {isScenarioOpen && (
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--line-strong)",
                    padding: "20px 24px",
                    marginTop: "24px",
                    borderRadius: "2px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "16px" }}>
                    <div>
                      <span className="eyebrow" style={{ color: "var(--teal)", marginBottom: "4px" }}>Policy Stress Testing</span>
                      <h3 style={{ margin: 0, fontSize: "16px" }}>What-If Disruption Scenario Simulator</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setScenario({
                          enabled: false,
                          serviceLevelZ: 1.65,
                          leadTimeDelay: 0,
                          volatilityMultiplier: 1.0,
                          demandMultiplier: 1.0,
                        })
                      }
                      style={{
                        background: "none",
                        border: "1px solid var(--line)",
                        fontSize: "11px",
                        padding: "3px 8px",
                        cursor: "pointer",
                      }}
                    >
                      Reset Scenario
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                    <div>
                      <label style={{ fontSize: "12px", color: "var(--ink-soft)", display: "block", marginBottom: "6px" }}>
                        Lead Time Delay: +{scenario.leadTimeDelay} days
                      </label>
                      <input
                        type="range"
                        min="0"
                        max="14"
                        step="1"
                        value={scenario.leadTimeDelay}
                        onChange={(e) => setScenario({ ...scenario, enabled: true, leadTimeDelay: Number(e.target.value) })}
                        style={{ width: "100%" }}
                      />
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", color: "var(--ink-soft)", display: "block", marginBottom: "6px" }}>
                        Volatility Spike: {scenario.volatilityMultiplier.toFixed(1)}x
                      </label>
                      <input
                        type="range"
                        min="1"
                        max="3"
                        step="0.1"
                        value={scenario.volatilityMultiplier}
                        onChange={(e) => setScenario({ ...scenario, enabled: true, volatilityMultiplier: Number(e.target.value) })}
                        style={{ width: "100%" }}
                      />
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", color: "var(--ink-soft)", display: "block", marginBottom: "6px" }}>
                        Demand Surge: {scenario.demandMultiplier.toFixed(1)}x
                      </label>
                      <input
                        type="range"
                        min="1"
                        max="3"
                        step="0.1"
                        value={scenario.demandMultiplier}
                        onChange={(e) => setScenario({ ...scenario, enabled: true, demandMultiplier: Number(e.target.value) })}
                        style={{ width: "100%" }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Vendor Ranking BarChart */}
              {vendorRankingData.length > 0 && (
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    padding: "24px 28px",
                    marginTop: "24px",
                  }}
                >
                  <div style={{ marginBottom: "16px" }}>
                    <p className="eyebrow" style={{ marginBottom: "4px" }}>Supplier Uncertainty Ranking</p>
                    <h3 style={{ margin: 0, fontSize: "16px" }}>Top 20 Vendors by Lead-Time Volatility (σL)</h3>
                    <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--ink-soft)" }}>
                      Click any bar to inspect historical delivery records and scatter distributions.
                    </p>
                  </div>

                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={vendorRankingData}
                      margin={{ top: 10, right: 30, left: 0, bottom: 40 }}
                      onClick={(e: any) => e?.activePayload?.[0] && setSelectedVendorModal(e.activePayload[0].payload.name)}
                      style={{ cursor: "pointer" }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" interval={0} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toFixed(1)}>
                        <Label value="σL (days)" angle={-90} position="insideLeft" style={{ fontSize: 11, fill: "#858c88" }} />
                      </YAxis>
                      <Tooltip content={<VendorRankingTooltip />} />
                      <ReferenceLine y={1.85} stroke="#a43c33" strokeDasharray="3 3" label={{ value: "Critical (1.85d)", fill: "#a43c33", fontSize: 10 }} />
                      <ReferenceLine y={1.65} stroke="#93651d" strokeDasharray="3 3" label={{ value: "Warning (1.65d)", fill: "#93651d", fontSize: 10 }} />
                      <Bar dataKey="sigma_l" fill="#1e655e" maxBarSize={32} radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Enhanced Orders Table */}
              <div style={{ marginTop: "28px" }}>
                <OrdersTable
                  orders={orders}
                  onExplain={(ord) => setExplainingOrder(ord)}
                  onMitigate={(ord) => setMitigatingOrder(ord)}
                  onInspectVendor={(vid) => setSelectedVendorModal(vid)}
                />
              </div>
            </>
          )}

          {activeTab === "spend" && <SpendAnalyticsView orders={orders} />}

          {activeTab === "vendors" && (
            <VendorScorecardsView
              orders={orders}
              onInspectVendor={(vid: string) => setSelectedVendorModal(vid)}
              onMitigateVendor={(vid: string) => {
                const sample = orders.find((o) => o.vendorId === vid)
                if (sample) setMitigatingOrder(sample)
              }}
            />
          )}
        </div>

        <footer className="page-footer" style={{ marginTop: "48px" }}>
          <span>SpendSense Risk-Aware Replenishment & Spend Analytics</span>
          <span>Final Year Project Defense System</span>
        </footer>
      </main>

      {/* ── 4. Unified Interactive Modals ──────────────────────────────────── */}
      {isIngestionOpen && (
        <DataIngestionModal
          onClose={() => setIsIngestionOpen(false)}
          onSuccess={() => {
            setIsIngestionOpen(false)
            void loadOrders(true)
          }}
        />
      )}

      {selectedVendorModal && (
        <VendorModal
          vendorId={selectedVendorModal}
          onClose={() => setSelectedVendorModal(null)}
          onOpenMitigation={(vid) => {
            const sample = orders.find((o) => o.vendorId === vid)
            if (sample) setMitigatingOrder(sample)
          }}
        />
      )}

      {explainingOrder && (
        <OrderRiskExplanationModal
          order={explainingOrder}
          onClose={() => setExplainingOrder(null)}
        />
      )}

      {mitigatingOrder && (
        <MitigationModal
          order={mitigatingOrder}
          allOrders={orders}
          onClose={() => setMitigatingOrder(null)}
        />
      )}
    </div>
  )
}
