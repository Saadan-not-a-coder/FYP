import { useMemo, useState } from "react"
import { classifyRisk, type Order, type RiskLevel } from "../lib/orders"
import RiskBadge from "./RiskBadge"

type RiskFilter = "ALL" | RiskLevel

interface OrdersTableProps {
  orders: Order[]
  onExplain?: (order: Order) => void
  onMitigate?: (order: Order) => void
  onInspectVendor?: (vendorId: string) => void
  onSimulate?: (order: Order) => void
}

const quantityFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

const decimalFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

function formatNumber(
  value: number | null,
  formatter: Intl.NumberFormat,
): string {
  return value === null ? "—" : formatter.format(value)
}

function exportToCsv(orders: Order[]) {
  const headers = [
    "Purchase Order",
    "Vendor ID",
    "SKU ID",
    "Actual Lead Time",
    "Predicted Mu_L",
    "Predicted Sigma_L",
    "Safety Stock",
    "Reorder Point",
    "Unit Price",
    "Capital Locked",
    "Risk Status",
  ]
  const rows = orders.map((o) => [
    o.poId,
    o.vendorId,
    o.skuId,
    o.actualLeadTime ?? "",
    o.predictedMuL ?? "",
    o.predictedSigmaL ?? "",
    o.safetyStock,
    o.reorderPoint,
    o.unitPrice,
    o.safetyStock * o.unitPrice,
    o.riskStatus,
  ])

  const csvContent =
    "data:text/csv;charset=utf-8," +
    [headers.join(","), ...rows.map((e) => e.join(","))].join("\n")
  const encodedUri = encodeURI(csvContent)
  const link = document.createElement("a")
  link.setAttribute("href", encodedUri)
  link.setAttribute("download", `spendsense_orders_${new Date().toISOString().slice(0, 10)}.csv`)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export default function OrdersTable({
  orders,
  onExplain,
  onMitigate,
  onInspectVendor,
  onSimulate,
}: OrdersTableProps) {
  const [query, setQuery] = useState("")
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("ALL")

  const filteredOrders = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()

    return orders.filter((order) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        order.poId.toLocaleLowerCase().includes(normalizedQuery) ||
        order.vendorId.toLocaleLowerCase().includes(normalizedQuery) ||
        order.skuId.toLocaleLowerCase().includes(normalizedQuery)
      const matchesRisk =
        riskFilter === "ALL" ||
        classifyRisk(order.predictedSigmaL, order.riskStatus) === riskFilter

      return matchesQuery && matchesRisk
    })
  }, [orders, query, riskFilter])

  const hasFilters = query.trim().length > 0 || riskFilter !== "ALL"

  function clearFilters() {
    setQuery("")
    setRiskFilter("ALL")
  }

  return (
    <section className="orders-panel" aria-labelledby="orders-title">
      <div className="section-heading section-heading--table">
        <div>
          <p className="eyebrow">Exception Workspace</p>
          <h2 id="orders-title">Monitored Purchase Orders</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <p className="result-count" aria-live="polite">
            <strong>{filteredOrders.length}</strong> of {orders.length} orders
          </p>
          <button
            type="button"
            onClick={() => exportToCsv(filteredOrders)}
            style={{
              padding: "6px 12px",
              fontSize: "11px",
              fontWeight: 600,
              background: "var(--surface)",
              color: "var(--ink)",
              border: "1px solid var(--line-strong)",
              borderRadius: "2px",
              cursor: "pointer",
            }}
          >
            📥 Export CSV
          </button>
        </div>
      </div>

      <div className="table-toolbar">
        <label className="field field--search">
          <span>Search orders</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search PO, vendor, or SKU…"
          />
        </label>
        <label className="field field--filter">
          <span>Risk level</span>
          <select
            value={riskFilter}
            onChange={(event) =>
              setRiskFilter(event.target.value as RiskFilter)
            }
          >
            <option value="ALL">All risk levels</option>
            <option value="CRITICAL">Critical</option>
            <option value="WARNING">Warning</option>
            <option value="NORMAL">Normal</option>
            <option value="UNAVAILABLE">Unavailable</option>
          </select>
        </label>
        {hasFilters ? (
          <button className="clear-button" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        ) : (
          <span className="sort-note">Sorted by highest predicted σL</span>
        )}
      </div>

      {filteredOrders.length === 0 ? (
        <div className="no-results">
          <span className="no-results__index">0</span>
          <div>
            <h3>No matching orders</h3>
            <p>Adjust your search query or risk filter to view available purchase records.</p>
          </div>
          <button className="text-button" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption>
                Live purchase order inventory risk parameters and predictive safety stock recommendations.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Purchase order</th>
                  <th scope="col">Vendor</th>
                  <th scope="col">SKU</th>
                  <th className="numeric" scope="col">Actual LT</th>
                  <th className="numeric" scope="col">Predicted σL</th>
                  <th className="numeric" scope="col">Safety Stock</th>
                  <th className="numeric" scope="col">Reorder Point</th>
                  <th className="numeric" scope="col">Buffer Capital</th>
                  <th scope="col">Risk & Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order, index) => {
                  const risk = classifyRisk(order.predictedSigmaL, order.riskStatus)
                  const isCold = Boolean(order.riskStatus && order.riskStatus.startsWith("COLD_"))
                  const capitalLocked = order.safetyStock * order.unitPrice

                  return (
                    <tr
                      className={`table-row table-row--${risk.toLowerCase()}`}
                      key={`${order.poId}-${order.vendorId}-${index}`}
                      tabIndex={0}
                    >
                      <td>
                        <strong className="order-id">{order.poId}</strong>
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => onInspectVendor && onInspectVendor(order.vendorId)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "var(--teal)",
                            textDecoration: "underline",
                            cursor: "pointer",
                            fontWeight: 600,
                            textAlign: "left",
                          }}
                          title="Click to view historical lead-time distribution"
                        >
                          {order.vendorId}
                        </button>
                      </td>
                      <td>
                        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "12px", color: "var(--ink-soft)" }}>
                          {order.skuId}
                        </span>
                      </td>
                      <td className="numeric tabular">
                        {formatNumber(order.actualLeadTime, quantityFormatter)}
                        {order.actualLeadTime !== null ? <span className="unit"> d</span> : null}
                      </td>
                      <td className="numeric tabular">
                        {formatNumber(order.predictedSigmaL, decimalFormatter)}
                      </td>
                      <td className="numeric tabular">
                        <strong>{quantityFormatter.format(order.safetyStock)}</strong>
                        <span className="unit"> u</span>
                      </td>
                      <td className="numeric tabular">
                        {quantityFormatter.format(order.reorderPoint)}
                        <span className="unit"> u</span>
                      </td>
                      <td className="numeric tabular">
                        {capitalLocked > 0 ? currencyFormatter.format(capitalLocked) : "—"}
                      </td>
                      <td>
                        <RiskBadge
                          risk={risk}
                          isColdStart={isCold}
                          onExplain={onExplain ? () => onExplain(order) : undefined}
                          onMitigate={onMitigate ? () => onMitigate(order) : undefined}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="order-cards">
            {filteredOrders.map((order, index) => {
              const risk = classifyRisk(order.predictedSigmaL, order.riskStatus)
              const isCold = Boolean(order.riskStatus && order.riskStatus.startsWith("COLD_"))
              const capitalLocked = order.safetyStock * order.unitPrice

              return (
                <article
                  className={`order-card order-card--${risk.toLowerCase()}`}
                  key={`${order.poId}-${order.vendorId}-${index}`}
                  tabIndex={0}
                >
                  <div className="order-card__identity">
                    <div>
                      <span>Purchase order</span>
                      <strong>{order.poId}</strong>
                    </div>
                    <RiskBadge
                      risk={risk}
                      isColdStart={isCold}
                      onExplain={onExplain ? () => onExplain(order) : undefined}
                      onMitigate={onMitigate ? () => onMitigate(order) : undefined}
                    />
                  </div>
                  <dl>
                    <div>
                      <dt>Vendor</dt>
                      <dd>
                        <button
                          type="button"
                          onClick={() => onInspectVendor && onInspectVendor(order.vendorId)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "var(--teal)",
                            textDecoration: "underline",
                            cursor: "pointer",
                            fontWeight: 600,
                          }}
                        >
                          {order.vendorId}
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>SKU</dt>
                      <dd>{order.skuId}</dd>
                    </div>
                    <div>
                      <dt>Actual lead time</dt>
                      <dd>
                        {formatNumber(order.actualLeadTime, quantityFormatter)}
                        {order.actualLeadTime !== null ? " days" : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Predicted σL</dt>
                      <dd>{formatNumber(order.predictedSigmaL, decimalFormatter)}</dd>
                    </div>
                    <div>
                      <dt>Safety stock</dt>
                      <dd>{quantityFormatter.format(order.safetyStock)} units</dd>
                    </div>
                    <div>
                      <dt>Buffer capital</dt>
                      <dd>{capitalLocked > 0 ? currencyFormatter.format(capitalLocked) : "—"}</dd>
                    </div>
                  </dl>
                </article>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
