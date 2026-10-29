import type { RiskLevel } from "../lib/orders"

interface RiskBadgeProps {
  risk: RiskLevel
  compact?: boolean
  isColdStart?: boolean
  onExplain?: () => void
  onMitigate?: () => void
}

const labels: Record<RiskLevel, string> = {
  CRITICAL: "Critical",
  WARNING: "Warning",
  NORMAL: "Normal",
  UNAVAILABLE: "Unavailable",
}

export default function RiskBadge({
  risk,
  compact = false,
  isColdStart = false,
  onExplain,
  onMitigate,
}: RiskBadgeProps) {
  const isHighRisk = risk === "CRITICAL" || risk === "WARNING"

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "nowrap" }}>
      <span
        className={`risk-badge risk-badge--${risk.toLowerCase()}${
          compact ? " risk-badge--compact" : ""
        }`}
      >
        <span className="risk-badge__dot" aria-hidden="true" />
        {labels[risk]}
      </span>

      {isColdStart && (
        <span
          style={{
            fontSize: "10px",
            fontFamily: "ui-monospace, monospace",
            fontWeight: 600,
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: "4px",
            background: "#f3e8ff",
            color: "#7e22ce",
            border: "1px solid #d8b4fe",
          }}
          title="Cold-Start Supplier (Using fleet-wide baseline parameters)"
        >
          Cold
        </span>
      )}

      {onExplain && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onExplain()
          }}
          style={{
            fontSize: "11px",
            fontWeight: 600,
            padding: "2px 7px",
            borderRadius: "3px",
            background: "#ffffff",
            color: "#0369a1",
            border: "1px solid #bae6fd",
            cursor: "pointer",
            transition: "all 120ms ease",
            lineHeight: "1.4",
          }}
          title="Inspect SHAP Machine Learning Delay Risk Attribution"
        >
          Explain
        </button>
      )}

      {isHighRisk && onMitigate && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onMitigate()
          }}
          style={{
            fontSize: "11px",
            fontWeight: 650,
            padding: "2px 8px",
            borderRadius: "3px",
            background: "#ffffff",
            color: "#6d28d9",
            border: "1px solid #ddd6fe",
            cursor: "pointer",
            transition: "all 120ms ease",
            lineHeight: "1.4",
          }}
          title="Open Prescriptive Supplier Mitigation Center"
        >
          Mitigate
        </button>
      )}
    </div>
  )
}
