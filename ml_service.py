"""
Supply Chain Risk Inference API.

Computes vendor lead-time statistics and SKU-level demand, then writes
risk-adjusted safety stock back to Supabase.
"""

from collections import defaultdict
from datetime import datetime
from statistics import mean, pstdev

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import Client, create_client

SUPABASE_URL = "https://bcnhsbkznrebqchaihbo.supabase.co"
SUPABASE_KEY = "sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl"
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

Z_SCORE = 1.65  # 95% service level
LEGACY_DAILY_DEMAND = 10.0  # previous static µ_d; used only if a SKU has no sales

app = FastAPI(title="Supply Chain Risk Engine")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    po_id: str


def _risk_status(sigma_l: float) -> str:
    if sigma_l > 1.85:
        return "CRITICAL"
    if sigma_l > 1.65:
        return "WARNING"
    return "NORMAL"


def _parse_day(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return value[:10]


def sku_daily_demand(sku_id: str) -> tuple[float, float, int]:
    """
    Estimate µ_d and σ_d from the SKU's historical sales.

    DataCo is an event-sampled order log, not a complete daily POS feed.
    Zero-filling every calendar day between the first and last sale would
    treat missing sample days as true zero demand and collapse µ_d.
    We therefore aggregate units sold per calendar day that actually has
    sales, then take the population mean and standard deviation.
    """
    history = (
        supabase.table("orders")
        .select("quantity,order_date")
        .eq("sku_id", sku_id)
        .execute()
        .data
        or []
    )

    daily_totals: dict[str, float] = defaultdict(float)
    for row in history:
        day = _parse_day(row.get("order_date"))
        qty = row.get("quantity")
        if day is None or qty is None:
            continue
        daily_totals[day] += float(qty)

    series = list(daily_totals.values())
    if not series:
        return LEGACY_DAILY_DEMAND, 0.0, 0
    if len(series) == 1:
        return series[0], 0.0, 1
    return mean(series), pstdev(series), len(series)


def vendor_lead_time_stats(vendor_id: str) -> tuple[float, float, int]:
    history = (
        supabase.table("orders")
        .select("actual_lead_time")
        .eq("vendor_id", vendor_id)
        .execute()
        .data
        or []
    )
    lead_times = [
        float(row["actual_lead_time"])
        for row in history
        if row.get("actual_lead_time") is not None
    ]
    if not lead_times:
        raise HTTPException(status_code=422, detail=f"No lead-time history for vendor {vendor_id}")
    if len(lead_times) == 1:
        return lead_times[0], 0.0, 1
    return mean(lead_times), pstdev(lead_times), len(lead_times)


def safety_stock(mu_d: float, sigma_d: float, mu_l: float, sigma_l: float) -> float:
    """Classic independent demand + lead-time safety stock."""
    return Z_SCORE * ((mu_l * (sigma_d ** 2)) + ((mu_d ** 2) * (sigma_l ** 2))) ** 0.5


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/analyze_risk")
def analyze_risk(payload: AnalyzeRequest):
    order_rows = (
        supabase.table("orders")
        .select("po_id,vendor_id,sku_id")
        .eq("po_id", payload.po_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not order_rows:
        raise HTTPException(status_code=404, detail=f"Order {payload.po_id} not found")

    order = order_rows[0]
    vendor_id = order["vendor_id"]
    sku_id = order["sku_id"]

    mu_l, sigma_l, vendor_n = vendor_lead_time_stats(vendor_id)
    mu_d, sigma_d, demand_days = sku_daily_demand(sku_id)

    ss = safety_stock(mu_d, sigma_d, mu_l, sigma_l)
    reorder_point = (mu_d * mu_l) + ss
    status = _risk_status(sigma_l)

    update_body = {
        "predicted_mu_l": round(mu_l, 4),
        "predicted_sigma_l": round(sigma_l, 4),
        "safety_stock": int(round(ss)),
        "reorder_point": int(round(reorder_point)),
        "risk_status": status,
    }

    supabase.table("orders").update(update_body).eq("po_id", payload.po_id).execute()

    return {
        **update_body,
        "po_id": payload.po_id,
        "vendor_id": vendor_id,
        "sku_id": sku_id,
        "avg_daily_demand": round(mu_d, 4),
        "demand_sigma": round(sigma_d, 4),
        "demand_days": demand_days,
        "vendor_history_n": vendor_n,
        "z_score": Z_SCORE,
        "formula": "SS = Z * sqrt(µ_L * σ_d^2 + µ_d^2 * σ_L^2)",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("ml_service:app", host="0.0.0.0", port=8000, reload=False)
