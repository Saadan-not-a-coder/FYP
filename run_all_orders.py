import os
import requests
from supabase import create_client, Client

# In production, set SUPABASE_URL / SUPABASE_KEY and ML_API_URL as env vars.
# For local dev the defaults below work out of the box.
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://bcnhsbkznrebqchaihbo.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl")
ML_API_URL   = os.getenv("ML_API_URL",   "http://localhost:8000")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

print(f"Fetching orders from database ({SUPABASE_URL})...")
response = supabase.table("orders").select("po_id").execute()
orders = response.data

print(f"Found {len(orders)} orders. Sending to ML pipeline at {ML_API_URL} ...")

count = 0
errors = 0
for order in orders:
    po_id = order['po_id']
    try:
        res = requests.post(
            f"{ML_API_URL}/api/analyze_risk",
            json={"po_id": po_id},
            timeout=30,
        )
        if res.status_code == 200:
            count += 1
            if count % 50 == 0:
                print(f"  Processed {count} / {len(orders)} orders...")
        else:
            errors += 1
            print(f"  Warning: PO {po_id} returned HTTP {res.status_code}: {res.text[:120]}")
    except Exception as e:
        errors += 1
        print(f"  Error processing PO {po_id}: {e}")

print(f"\nBatch complete — {count} succeeded, {errors} failed. Refresh the dashboard.")
