import { createClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://bcnhsbkznrebqchaihbo.supabase.co"
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl"

export const supabase = createClient(supabaseUrl, supabaseKey)

export type RiskLevel = "CRITICAL" | "WARNING" | "NORMAL" | "UNAVAILABLE"

export interface Order {
  poId: string
  vendorId: string
  skuId: string
  actualLeadTime: number | null
  promisedLeadTime: number | null
  delayDays: number | null
  predictedMuL: number | null
  predictedSigmaL: number | null
  safetyStock: number
  reorderPoint: number
  unitPrice: number
  quantity: number
  orderDate: string
  riskStatus: string
  hurdleClass?: string
  // Snake-case aliases for existing modals & analytics
  po_id: string
  vendor_id: string
  sku_id: string
  actual_lead_time: number | null
  promised_lead_time: number | null
  delay_days: number | null
  predicted_mu_l: number | null
  predicted_sigma_l: number | null
  safety_stock: number
  reorder_point: number
  unit_price: number
  quantity_num: number
  order_date: string
  risk_status: string
  category?: string
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function toIdentifier(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  return String(value)
}

export function classifyRisk(predictedSigmaL: number | null, riskStatusStr?: string): RiskLevel {
  if (predictedSigmaL !== null) {
    if (predictedSigmaL > 1.85) return "CRITICAL"
    if (predictedSigmaL > 1.65) return "WARNING"
    return "NORMAL"
  }

  if (typeof riskStatusStr === "string") {
    if (riskStatusStr.includes("CRITICAL")) return "CRITICAL"
    if (riskStatusStr.includes("WARNING")) return "WARNING"
    if (riskStatusStr.includes("NORMAL")) return "NORMAL"
  }

  return "UNAVAILABLE"
}

export async function fetchProcessedOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("po_id,vendor_id,sku_id,actual_lead_time,promised_lead_time,delay_days,predicted_mu_l,predicted_sigma_l,safety_stock,reorder_point,risk_status,unit_price,order_date,quantity,hurdle_class")
    .limit(800)

  if (error) throw error

  return ((data ?? []) as any[])
    .map((order) => {
      const poid = toIdentifier(order.po_id)
      const vid = toIdentifier(order.vendor_id)
      const skuid = toIdentifier(order.sku_id)
      const alt = toFiniteNumber(order.actual_lead_time)
      const plt = toFiniteNumber(order.promised_lead_time)
      const del = toFiniteNumber(order.delay_days)
      const mul = toFiniteNumber(order.predicted_mu_l) ?? 7.0
      const sig = toFiniteNumber(order.predicted_sigma_l)
      const ss = toFiniteNumber(order.safety_stock) ?? 0
      const rop = toFiniteNumber(order.reorder_point) ?? 0
      const price = toFiniteNumber(order.unit_price) ?? 0
      const qty = toFiniteNumber(order.quantity) ?? 1
      const dt = order.order_date ? String(order.order_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
      const st = String(order.risk_status || (sig ? classifyRisk(sig) : "NORMAL"))

      return {
        poId: poid,
        vendorId: vid,
        skuId: skuid,
        actualLeadTime: alt,
        promisedLeadTime: plt,
        delayDays: del,
        predictedMuL: mul,
        predictedSigmaL: sig,
        safetyStock: ss,
        reorderPoint: rop,
        unitPrice: price,
        quantity: qty,
        orderDate: dt,
        riskStatus: st,
        hurdleClass: order.hurdle_class || undefined,
        // Snake case aliases
        po_id: poid,
        vendor_id: vid,
        sku_id: skuid,
        actual_lead_time: alt,
        promised_lead_time: plt,
        delay_days: del,
        predicted_mu_l: mul,
        predicted_sigma_l: sig,
        safety_stock: ss,
        reorder_point: rop,
        unit_price: price,
        quantity_num: qty,
        order_date: dt,
        risk_status: st,
      }
    })
    .filter((order) => order.safetyStock > 0 || order.predictedSigmaL !== null)
    .sort(
      (a, b) =>
        (b.predictedSigmaL ?? Number.NEGATIVE_INFINITY) -
        (a.predictedSigmaL ?? Number.NEGATIVE_INFINITY),
    )
}
