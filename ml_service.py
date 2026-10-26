"""
Supply Chain Risk Inference API.

Computes vendor lead-time statistics and SKU-level demand, then writes
risk-adjusted safety stock back to Supabase.

Cold-start (3.4): vendors with no delivery history receive the global
fleet-average µ_L / σ_L instead of a hard error.  Their risk_status is
prefixed with "COLD_" (e.g. "COLD_CRITICAL") so the dashboard can flag
them without a schema change.
"""

import os
from collections import defaultdict
from datetime import datetime
from statistics import mean, pstdev

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import Client, create_client

# Read from environment; fall back to the project defaults so local dev
# works without a .env file.  In production (Render) set these as env vars.
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://bcnhsbkznrebqchaihbo.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_5hxw_O-rS0zP4OtAQ5vnsQ__3XzOocl")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

Z_SCORE = 1.65              # 95 % service level
LEGACY_DAILY_DEMAND = 10.0  # fallback µ_d if a SKU has no sales rows at all

# Hard-coded last-resort values used only when the entire database is empty
# (e.g. first boot with zero orders).
_HARD_FALLBACK_MU_L    = 7.0
_HARD_FALLBACK_SIGMA_L = 2.0

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


# ── Module-level cache for the global fleet statistics ───────────────────────
# Populated on the first call to _global_lead_time_stats() and kept for the
# lifetime of the process.  Call /api/reset_global_cache to invalidate.
_global_stats_cache: tuple[float, float, int] | None = None


def _global_lead_time_stats() -> tuple[float, float, int]:
    """
    Fleet-wide lead-time mean and std across ALL vendors and orders.

    Computed once per process start and cached so subsequent cold-start
    lookups are free.  Returns (µ_L, σ_L, n).
    """
    global _global_stats_cache
    if _global_stats_cache is not None:
        return _global_stats_cache

    rows = (
        supabase.table("orders")
        .select("actual_lead_time")
        .execute()
        .data
        or []
    )
    lead_times = [
        float(r["actual_lead_time"])
        for r in rows
        if r.get("actual_lead_time") is not None
    ]

    if not lead_times:
        # Absolute last resort — database has no lead-time data at all.
        _global_stats_cache = (_HARD_FALLBACK_MU_L, _HARD_FALLBACK_SIGMA_L, 0)
    elif len(lead_times) == 1:
        _global_stats_cache = (lead_times[0], 0.0, 1)
    else:
        _global_stats_cache = (mean(lead_times), pstdev(lead_times), len(lead_times))

    return _global_stats_cache


# ── Domain helpers ───────────────────────────────────────────────────────────

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
    """
    Return (µ_L, σ_L, n) for a vendor.

    3.4 cold-start: if the vendor has no delivery history (n == 0), the
    global fleet average is substituted instead of raising an error.
    The caller detects cold-start by checking n == 0.
    """
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
        # ── Cold-start path ──────────────────────────────────────────────────
        # Return n=0 to signal to the caller that fallback values are in use.
        global_mu, global_sigma, _ = _global_lead_time_stats()
        return global_mu, global_sigma, 0

    if len(lead_times) == 1:
        return lead_times[0], 0.0, 1
    return mean(lead_times), pstdev(lead_times), len(lead_times)


def safety_stock(mu_d: float, sigma_d: float, mu_l: float, sigma_l: float) -> float:
    """Classic independent demand + lead-time safety stock."""
    return Z_SCORE * ((mu_l * (sigma_d ** 2)) + ((mu_d ** 2) * (sigma_l ** 2))) ** 0.5


def cost_of_risk_metrics(
    safety_stock_units: float,
    mu_d: float,
    sigma_l: float,
    unit_price: float | None,
) -> dict[str, float]:
    """
    Translate delay risk into money.

    - capital_locked:        working capital tied up by the recommended buffer
    - stockout_cost_per_day: revenue that does not land for each stockout day
    - cost_of_risk:          expected revenue exposure from one σ of extra lead time
    """
    price = float(unit_price or 0)
    capital_locked        = safety_stock_units * price
    stockout_cost_per_day = mu_d * price
    cost_of_risk          = sigma_l * stockout_cost_per_day
    return {
        "capital_locked":        round(capital_locked, 2),
        "stockout_cost_per_day": round(stockout_cost_per_day, 2),
        "cost_of_risk":          round(cost_of_risk, 2),
    }


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/global_stats")
def global_stats():
    """
    Returns the fleet-wide lead-time statistics used as the cold-start
    fallback for vendors with no delivery history.

    Useful for viva / debugging: confirms what baseline the engine uses
    before a new vendor has accumulated enough orders to be self-sufficient.
    """
    mu, sigma, n = _global_lead_time_stats()
    status = _risk_status(sigma)
    return {
        "fleet_mu_l":    round(mu, 4),
        "fleet_sigma_l": round(sigma, 4),
        "fleet_n":       n,
        "implied_status": status,
        "note": (
            "These values are substituted for any vendor whose vendor_history_n == 0. "
            "Their risk_status is stored as COLD_<STATUS> in the orders table."
        ),
    }


@app.post("/api/reset_global_cache")
def reset_global_cache():
    """
    Invalidates the in-process global-stats cache so the next cold-start
    lookup re-queries Supabase.  Call this after bulk-importing new orders.
    """
    global _global_stats_cache
    _global_stats_cache = None
    return {"status": "cache cleared"}


@app.post("/api/analyze_risk")
def analyze_risk(payload: AnalyzeRequest):
    order_rows = (
        supabase.table("orders")
        .select("po_id,vendor_id,sku_id,unit_price")
        .eq("po_id", payload.po_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not order_rows:
        raise HTTPException(status_code=404, detail=f"Order {payload.po_id} not found")

    order     = order_rows[0]
    vendor_id = order["vendor_id"]
    sku_id    = order["sku_id"]

    mu_l, sigma_l, vendor_n   = vendor_lead_time_stats(vendor_id)
    mu_d, sigma_d, demand_days = sku_daily_demand(sku_id)

    # 3.4: vendor_n == 0 means cold-start — no real history for this vendor.
    cold_start = vendor_n == 0

    ss           = safety_stock(mu_d, sigma_d, mu_l, sigma_l)
    reorder_point = (mu_d * mu_l) + ss
    ss_units     = int(round(ss))
    rop_units    = int(round(reorder_point))

    base_status = _risk_status(sigma_l)
    # Prefix "COLD_" when the vendor has no history so the dashboard can
    # detect it from the stored risk_status without a new DB column.
    stored_status = ("COLD_" + base_status) if cold_start else base_status

    money = cost_of_risk_metrics(ss_units, mu_d, sigma_l, order.get("unit_price"))

    update_body = {
        "predicted_mu_l":    round(mu_l, 4),
        "predicted_sigma_l": round(sigma_l, 4),
        "safety_stock":      ss_units,
        "reorder_point":     rop_units,
        "risk_status":       stored_status,
    }

    supabase.table("orders").update(update_body).eq("po_id", payload.po_id).execute()

    # ── Cold-start explanation included in the response ──────────────────────
    global_mu, global_sigma, global_n = _global_lead_time_stats()
    cold_start_note = (
        f"No delivery history found for vendor '{vendor_id}'. "
        f"Global fleet average used as fallback "
        f"(µ_L={round(global_mu, 2)}, σ_L={round(global_sigma, 4)}, "
        f"based on {global_n} deliveries across all vendors)."
    ) if cold_start else None

    return {
        **update_body,
        "po_id":             payload.po_id,
        "vendor_id":         vendor_id,
        "sku_id":            sku_id,
        "avg_daily_demand":  round(mu_d, 4),
        "demand_sigma":      round(sigma_d, 4),
        "demand_days":       demand_days,
        "vendor_history_n":  vendor_n,
        "cold_start":        cold_start,
        "cold_start_note":   cold_start_note,
        "z_score":           Z_SCORE,
        "unit_price":        order.get("unit_price"),
        **money,
        "formula":              "SS = Z * sqrt(µ_L * σ_d^2 + µ_d^2 * σ_L^2)",
        "cost_of_risk_formula": "cost_of_risk = σ_L * µ_d * unit_price",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("ml_service:app", host="0.0.0.0", port=8000, reload=False)
