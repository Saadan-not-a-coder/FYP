import { createClient } from "@supabase/supabase-js"

const supabaseUrl = "https://bcnhsbkznrebqchaihbo.supabase.co"
const supabaseKey = "sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl"

const supabase = createClient(supabaseUrl, supabaseKey)

export type RiskLevel = "CRITICAL" | "WARNING" | "NORMAL" | "UNAVAILABLE"

export interface Order {
  poId: string
  vendorId: string
  actualLeadTime: number | null
  predictedSigmaL: number | null
  safetyStock: number
}

interface RawOrder {
  po_id?: unknown
  vendor_id?: unknown
  actual_lead_time?: unknown
  predicted_sigma_l?: unknown
  safety_stock?: unknown
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toIdentifier(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  return String(value)
}

export function classifyRisk(predictedSigmaL: number | null): RiskLevel {
  if (predictedSigmaL === null) return "UNAVAILABLE"
  if (predictedSigmaL > 1.85) return "CRITICAL"
  if (predictedSigmaL > 1.65) return "WARNING"
  return "NORMAL"
}

export async function fetchProcessedOrders(): Promise<Order[]> {
  const { data, error } = await supabase.from("orders").select("*").limit(500)

  if (error) throw error

  return ((data ?? []) as RawOrder[])
    .map((order) => ({
      poId: toIdentifier(order.po_id),
      vendorId: toIdentifier(order.vendor_id),
      actualLeadTime: toFiniteNumber(order.actual_lead_time),
      predictedSigmaL: toFiniteNumber(order.predicted_sigma_l),
      safetyStock: toFiniteNumber(order.safety_stock),
    }))
    .filter(
      (order): order is Order =>
        order.safetyStock !== null && order.safetyStock > 0,
    )
    .sort(
      (a, b) =>
        (b.predictedSigmaL ?? Number.NEGATIVE_INFINITY) -
        (a.predictedSigmaL ?? Number.NEGATIVE_INFINITY),
    )
}
