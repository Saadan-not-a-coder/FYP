import type { RiskLevel } from "../lib/orders"

interface RiskBadgeProps {
  risk: RiskLevel
  compact?: boolean
}

const labels: Record<RiskLevel, string> = {
  CRITICAL: "Critical",
  WARNING: "Warning",
  NORMAL: "Normal",
  UNAVAILABLE: "Unavailable",
}

export default function RiskBadge({ risk, compact = false }: RiskBadgeProps) {
  return (
    <span
      className={`risk-badge risk-badge--${risk.toLowerCase()}${
        compact ? " risk-badge--compact" : ""
      }`}
    >
      <span className="risk-badge__dot" aria-hidden="true" />
      {labels[risk]}
    </span>
  )
}
