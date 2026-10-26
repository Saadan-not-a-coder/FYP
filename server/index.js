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
      .select('po_id,vendor_id,sku_id,actual_lead_time,predicted_mu_l,predicted_sigma_l,safety_stock,reorder_point,risk_status,unit_price,order_date,quantity')
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
