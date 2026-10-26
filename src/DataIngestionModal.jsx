import { useState } from 'react'
import * as xlsx from 'xlsx'

/**
 * Client-side validation mirror (identical rules to server/index.js)
 * Used as fallback if Node.js Gateway is offline.
 */
function validateRowClient(rawRow, rowNumber) {
  const errors = []
  const row = {}

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

  const poIdStr = row.po_id != null ? String(row.po_id).trim() : ''
  if (!poIdStr) errors.push("Missing mandatory field: 'po_id'")

  const vendorIdStr = row.vendor_id != null ? String(row.vendor_id).trim() : ''
  if (!vendorIdStr) errors.push("Missing mandatory field: 'vendor_id'")

  const skuIdStr = row.sku_id != null ? String(row.sku_id).trim() : ''
  if (!skuIdStr) errors.push("Missing mandatory field: 'sku_id'")

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

  let parsedDate = null
  if (row.order_date) {
    const d = new Date(row.order_date)
    if (isNaN(d.getTime())) {
      errors.push(`Invalid order_date format '${row.order_date}': unable to parse valid date`)
    } else {
      parsedDate = d.toISOString().slice(0, 10)
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

export default function DataIngestionModal({
  isOpen,
  onClose,
  onIngestSuccess,
  nodeApiUrl = 'http://localhost:5000',
  supabase,
}) {
  const [selectedFile, setSelectedFile] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [ingestResult, setIngestResult] = useState(null)
  const [activeTab, setActiveTab] = useState('quarantined')
  const [committing, setCommitting] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [isDragOver, setIsDragOver] = useState(false)

  if (!isOpen) return null

  // 1. Download reference sample CSV
  const handleDownloadSample = () => {
    const sampleCsv = [
      'po_id,vendor_id,sku_id,quantity,unit_price,actual_lead_time,order_date,category',
      'PO-9001,VENDOR_A,SKU-1014,50,39.99,6,2026-10-01,Electronics',
      'PO-9002,VENDOR_B,SKU-2041,120,12.50,4,2026-10-02,Hardware',
      'PO-9003,VENDOR_C,SKU-3099,15,185.00,11,2026-10-03,Raw Materials',
      'PO-9004,VENDOR_D,SKU-4401,-10,45.00,8,2026-10-04,Packaging',
      'PO-9005,,SKU-5012,80,-5.00,7,2026-10-05,Safety Gear',
      'PO-9006,VENDOR_F,SKU-6022,95,22.00,5,2026-10-06,Office Supplies',
    ].join('\r\n')

    const blob = new Blob([sampleCsv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'sample_purchase_orders_template.csv'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // 2. Process file through Node.js API Gateway or In-Browser Fallback
  const processFile = async (file) => {
    setSelectedFile(file)
    setAnalyzing(true)
    setFeedback(null)
    setIngestResult(null)

    try {
      let resultData = null

      // Attempt A: Node.js API Gateway Ingestion Route
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch(`${nodeApiUrl}/api/ingest/upload`, {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(6000),
        })

        if (res.ok) {
          resultData = await res.json()
        }
      } catch {
        // Node gateway unreachable, gracefully fallback to in-browser engine
      }

      // Attempt B: Client-side parsing using SheetJS
      if (!resultData) {
        const buffer = await file.arrayBuffer()
        const workbook = xlsx.read(buffer, { type: 'array', cellDates: true })
        const sheetName = workbook.SheetNames[0]
        const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })

        if (rawRows.length === 0) {
          throw new Error('Uploaded file contains no data rows.')
        }

        const valid = []
        const quarantined = []

        rawRows.forEach((r, idx) => {
          const res = validateRowClient(r, idx + 2)
          if (res.isValid) {
            valid.push(res.data)
          } else {
            quarantined.push({
              row_number: res.rowNumber,
              quarantine_errors: res.errors.join('; '),
              ...res.raw,
            })
          }
        })

        resultData = {
          filename: file.name,
          total_rows: rawRows.length,
          valid_count: valid.length,
          quarantined_count: quarantined.length,
          status: quarantined.length === 0 ? 'clean' : 'quarantined_errors_detected',
          valid_rows: valid,
          quarantined_rows: quarantined,
        }
      }

      setIngestResult(resultData)
      setActiveTab(resultData.quarantined_count > 0 ? 'quarantined' : 'valid')
    } catch (err) {
      setFeedback({ type: 'error', text: 'Ingestion parsing failed: ' + err.message })
    } finally {
      setAnalyzing(false)
    }
  }

  // 3. Export quarantined rows to CSV error report
  const handleDownloadErrorReport = () => {
    if (!ingestResult || !ingestResult.quarantined_rows.length) return

    const quarantined = ingestResult.quarantined_rows
    const headers = ['ROW_NUMBER', 'QUARANTINE_ERROR_REASON', 'PO_ID', 'VENDOR_ID', 'SKU_ID', 'QUANTITY', 'UNIT_PRICE', 'LEAD_TIME', 'DATE']
    
    const rows = quarantined.map(r => [
      r.row_number,
      `"${String(r.quarantine_errors || '').replace(/"/g, '""')}"`,
      `"${r.po_id || r.PO_ID || ''}"`,
      `"${r.vendor_id || r.VENDOR_ID || ''}"`,
      `"${r.sku_id || r.SKU_ID || ''}"`,
      `"${r.quantity || r.QUANTITY || ''}"`,
      `"${r.unit_price || r.UNIT_PRICE || ''}"`,
      `"${r.actual_lead_time || r.LEAD_TIME || ''}"`,
      `"${r.order_date || r.DATE || ''}"`,
    ].join(','))

    const csvContent = [headers.join(','), ...rows].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `quarantine_error_report_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // 4. Commit validated clean rows to database
  const handleConfirmIngest = async () => {
    if (!ingestResult || !ingestResult.valid_rows.length) return

    setCommitting(true)
    setFeedback(null)

    try {
      let committed = false

      // Try Node gateway
      try {
        const res = await fetch(`${nodeApiUrl}/api/ingest/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: ingestResult.valid_rows }),
          signal: AbortSignal.timeout(8000),
        })

        if (res.ok) {
          const json = await res.json()
          setFeedback({
            type: 'success',
            text: `Successfully ingested ${json.inserted_count || ingestResult.valid_rows.length} validated orders into the database! Invalid rows remain quarantined.`,
          })
          committed = true
        }
      } catch {
        // Fallback to Supabase direct client
      }

      // Supabase direct fallback if gateway offline
      if (!committed && supabase) {
        const { error } = await supabase
          .from('orders')
          .upsert(ingestResult.valid_rows, { onConflict: 'po_id' })

        if (error) throw error

        setFeedback({
          type: 'success',
          text: `Directly ingested ${ingestResult.valid_rows.length} validated orders into Supabase! Corrupt rows remained safely quarantined.`,
        })
        committed = true
      }

      if (committed) {
        if (onIngestSuccess) onIngestSuccess()
        setTimeout(() => {
          onClose()
        }, 1800)
      }
    } catch (err) {
      setFeedback({ type: 'error', text: 'Commit failed: ' + err.message })
    } finally {
      setCommitting(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0])
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.65)',
      backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: '20px',
    }}>
      <div style={{
        backgroundColor: '#ffffff', borderRadius: '14px', width: '100%', maxWidth: '880px',
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        display: 'flex', flexDirection: 'column', border: '1px solid #e2e8f0',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          backgroundColor: '#f8fafc', borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
        }}>
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
              📥 Purchase Order Data Ingestion & Row-Level Validation
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
              Upload CSV or Excel files. Corrupt rows are quarantined with error reports before reaching the analytics engine.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
              color: '#64748b', padding: '4px 8px', borderRadius: '6px',
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* File Dropzone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            style={{
              border: `2px dashed ${isDragOver ? '#3b82f6' : '#cbd5e1'}`,
              backgroundColor: isDragOver ? '#eff6ff' : '#f8fafc',
              borderRadius: '10px', padding: '28px 20px', textAlign: 'center',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
            onClick={() => document.getElementById('file-input-ingest')?.click()}
          >
            <input
              id="file-input-ingest"
              type="file"
              accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  processFile(e.target.files[0])
                }
              }}
            />
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>📁</div>
            <div style={{ fontWeight: '600', color: '#1e293b', fontSize: '14px' }}>
              {selectedFile ? selectedFile.name : 'Click to select or drag & drop CSV / Excel (.xlsx) file'}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Supported columns: <code>po_id</code>, <code>vendor_id</code>, <code>sku_id</code>, <code>quantity</code>, <code>unit_price</code>, <code>actual_lead_time</code>, <code>order_date</code>
            </div>
          </div>

          {/* Quick Action: Download Sample Template */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '-10px' }}>
            <button
              onClick={handleDownloadSample}
              style={{
                background: 'none', border: 'none', color: '#2563eb', fontSize: '12px',
                fontWeight: '600', cursor: 'pointer', textDecoration: 'underline',
                display: 'inline-flex', alignItems: 'center', gap: '4px',
              }}
            >
              📄 Download Sample Template (Contains valid & test corrupt rows)
            </button>
          </div>

          {/* Loading Indicator */}
          {analyzing && (
            <div style={{ textAlign: 'center', padding: '20px', color: '#3b82f6', fontWeight: '600', fontSize: '14px' }}>
              ⏳ Parsing file & executing row-level constraint validation...
            </div>
          )}

          {/* Feedback alerts */}
          {feedback && (
            <div style={{
              padding: '12px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '500',
              backgroundColor: feedback.type === 'success' ? '#f0fdf4' : '#fef2f2',
              color: feedback.type === 'success' ? '#166534' : '#991b1b',
              border: `1px solid ${feedback.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
            }}>
              {feedback.text}
            </div>
          )}

          {/* Ingestion & Quarantine Metrics Breakdown */}
          {ingestResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              {/* Stat Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                <div style={{ backgroundColor: '#f1f5f9', padding: '12px 16px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase' }}>Total Uploaded</div>
                  <div style={{ fontSize: '22px', fontWeight: '800', color: '#0f172a' }}>{ingestResult.total_rows}</div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>rows processed</div>
                </div>

                <div style={{ backgroundColor: '#f0fdf4', padding: '12px 16px', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: '11px', color: '#166534', fontWeight: '600', textTransform: 'uppercase' }}>Valid Clean Rows</div>
                  <div style={{ fontSize: '22px', fontWeight: '800', color: '#15803d' }}>{ingestResult.valid_count}</div>
                  <div style={{ fontSize: '11px', color: '#166534' }}>ready for engine commit</div>
                </div>

                <div style={{ backgroundColor: ingestResult.quarantined_count > 0 ? '#fef2f2' : '#f8fafc', padding: '12px 16px', borderRadius: '8px', border: `1px solid ${ingestResult.quarantined_count > 0 ? '#fecaca' : '#e2e8f0'}` }}>
                  <div style={{ fontSize: '11px', color: ingestResult.quarantined_count > 0 ? '#b91c1c' : '#64748b', fontWeight: '600', textTransform: 'uppercase' }}>Quarantined Errors</div>
                  <div style={{ fontSize: '22px', fontWeight: '800', color: ingestResult.quarantined_count > 0 ? '#dc2626' : '#64748b' }}>{ingestResult.quarantined_count}</div>
                  <div style={{ fontSize: '11px', color: ingestResult.quarantined_count > 0 ? '#b91c1c' : '#64748b' }}>isolated from analytics</div>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => setActiveTab('quarantined')}
                    style={{
                      padding: '8px 14px', border: 'none', background: 'none', fontSize: '13px', fontWeight: '700',
                      cursor: 'pointer', borderBottom: activeTab === 'quarantined' ? '2.5px solid #dc2626' : '2.5px solid transparent',
                      color: activeTab === 'quarantined' ? '#dc2626' : '#64748b',
                    }}
                  >
                    🚨 Quarantined Rows ({ingestResult.quarantined_count})
                  </button>
                  <button
                    onClick={() => setActiveTab('valid')}
                    style={{
                      padding: '8px 14px', border: 'none', background: 'none', fontSize: '13px', fontWeight: '700',
                      cursor: 'pointer', borderBottom: activeTab === 'valid' ? '2.5px solid #16a34a' : '2.5px solid transparent',
                      color: activeTab === 'valid' ? '#16a34a' : '#64748b',
                    }}
                  >
                    ✓ Clean Valid Rows ({ingestResult.valid_count})
                  </button>
                </div>

                {ingestResult.quarantined_count > 0 && (
                  <button
                    onClick={handleDownloadErrorReport}
                    style={{
                      padding: '6px 12px', fontSize: '12px', fontWeight: '600',
                      backgroundColor: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca',
                      borderRadius: '6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px',
                    }}
                  >
                    📥 Download Quarantine Error Report (CSV)
                  </button>
                )}
              </div>

              {/* Tab Contents: Quarantined Rows */}
              {activeTab === 'quarantined' && (
                <div>
                  {ingestResult.quarantined_count === 0 ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: '#16a34a', backgroundColor: '#f0fdf4', borderRadius: '8px' }}>
                      🎉 Zero validation errors detected! 100% of rows meet data schema standards.
                    </div>
                  ) : (
                    <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid #fecaca', borderRadius: '8px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                        <thead style={{ backgroundColor: '#fef2f2', position: 'sticky', top: 0 }}>
                          <tr style={{ color: '#991b1b', borderBottom: '1px solid #fecaca' }}>
                            <th style={{ padding: '8px 12px' }}>Line</th>
                            <th style={{ padding: '8px 12px' }}>PO ID</th>
                            <th style={{ padding: '8px 12px' }}>Validation Failure Reason</th>
                            <th style={{ padding: '8px 12px' }}>Raw Payload</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ingestResult.quarantined_rows.map((row, idx) => (
                            <tr key={idx} style={{ borderBottom: '1px solid #fee2e2', backgroundColor: idx % 2 === 0 ? '#fff' : '#fff5f5' }}>
                              <td style={{ padding: '8px 12px', fontWeight: '700', color: '#dc2626' }}>#{row.row_number}</td>
                              <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{row.po_id || row.PO_ID || '<empty>'}</td>
                              <td style={{ padding: '8px 12px', color: '#b91c1c', fontWeight: '600' }}>
                                <span style={{ backgroundColor: '#fee2e2', padding: '2px 6px', borderRadius: '4px' }}>
                                  {row.quarantine_errors}
                                </span>
                              </td>
                              <td style={{ padding: '8px 12px', color: '#64748b', fontSize: '11px', fontFamily: 'monospace' }}>
                                {`qty=${row.quantity ?? 'null'}, price=${row.unit_price ?? 'null'}, vendor=${row.vendor_id ?? 'null'}`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Tab Contents: Clean Valid Rows */}
              {activeTab === 'valid' && (
                <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid #bbf7d0', borderRadius: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                    <thead style={{ backgroundColor: '#f0fdf4', position: 'sticky', top: 0 }}>
                      <tr style={{ color: '#166534', borderBottom: '1px solid #bbf7d0' }}>
                        <th style={{ padding: '8px 12px' }}>PO ID</th>
                        <th style={{ padding: '8px 12px' }}>Vendor ID</th>
                        <th style={{ padding: '8px 12px' }}>SKU ID</th>
                        <th style={{ padding: '8px 12px' }}>Qty</th>
                        <th style={{ padding: '8px 12px' }}>Unit Price</th>
                        <th style={{ padding: '8px 12px' }}>Lead Time</th>
                        <th style={{ padding: '8px 12px' }}>Order Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ingestResult.valid_rows.map((row, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0', backgroundColor: idx % 2 === 0 ? '#fff' : '#f8fafc' }}>
                          <td style={{ padding: '8px 12px', fontWeight: '600', fontFamily: 'monospace' }}>{row.po_id}</td>
                          <td style={{ padding: '8px 12px' }}>{row.vendor_id}</td>
                          <td style={{ padding: '8px 12px' }}>{row.sku_id}</td>
                          <td style={{ padding: '8px 12px' }}>{row.quantity}</td>
                          <td style={{ padding: '8px 12px' }}>${Number(row.unit_price).toFixed(2)}</td>
                          <td style={{ padding: '8px 12px' }}>{row.actual_lead_time != null ? `${row.actual_lead_time}d` : '—'}</td>
                          <td style={{ padding: '8px 12px', color: '#64748b' }}>{row.order_date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            </div>
          )}

        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid #e2e8f0', backgroundColor: '#f8fafc',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottomLeftRadius: '14px', borderBottomRightRadius: '14px',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '9px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: '600',
              backgroundColor: '#fff', color: '#475569', border: '1px solid #cbd5e1', cursor: 'pointer',
            }}
          >
            Cancel
          </button>

          <button
            onClick={handleConfirmIngest}
            disabled={!ingestResult || ingestResult.valid_count === 0 || committing}
            style={{
              padding: '9px 20px', borderRadius: '7px', fontSize: '13px', fontWeight: '700',
              backgroundColor: (!ingestResult || ingestResult.valid_count === 0 || committing) ? '#94a3b8' : '#16a34a',
              color: '#ffffff', border: 'none',
              cursor: (!ingestResult || ingestResult.valid_count === 0 || committing) ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              boxShadow: '0 2px 6px rgba(22, 163, 74, 0.2)',
            }}
          >
            {committing ? '⏳ Committing Clean Records...' : `✓ Ingest ${ingestResult ? ingestResult.valid_count : 0} Clean Orders`}
          </button>
        </div>
      </div>
    </div>
  )
}
