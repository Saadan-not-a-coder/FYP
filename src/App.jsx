import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// Connect to your live Supabase cloud
const supabaseUrl = 'https://bcnhsbkznrebqchaihbo.supabase.co'
const supabaseKey = 'sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl'
const supabase = createClient(supabaseUrl, supabaseKey)

export default function App() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchOrders()
  }, [])

  async function fetchOrders() {
    try {
      // Fetch all orders
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .limit(500)

      if (error) throw error

      // BULLETPROOF FILTER: Only keep rows that have an actual calculated safety stock > 0
      const processedData = (data || [])
        .filter(order => order.safety_stock > 0)
        // Sort highest risk (highest standard deviation) to the top
        .sort((a, b) => b.predicted_sigma_l - a.predicted_sigma_l);

      setOrders(processedData) 
    } catch (err) {
      console.error("Supabase Error:", err.message)
      alert("Database Error: " + err.message)
    } finally {
      setLoading(false)
    }
  }

  // Helper to color-code risk badges
  const getRiskColor = (status) => {
    if (status === 'CRITICAL') return { backgroundColor: '#fee2e2', color: '#991b1b', padding: '4px 8px', borderRadius: '4px', fontWeight: 'bold' }
    if (status === 'WARNING') return { backgroundColor: '#fef08a', color: '#854d0e', padding: '4px 8px', borderRadius: '4px', fontWeight: 'bold' }
    return { backgroundColor: '#dcfce3', color: '#166534', padding: '4px 8px', borderRadius: '4px', fontWeight: 'bold' }
  }

  return (
    <div style={{ padding: '40px', fontFamily: 'system-ui, sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ borderBottom: '2px solid #eee', paddingBottom: '10px' }}>
        Supply Chain Risk Management MVP
      </h1>
      <p style={{ color: '#666', marginBottom: '30px' }}>
        Live order-level lead-time variance and risk-adjusted safety stock calculations.
      </p>

      {loading ? (
        <p>Loading AI predictions from cloud...</p>
      ) : orders.length === 0 ? (
        <div style={{ padding: '20px', backgroundColor: '#fff3cd', color: '#856404', borderRadius: '4px', border: '1px solid #ffeeba' }}>
          <strong>No processed data found.</strong> Make sure the ML API has successfully processed at least one order.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #cbd5e1' }}>
              <th style={{ padding: '12px' }}>PO ID</th>
              <th style={{ padding: '12px' }}>Vendor ID</th>
              <th style={{ padding: '12px' }}>Actual LT</th>
              <th style={{ padding: '12px' }}>Predicted σ_L</th>
              <th style={{ padding: '12px' }}>Rec. Safety Stock</th>
              <th style={{ padding: '12px' }}>Risk Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              // DYNAMIC VIVA FIX: Calculate status on the fly based on the raw math
              const displayStatus = order.predicted_sigma_l > 1.85 ? 'CRITICAL' 
                                  : order.predicted_sigma_l > 1.65 ? 'WARNING' 
                                  : 'NORMAL';

              return (
                <tr key={order.po_id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '12px', fontWeight: '500' }}>{order.po_id}</td>
                  <td style={{ padding: '12px' }}>{order.vendor_id}</td>
                  <td style={{ padding: '12px' }}>{order.actual_lead_time} days</td>
                  <td style={{ padding: '12px' }}>{order.predicted_sigma_l}</td>
                  <td style={{ padding: '12px', fontWeight: 'bold' }}>{order.safety_stock} units</td>
                  <td style={{ padding: '12px' }}>
                    <span style={getRiskColor(displayStatus)}>
                      {displayStatus}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}