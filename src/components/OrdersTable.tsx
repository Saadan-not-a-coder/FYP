import { useMemo, useState } from "react"
import { classifyRisk, type Order, type RiskLevel } from "../lib/orders"
import RiskBadge from "./RiskBadge"

type RiskFilter = "ALL" | RiskLevel

interface OrdersTableProps {
  orders: Order[]
}

const quantityFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
})

const decimalFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatNumber(
  value: number | null,
  formatter: Intl.NumberFormat,
): string {
  return value === null ? "Not available" : formatter.format(value)
}

function OrderDetails({ order }: { order: Order }) {
  const risk = classifyRisk(order.predictedSigmaL)

  return (
    <>
      <div className="order-card__identity">
        <div>
          <span>Purchase order</span>
          <strong>{order.poId}</strong>
        </div>
        <RiskBadge risk={risk} />
      </div>
      <dl>
        <div>
          <dt>Vendor</dt>
          <dd>{order.vendorId}</dd>
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
      </dl>
    </>
  )
}

export default function OrdersTable({ orders }: OrdersTableProps) {
  const [query, setQuery] = useState("")
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("ALL")

  const filteredOrders = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()

    return orders.filter((order) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        order.poId.toLocaleLowerCase().includes(normalizedQuery) ||
        order.vendorId.toLocaleLowerCase().includes(normalizedQuery)
      const matchesRisk =
        riskFilter === "ALL" ||
        classifyRisk(order.predictedSigmaL) === riskFilter

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
          <p className="eyebrow">Exception workspace</p>
          <h2 id="orders-title">Processed orders</h2>
        </div>
        <p className="result-count" aria-live="polite">
          <strong>{filteredOrders.length}</strong> of {orders.length} orders
        </p>
      </div>

      <div className="table-toolbar">
        <label className="field field--search">
          <span>Search orders</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="PO or vendor ID"
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
            <p>Adjust your search or risk filter to see more results.</p>
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
                Live processed orders sorted by descending predicted lead-time
                variability.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Purchase order</th>
                  <th scope="col">Vendor</th>
                  <th className="numeric" scope="col">
                    Actual lead time
                  </th>
                  <th className="numeric" scope="col">
                    Predicted σL
                  </th>
                  <th className="numeric" scope="col">
                    Safety stock
                  </th>
                  <th scope="col">Risk</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order, index) => {
                  const risk = classifyRisk(order.predictedSigmaL)
                  return (
                    <tr
                      className={`table-row table-row--${risk.toLowerCase()}`}
                      key={`${order.poId}-${order.vendorId}-${index}`}
                      tabIndex={0}
                    >
                      <td>
                        <strong className="order-id">{order.poId}</strong>
                      </td>
                      <td>{order.vendorId}</td>
                      <td className="numeric tabular">
                        {formatNumber(order.actualLeadTime, quantityFormatter)}
                        {order.actualLeadTime !== null ? (
                          <span className="unit"> days</span>
                        ) : null}
                      </td>
                      <td className="numeric tabular">
                        {formatNumber(order.predictedSigmaL, decimalFormatter)}
                      </td>
                      <td className="numeric tabular">
                        <strong>
                          {quantityFormatter.format(order.safetyStock)}
                        </strong>
                        <span className="unit"> units</span>
                      </td>
                      <td>
                        <RiskBadge risk={risk} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="order-cards">
            {filteredOrders.map((order, index) => {
              const risk = classifyRisk(order.predictedSigmaL)
              return (
                <article
                  className={`order-card order-card--${risk.toLowerCase()}`}
                  key={`${order.poId}-${order.vendorId}-${index}`}
                  tabIndex={0}
                >
                  <OrderDetails order={order} />
                </article>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
