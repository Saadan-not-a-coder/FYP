/**
 * Node.js API Gateway & Ingestion Server (Sprint 4.1 & 4.2)
 *
 * Connects the React 19 client to:
 * 1. Supabase PostgreSQL database (data persistence & queries)
 * 2. Python ML Microservice (FastAPI on port 8000 for actuarial/risk inference)
 * 3. Data Ingestion & Row-Level Validation Engine with Quarantine Error Reporting
 */

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import multer from 'multer'
import * as xlsx from 'xlsx'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || process.env.NODE_PORT || 5000

// In-memory upload buffer (max 15MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

// Middleware
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Environment & Service URLs
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://bcnhsbkznrebqchaihbo.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || 'sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl'
const ML_SERVICE_URL = process.env.ML_API_URL || 'http://127.0.0.1:8000'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── 4.2: Row-Level Validation & Normalization Engine ─────────────────────────
export function validateOrderRow(rawRow, rowNumber) {
  const errors = []
  const row = {}

  // 1. Normalize key aliases (case-insensitive & flexible header variations)
  for (const [key, val] of Object.entries(rawRow)) {
    const cleanKey = key.trim().toLowerCase().replace(/[\s_-]+/g, '')
    if (cleanKey === 'poid' || cleanKey === 'po' || cleanKey === 'ordernumber') row.po_id = val
    else if (cleanKey === 'vendorid' || cleanKey === 'vendor' || cleanKey === 'supplier' || cleanKey === 'supplierid') row.vendor_id = val
    else if (cleanKey === 'skuid' || cleanKey === 'sku' || cleanKey === 'itemid' || cleanKey === 'productid') row.sku_id = val
    else if (cleanKey === 'quantity' || cleanKey === 'qty' || cleanKey === 'units') row.quantity = val
    else if (cleanKey === 'unitprice' || cleanKey === 'price' || cleanKey === 'cost') row.unit_price = val
    else if (cleanKey === 'actualleadtime' || cleanKey === 'leadtime' || cleanKey === 'deliverydays') row.actual_lead_time = val
    else if (cleanKey === 'orderdate' || cleanKey === 'date' || cleanKey === 'podate') row.order_date = val
    else if (cleanKey === 'category' || cleanKey === 'productcategory') row.category = val
    else row[key.trim()] = val
  }

  // 2. Mandatory String Identifiers Check
  const poIdStr = row.po_id != null ? String(row.po_id).trim() : ''
  if (!poIdStr) errors.push("Missing mandatory field: 'po_id'")

  const vendorIdStr = row.vendor_id != null ? String(row.vendor_id).trim() : ''
  if (!vendorIdStr) errors.push("Missing mandatory field: 'vendor_id'")

  const skuIdStr = row.sku_id != null ? String(row.sku_id).trim() : ''
  if (!skuIdStr) errors.push("Missing mandatory field: 'sku_id'")

  // 3. Numeric Integrity Checks
  const qty = Number(row.quantity)
  if (row.quantity === undefined || row.quantity === null || row.quantity === '') {
    errors.push("Missing mandatory field: 'quantity'")
  } else if (isNaN(qty) || qty <= 0) {
    errors.push(`Invalid quantity '${row.quantity}': must be a positive number (> 0)`)
  }

  const price = Number(row.unit_price)
  if (row.unit_price === undefined || row.unit_price === null || row.unit_price === '') {
    errors.push("Missing mandatory field: 'unit_price'")
  } else if (isNaN(price) || price < 0) {
    errors.push(`Invalid unit_price '${row.unit_price}': must be non-negative (>= 0)`)
  }

  if (row.actual_lead_time !== undefined && row.actual_lead_time !== null && row.actual_lead_time !== '') {
    const lt = Number(row.actual_lead_time)
    if (isNaN(lt) || lt < 0) {
      errors.push(`Invalid actual_lead_time '${row.actual_lead_time}': cannot be negative`)
    }
  }

  // 4. Date Validation
  let parsedDate = null
  if (row.order_date) {
    if (row.order_date instanceof Date) {
      parsedDate = row.order_date.toISOString().slice(0, 10)
    } else {
      const d = new Date(row.order_date)
      if (isNaN(d.getTime())) {
        errors.push(`Invalid order_date format '${row.order_date}': unable to parse valid date`)
      } else {
        parsedDate = d.toISOString().slice(0, 10)
      }
    }
  }

  const normalized = {
    po_id: poIdStr,
    vendor_id: vendorIdStr,
    sku_id: skuIdStr,
    quantity: isNaN(qty) ? null : qty,
    unit_price: isNaN(price) ? null : price,
    actual_lead_time: (row.actual_lead_time !== undefined && row.actual_lead_time !== '' && !isNaN(Number(row.actual_lead_time)))
      ? Number(row.actual_lead_time)
      : null,
    order_date: parsedDate || new Date().toISOString().slice(0, 10),
    category: row.category ? String(row.category).trim() : 'General Supplies',
  }

  return {
    rowNumber,
    isValid: errors.length === 0,
    errors,
    data: normalized,
    raw: rawRow,
  }
}

// ── 1. Gateway Health & Architecture Status ──────────────────────────────────
app.get('/health', async (req, res) => {
  let dbStatus = 'unknown'
  let mlStatus = 'unknown'

  try {
    const { error } = await supabase.from('orders').select('po_id').limit(1)
    dbStatus = error ? `error: ${error.message}` : 'connected'
  } catch (err) {
    dbStatus = `unreachable: ${err.message}`
  }

  try {
    const mlRes = await fetch(`${ML_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) })
    if (mlRes.ok) {
      const mlData = await mlRes.json()
      mlStatus = mlData.status === 'ok' ? 'connected' : 'unexpected response'
    } else {
      mlStatus = `http ${mlRes.status}`
    }
  } catch {
    mlStatus = 'unreachable (FastAPI microservice not running on port 8000)'
  }

  res.json({
    status: 'ok',
    gateway: 'Node.js Express API Gateway (v1.0.0)',
    node_version: process.version,
    port: PORT,
    architecture: {
      client: 'React 19 SPA',
      gateway: 'Node.js Express (Port ' + PORT + ')',
      database: { provider: 'Supabase PostgreSQL', status: dbStatus },
      ml_microservice: { url: ML_SERVICE_URL, status: mlStatus },
    },
  })
})

// ── 2. Data Ingestion & Quarantine Pipeline (Sprint 4.2) ─────────────────────

// POST /api/ingest/upload — Accepts CSV or Excel, validates rows, isolates quarantined errors
app.post('/api/ingest/upload', upload.single('file'), async (req, res) => {
  try {
    let rawRows = []

    if (req.file) {
      // Parse file buffer using SheetJS (works for CSV, XLSX, XLS)
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
      const firstSheet = workbook.SheetNames[0]
      rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' })
    } else if (req.body && Array.isArray(req.body.rows)) {
      rawRows = req.body.rows
    } else {
      return res.status(400).json({ error: 'No file uploaded or rows array provided' })
    }

    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'Uploaded file contains no data rows' })
    }

    const validRows = []
    const quarantinedRows = []

    rawRows.forEach((row, idx) => {
      // Row number 2 accounts for 1-based indexing + header row
      const result = validateOrderRow(row, idx + 2)
      if (result.isValid) {
        validRows.push(result.data)
      } else {
        quarantinedRows.push({
          row_number: result.rowNumber,
          quarantine_errors: result.errors.join('; '),
          ...result.raw,
        })
      }
    })

    res.json({
      filename: req.file ? req.file.originalname : 'direct_json_batch',
      total_rows: rawRows.length,
      valid_count: validRows.length,
      quarantined_count: quarantinedRows.length,
      status: quarantinedRows.length === 0 ? 'clean' : 'quarantined_errors_detected',
      valid_rows: validRows,
      quarantined_rows: quarantinedRows,
    })
  } catch (err) {
    res.status(500).json({ error: 'Ingestion parsing failed', details: err.message })
  }
})

// POST /api/ingest/confirm — Commits validated clean rows to Supabase database
app.post('/api/ingest/confirm', async (req, res) => {
  try {
    const { orders } = req.body
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'Must provide an array of validated orders to commit' })
    }

    // Upsert into Supabase orders table
    const { data, error } = await supabase
      .from('orders')
      .upsert(orders, { onConflict: 'po_id' })
      .select('po_id')

    if (error) {
      return res.status(500).json({ error: 'Database commit failed', details: error.message })
    }

    res.json({
      success: true,
      message: `Successfully ingested ${orders.length} clean orders into database`,
      inserted_count: data ? data.length : orders.length,
    })
  } catch (err) {
    res.status(500).json({ error: 'Database transaction error', details: err.message })
  }
})

// GET /api/ingest/sample-csv — Downloads reference CSV template with valid rows and 1 error row
app.get('/api/ingest/sample-csv', (req, res) => {
  const sample = [
    'po_id,vendor_id,sku_id,quantity,unit_price,actual_lead_time,order_date,category',
    'PO-9001,VENDOR_A,SKU-1014,50,39.99,6,2026-10-01,Electronics',
    'PO-9002,VENDOR_B,SKU-2045,120,15.50,4,2026-10-02,Apparel',
    'PO-9003,VENDOR_C,SKU-3091,80,64.00,8,2026-10-03,Hardware',
    'PO-INVALID,,SKU-4000,-10,25.00,5,invalid-date,Supplies', // Intentional errors: missing vendor_id, negative qty, bad date
  ].join('\r\n')

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="sample_purchase_orders_template.csv"')
  res.send(sample)
})

// ── 3. Orders REST Endpoints (Persisted in Supabase) ──────────────────────────

// GET /api/orders — Fetch active processed orders
app.get('/api/orders', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 500
    const filterStatus = req.query.risk_status

    let query = supabase
      .from('orders')
      .select('po_id,vendor_id,sku_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,safety_stock,reorder_point,risk_status,unit_price,order_date,quantity,category')
      .gt('safety_stock', 0)
      .order('predicted_sigma_l', { ascending: false })
      .limit(limit)

    if (filterStatus) {
      query = query.eq('risk_status', filterStatus)
    }

    const { data, error } = await query

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    res.json({
      count: data ? data.length : 0,
      orders: data || [],
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/orders/:id — Fetch single order
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('po_id', req.params.id)
      .limit(1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) return res.status(404).json({ error: `Order ${req.params.id} not found` })

    res.json(data[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── 4. Core Spend Analytics & Vendor Concentration Engine (Sprint 4.3) ────────

export function calculateSpendAnalytics(orders) {
  let totalSpend = 0
  let totalUnits = 0
  const vendorMap = {}
  const categoryMap = {}
  const periodMap = {}

  orders.forEach(o => {
    const qty = Number(o.quantity) > 0 ? Number(o.quantity) : 1
    const price = Number(o.unit_price) >= 0 ? Number(o.unit_price) : 0
    const spend = qty * price
    const vendor = o.vendor_id ? String(o.vendor_id).trim() : 'Unknown Vendor'
    const category = o.category ? String(o.category).trim() : 'General Supplies'

    let period = 'Undated'
    if (o.order_date) {
      const d = String(o.order_date).slice(0, 7)
      if (d.length === 7) period = d
    }

    totalSpend += spend
    totalUnits += qty

    // Vendor aggregation
    if (!vendorMap[vendor]) {
      vendorMap[vendor] = { vendor_id: vendor, spend: 0, units: 0, order_count: 0 }
    }
    vendorMap[vendor].spend += spend
    vendorMap[vendor].units += qty
    vendorMap[vendor].order_count += 1

    // Category aggregation
    if (!categoryMap[category]) {
      categoryMap[category] = { category, spend: 0, units: 0, order_count: 0 }
    }
    categoryMap[category].spend += spend
    categoryMap[category].units += qty
    categoryMap[category].order_count += 1

    // Period aggregation
    if (!periodMap[period]) {
      periodMap[period] = { period, spend: 0, units: 0, order_count: 0 }
    }
    periodMap[period].spend += spend
    periodMap[period].units += qty
    periodMap[period].order_count += 1
  })

  // Spend by vendor array sorted descending
  const vendors = Object.values(vendorMap).map(v => {
    const share = totalSpend > 0 ? (v.spend / totalSpend) * 100 : 0
    return {
      ...v,
      spend: Number(v.spend.toFixed(2)),
      share: Number(share.toFixed(2)),
      aov: v.order_count > 0 ? Number((v.spend / v.order_count).toFixed(2)) : 0,
    }
  }).sort((a, b) => b.spend - a.spend)

  // Calculate Cumulative Share for Pareto analysis
  let cumShare = 0
  vendors.forEach(v => {
    cumShare += v.share
    v.cumulative_share = Number(Math.min(100, cumShare).toFixed(2))
  })

  // Spend by category array sorted descending
  const categories = Object.values(categoryMap).map(c => {
    const share = totalSpend > 0 ? (c.spend / totalSpend) * 100 : 0
    return {
      ...c,
      spend: Number(c.spend.toFixed(2)),
      share: Number(share.toFixed(2)),
    }
  }).sort((a, b) => b.spend - a.spend)

  // Spend by period array sorted chronologically
  const periods = Object.values(periodMap).map(p => ({
    ...p,
    spend: Number(p.spend.toFixed(2)),
  })).sort((a, b) => a.period.localeCompare(b.period))

  // Vendor Concentration Metrics (HHI & Concentration Ratios)
  let hhi = 0
  vendors.forEach(v => {
    hhi += Math.pow(v.share, 2)
  })
  hhi = Math.round(hhi)

  let hhiStatus = 'UNCONCENTRATED'
  let hhiColor = '#16a34a'
  let hhiDescription = 'Healthy supplier diversification (low vendor lock-in risk).'
  if (hhi > 2500) {
    hhiStatus = 'HIGHLY CONCENTRATED'
    hhiColor = '#dc2626'
    hhiDescription = 'High supplier dependency: procurement is severely vulnerable to single-vendor disruptions.'
  } else if (hhi >= 1500) {
    hhiStatus = 'MODERATELY CONCENTRATED'
    hhiColor = '#d97706'
    hhiDescription = 'Moderate supplier concentration: monitor secondary sourcing policies.'
  }

  const cr1 = vendors[0] ? vendors[0].share : 0
  const cr3 = Number(vendors.slice(0, 3).reduce((acc, v) => acc + v.share, 0).toFixed(2))
  const cr5 = Number(vendors.slice(0, 5).reduce((acc, v) => acc + v.share, 0).toFixed(2))

  // Spend Reconciliation Audit
  const sumVendorSpend = vendors.reduce((acc, v) => acc + v.spend, 0)
  const sumCategorySpend = categories.reduce((acc, c) => acc + c.spend, 0)
  const sumPeriodSpend = periods.reduce((acc, p) => acc + p.spend, 0)

  const vendorDelta = Math.abs(totalSpend - sumVendorSpend)
  const categoryDelta = Math.abs(totalSpend - sumCategorySpend)
  const periodDelta = Math.abs(totalSpend - sumPeriodSpend)

  const isReconciled = vendorDelta < 0.05 && categoryDelta < 0.05 && periodDelta < 0.05

  return {
    totalOrders: orders.length,
    totalSpend: Number(totalSpend.toFixed(2)),
    totalUnits,
    averageOrderValue: orders.length > 0 ? Number((totalSpend / orders.length).toFixed(2)) : 0,
    concentration: {
      hhi,
      hhiStatus,
      hhiColor,
      hhiDescription,
      cr1,
      cr3,
      cr5,
      activeVendorCount: vendors.length,
    },
    vendors,
    categories,
    periods,
    reconciliation: {
      isReconciled,
      totalSpend: Number(totalSpend.toFixed(2)),
      sumVendorSpend: Number(sumVendorSpend.toFixed(2)),
      sumCategorySpend: Number(sumCategorySpend.toFixed(2)),
      sumPeriodSpend: Number(sumPeriodSpend.toFixed(2)),
      vendorDelta: Number(vendorDelta.toFixed(4)),
      categoryDelta: Number(categoryDelta.toFixed(4)),
      periodDelta: Number(periodDelta.toFixed(4)),
    },
  }
}

// GET /api/analytics/spend — Aggregates spend totals, categories, vendors & HHI concentration
app.get('/api/analytics/spend', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('po_id,vendor_id,sku_id,quantity,unit_price,order_date,category')
      .limit(2000)

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    const analytics = calculateSpendAnalytics(data || [])
    res.json(analytics)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── 5. Vendor Historical Scorecards & On-Time Performance (Sprint 4.4) ───────

export function buildVendorScorecards(orders) {
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
        lead_times: [],
        total_spend: 0,
        total_units: 0,
        mu_l: muL,
        sigma_l: sigmaL,
        is_cold_start: isCold,
        risk_status: o.risk_status || 'NORMAL',
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
      v.lead_times.push(actualLt)
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

  const scorecards = Object.values(vendorMap).map(v => {
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
      grade = 'N/A'
      tier = 'Cold-Start (Unverified)'
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
      plainLanguageSummary = `Supplier ${v.vendor_id} has zero historical delivery records. Scored using fleet fallback parameters (mean lead time ${v.mu_l.toFixed(1)}d, volatility σ_L = ${v.sigma_l.toFixed(2)}d). High predictive uncertainty requires active delivery monitoring.`
    } else if (grade === 'A') {
      plainLanguageSummary = `Supplier ${v.vendor_id} demonstrates elite performance with an on-time delivery rate of ${onTimeRate}% across ${v.completed_orders} orders. Lead-time consistency is high (σ_L = ${v.sigma_l.toFixed(2)}d) with minimal delay exposure.`
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
  }).sort((a, b) => b.total_spend - a.total_spend)

  return scorecards
}

// GET /api/analytics/vendor-scorecards — Returns historical scorecard & on-time stats for each vendor
app.get('/api/analytics/vendor-scorecards', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('po_id,vendor_id,sku_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,quantity,unit_price,risk_status')
      .limit(2000)

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    const scorecards = buildVendorScorecards(data || [])
    res.json({
      count: scorecards.length,
      scorecards,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── 4. Proxy to Python ML Microservice (FastAPI) ─────────────────────────────

app.post('/api/ml/analyze_risk', async (req, res) => {
  try {
    const mlResponse = await fetch(`${ML_SERVICE_URL}/api/analyze_risk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    })

    const data = await mlResponse.json()
    res.status(mlResponse.status).json(data)
  } catch (err) {
    res.status(502).json({
      error: 'Failed to communicate with Python ML microservice',
      details: err.message,
      target_url: `${ML_SERVICE_URL}/api/analyze_risk`,
    })
  }
})

app.post('/api/ml/simulate_scenario', async (req, res) => {
  try {
    const mlResponse = await fetch(`${ML_SERVICE_URL}/api/simulate_scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    })

    const data = await mlResponse.json()
    res.status(mlResponse.status).json(data)
  } catch (err) {
    res.status(502).json({
      error: 'Failed to communicate with Python ML microservice for scenario simulation',
      details: err.message,
    })
  }
})

app.post('/api/ml/recommend_alternatives', async (req, res) => {
  try {
    const mlResponse = await fetch(`${ML_SERVICE_URL}/api/recommend_alternatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    })

    const data = await mlResponse.json()
    res.status(mlResponse.status).json(data)
  } catch (err) {
    res.status(502).json({
      error: 'Failed to communicate with Python ML microservice for supplier recommendations',
      details: err.message,
    })
  }
})

app.get('/api/ml/global_stats', async (req, res) => {
  try {
    const mlResponse = await fetch(`${ML_SERVICE_URL}/api/global_stats`)
    const data = await mlResponse.json()
    res.status(mlResponse.status).json(data)
  } catch (err) {
    res.status(502).json({
      error: 'Failed to communicate with Python ML microservice',
      details: err.message,
    })
  }
})

// Start server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[Node.js API Gateway] Running on http://localhost:${PORT}`)
    console.log(`[Node.js API Gateway] Database: Supabase (${SUPABASE_URL})`)
    console.log(`[Node.js API Gateway] ML Service: ${ML_SERVICE_URL}`)
    console.log(`[Node.js Ingestion Engine] Ready for CSV/Excel upload & row validation`)
  })
}

export default app
