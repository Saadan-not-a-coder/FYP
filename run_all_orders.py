import requests
from supabase import create_client, Client

SUPABASE_URL = "https://bcnhsbkznrebqchaihbo.supabase.co"
SUPABASE_KEY = "sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl"
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

print("Fetching orders from database...")
response = supabase.table("orders").select("po_id").execute()
orders = response.data

print(f"Found {len(orders)} orders. Sending to ML Pipeline (this will take a few seconds)...")

count = 0
for order in orders:
    po_id = order['po_id']
    try:
        # Hitting your local FastAPI endpoint
        res = requests.post("http://localhost:8000/api/analyze_risk", json={"po_id": po_id})
        if res.status_code == 200:
            count += 1
            if count % 50 == 0:
                print(f"Successfully processed {count} / {len(orders)} orders...")
    except Exception as e:
        print(f"Failed to process PO {po_id}: {e}")

print("\nBatch processing complete! Go refresh your React dashboard.")