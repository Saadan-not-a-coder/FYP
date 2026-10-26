/**
 * Node.js API Gateway & Ingestion Server (Sprint 4.1)
 *
 * Connects the React 19 client to:
 * 1. Supabase PostgreSQL database (data persistence & queries)
 * 2. Python ML Microservice (FastAPI on port 8000 for actuarial/risk inference)
 */

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || process.env.NODE_PORT || 5000

// Middleware
app.use(cors())
app.use(express.json())

// Environment & Service URLs
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://bcnhsbkznrebqchaihbo.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || 'sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl'
const ML_SERVICE_URL = process.env.ML_API_URL || 'http://127.0.0.1:8000'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── 1. Gateway Health & Architecture Status ──────────────────────────────────
app.get('/health', async (req, res) => {
  let dbStatus = 'unknown'
  let mlStatus = 'unknown'

  // Check Supabase connection
  try {
    const { error } = await supabase.from('orders').select('po_id').limit(1)
    dbStatus = error ? `error: ${error.message}` : 'connected'
  } catch (err) {
    dbStatus = `unreachable: ${err.message}`
  }

  // Check Python ML Microservice
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

// ── 2. Orders REST Endpoints (Persisted in Supabase) ──────────────────────────

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

// ── 3. Proxy to Python ML Microservice (FastAPI) ─────────────────────────────

// POST /api/ml/analyze_risk — Proxies to Python ML engine and updates Supabase
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

// POST /api/ml/simulate_scenario — What-If Stress Testing (Dry-run)
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

// POST /api/ml/recommend_alternatives — Prescriptive Alternative Vendor Discovery
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

// GET /api/ml/global_stats — Cold-start fleet fallback statistics
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
  })
}

export default app
