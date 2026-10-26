import { useCallback, useEffect, useMemo, useState } from "react"
import OrdersTable from "./components/OrdersTable"
import RiskBadge from "./components/RiskBadge"
import {
  classifyRisk,
  fetchProcessedOrders,
  type Order,
  type RiskLevel,
} from "./lib/orders"

type LoadState = "loading" | "ready" | "error"

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

function LoadingDashboard() {
  return (
    <div className="loading-layout" aria-hidden="true">
      <div className="skeleton skeleton--metrics" />
      <div className="skeleton skeleton--table" />
    </div>
  )
}

function EmptyState() {
  return (
    <section className="state-panel" aria-labelledby="empty-title">
      <span className="state-panel__index">00</span>
      <div>
        <h2 id="empty-title">No processed orders yet</h2>
        <p>
          The live connection is working, but no orders with recommended safety
          stock are available. Run the existing analysis pipeline, then refresh
          this view.
        </p>
      </div>
    </section>
  )
}

function FlowGuardLogo() {
  return (
    <svg
      className="flow-guard-logo"
      viewBox="0 0 40 40"
      role="img"
      aria-label="Flow Guard"
    >
      <path
        d="M20 4.5 32 9v9.2c0 7.8-4.7 13.8-12 17.3-7.3-3.5-12-9.5-12-17.3V9l12-4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <path
        d="M11.5 16.2c3.1-3.2 6.1-3.2 9.1 0s6 3.2 8.9 0M11.5 22.9c3.1-3.2 6.1-3.2 9.1 0s6 3.2 8.9 0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.4"
      />
    </svg>
  )
}

interface OverviewProps {
  orders: Order[]
}

function Overview({ orders }: OverviewProps) {
  const counts = useMemo(() => {
    const totals: Record<RiskLevel, number> = {
      CRITICAL: 0,
      WARNING: 0,
      NORMAL: 0,
      UNAVAILABLE: 0,
    }

    orders.forEach((order) => {
      totals[classifyRisk(order.predictedSigmaL)] += 1
    })

    return totals
  }, [orders])

  const total = orders.length
  const distribution = ([
    "CRITICAL",
    "WARNING",
    "NORMAL",
    "UNAVAILABLE",
  ] as RiskLevel[]).map((risk) => ({
    risk,
    count: counts[risk],
    percentage: total === 0 ? 0 : (counts[risk] / total) * 100,
  }))

  const metrics = [
    {
      label: "Orders monitored",
      value: numberFormatter.format(total),
      note: "Processed records",
      tone: "neutral",
    },
    {
      label: "Critical",
      value: numberFormatter.format(counts.CRITICAL),
      note: "σL above 1.85",
      tone: "critical",
    },
    {
      label: "Warning",
      value: numberFormatter.format(counts.WARNING),
      note: "1.65 < σL ≤ 1.85",
      tone: "warning",
    },
    {
      label: "Normal",
      value: numberFormatter.format(counts.NORMAL),
      note: "σL at or below 1.65",
      tone: "normal",
    },
  ]

  return (
    <section className="overview" aria-labelledby="overview-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Current exposure</p>
          <h2 id="overview-title">Risk posture at a glance</h2>
        </div>
        <p className="section-heading__support">
          Classification is calculated from the latest processed lead-time
          variability.
        </p>
      </div>

      <div className="metrics-grid">
        {metrics.map((metric, index) => (
          <article className="metric" key={metric.label}>
            <div className="metric__header">
              <span
                className={`metric__marker metric__marker--${metric.tone}`}
              />
              <span>{String(index + 1).padStart(2, "0")}</span>
            </div>
            <strong>{metric.value}</strong>
            <span className="metric__label">{metric.label}</span>
            <span className="metric__note">{metric.note}</span>
          </article>
        ))}
      </div>

      <div className="distribution">
        <div className="distribution__intro">
          <span className="distribution__title">Distribution</span>
          <span>
            {counts.UNAVAILABLE > 0
              ? `${counts.UNAVAILABLE} unclassified`
              : "All records classified"}
          </span>
        </div>
        <div
          className="distribution__bar"
          role="img"
          aria-label={distribution
            .map(
              ({ risk, count, percentage }) =>
                `${risk.toLowerCase()}: ${count}, ${percentage.toFixed(1)}%`,
            )
            .join("; ")}
        >
          {distribution.map(({ risk, count, percentage }) =>
            count > 0 ? (
              <span
                className={`distribution__segment distribution__segment--${risk.toLowerCase()}`}
                key={risk}
                style={{ width: `${percentage}%` }}
              />
            ) : null,
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
    </section>
  )
}

export default function App() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [errorMessage, setErrorMessage] = useState("")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

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
      const message =
        error instanceof Error ? error.message : "Unable to load orders."
      setErrorMessage(message)
      if (!refresh) setLoadState("error")
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  const updatedLabel = lastUpdated
    ? lastUpdated.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Awaiting sync"
  const connectionLabel =
    loadState === "error"
      ? "Connection unavailable"
      : loadState === "loading"
        ? "Connecting to Supabase"
        : "Supabase connected"

  return (
    <div className="app-shell">
      <aside className="navigation-rail" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand__mark">
            <FlowGuardLogo />
          </span>
          <span className="brand__name">
            Flow
            <br />
            Guard
          </span>
        </div>

        <nav aria-label="Dashboard sections">
          <span className="nav-item nav-item--active" aria-current="page">
            <span className="nav-item__index">01</span>
            Overview
          </span>
        </nav>

        <div className="rail-status">
          <span
            className={`status-dot${
              loadState === "error" ? " status-dot--error" : ""
            }`}
            aria-hidden="true"
          />
          <div>
            <strong>Live dataset</strong>
            <span>{connectionLabel}</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="page-header">
          <div className="page-header__copy">
            <p className="eyebrow">Operations control / Live orders</p>
            <h1>Supply chain risk overview</h1>
            <p>
              Monitor lead-time variability and prioritize orders requiring
              safety-stock attention.
            </p>
          </div>

          <div className="page-header__actions">
            <div className="sync-status" aria-live="polite">
              <span
                className={`status-dot${
                  loadState === "error" ? " status-dot--error" : ""
                }`}
                aria-hidden="true"
              />
              <div>
                <strong>
                  {loadState === "error"
                    ? "Data unavailable"
                    : isRefreshing
                      ? "Refreshing data"
                      : "Data current"}
                </strong>
                <span>Last updated {updatedLabel}</span>
              </div>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void loadOrders(true)}
              disabled={isRefreshing || loadState === "loading"}
            >
              {isRefreshing ? "Refreshing…" : "Refresh data"}
            </button>
          </div>
        </header>

        {errorMessage && loadState === "ready" ? (
          <div className="inline-alert" role="alert">
            <span>Refresh failed. Existing data remains visible.</span>
            <strong>{errorMessage}</strong>
          </div>
        ) : null}

        <div className="content-stack">
          {loadState === "loading" ? (
            <>
              <span className="sr-only">Loading live order predictions.</span>
              <LoadingDashboard />
            </>
          ) : loadState === "error" ? (
            <section className="state-panel state-panel--error" role="alert">
              <span className="state-panel__index">!</span>
              <div>
                <h2>Live order data is unavailable</h2>
                <p>{errorMessage}</p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void loadOrders()}
                >
                  Try again
                </button>
              </div>
            </section>
          ) : orders.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <Overview orders={orders} />
              <OrdersTable orders={orders} />
            </>
          )}
        </div>

        <footer className="page-footer">
          <span>Live operational view</span>
          <span>Showing up to 500 processed orders</span>
        </footer>
      </main>
    </div>
  )
}
