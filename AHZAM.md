# Ahzam branch — engineering log

This file records what was added on the `Ahzam` branch, and why that design was chosen. Work follows the MVP roadmap (sections 3.1–3.5) one item at a time.

---

## 3.1 Dynamic demand calculation

**Status:** complete

### What was done

- Restored the missing FastAPI service as `ml_service.py`. The README and batch script already expected this file and the `/api/analyze_risk` endpoint, but it was not in the repository.
- Added `requirements.txt` for the Python API (`fastapi`, `uvicorn`, `supabase`, `pydantic`, `requests`).
- Replaced the static daily demand assumption **µd = 10** with SKU-level demand estimated from historical `orders` rows.
- Safety stock now uses the combined demand + lead-time formula:

  `SS = Z × √(µL · σd² + µd² · σL²)` with `Z = 1.65` (95% service level).

- Reorder point is `ROP = µd · µL + SS`.
- Vendor lead-time mean/std (**µL**, **σL**) and the CRITICAL / WARNING / NORMAL bands on **σL** are unchanged.

### Why it was done this way

- **Restore the engine first.** Section 3.1 says to update `ml_service.py`. That file had to exist again before demand could be made dynamic, and so `run_all_orders.py` can still POST to localhost:8000.
- **Keep the original SS formula as a special case.** If demand is perfectly steady (`σd = 0`), the new formula reduces to the old `SS = 1.65 × µd × σL`. That makes the change easy to defend in a viva: we extended the model, we did not throw it away.
- **Do not zero-fill empty calendar days.** DataCo is a sampled order log, not a complete daily POS feed. Treating every day between the first and last sale as zero demand would collapse µd (for example SKU 1014 went to ~0.17 units/day) and make safety stock look broken. Demand is therefore the population mean and std of **units sold on days that actually have sales**.
- **Fallback µd = 10 only when a SKU has no sales rows.** Full cold-start handling for new *vendors* is roadmap item 3.4, so it was not mixed into this change.
- **No new database columns for µd / σd yet.** Those values are returned by the API and used immediately to write `safety_stock` and `reorder_point`. Schema changes are deferred until a later item that truly needs persisted extras (financial metrics, charts).

### How to verify

1. `python -m uvicorn ml_service:app --host 127.0.0.1 --port 8000`
2. POST `/api/analyze_risk` with `{"po_id": "56606"}` — expect µd ≈ 3.0, SS ≈ 10, ROP ≈ 20 (previously SS 29 / ROP 63 under static µd = 10).
3. Optional: `python run_all_orders.py` to refresh every row.

---

## 3.2 Financial cost of risk (actuarial metrics)

**Status:** complete

### What was done

- Added `cost_of_risk_metrics()` in `ml_service.py` so delay is converted into money on every `/api/analyze_risk` call.
- Added a **Financial Impact** column on the React dashboard.

Metrics:

| Metric | Formula | Meaning |
|---|---|---|
| Capital locked | `SS × unit_price` | Working capital tied up by the recommended buffer |
| Stockout cost / day | `µd × unit_price` | Revenue that does not land for each day of a stockout |
| **Cost of risk** | `σL × µd × unit_price` | Expected revenue exposure from one standard deviation of extra lead time |

The dashboard headline number is **cost of risk**. The smaller line shows capital locked vs daily stockout cost.

µd is recovered on the frontend from fields already stored on the order:

`µd = (reorder_point − safety_stock) / predicted_mu_l`

That identity holds because the engine writes `ROP = µd · µL + SS`.

### Why it was done this way

- **Two sides of the same trade-off.** The roadmap asked for capital locked in safety stock *versus* revenue lost per stockout day. Showing only one number would hide the holding-vs-stockout decision the jury cares about.
- **Cost of risk uses σL, not a single historical delay.** `delay_days` on one PO is a realized outcome. σL is the predictive uncertainty the rest of the MVP already ranks vendors by, so the dollar figure stays aligned with the risk badge.
- **No new Supabase columns.** Writing `cost_of_risk` into an unused field such as `predicted_p_late` would confuse a viva. Deriving money from `safety_stock`, `reorder_point`, `predicted_mu_l`, `predicted_sigma_l`, and `unit_price` keeps the schema stable and still works for rows that have not been re-batched.
- **Logic lives in Python first.** The dashboard repeats the same arithmetic for display so managers do not need a new DB migration before the column appears.

### How to verify

1. Refresh the dashboard — every row should show **$X at risk** plus buffer / stockout-per-day.
2. Check PO `56606` after the 3.1 recompute: unit price $39.99, SS 10, µd 3.0, σL 1.7122 → about **$205 at risk**, buffer locks **$400**, stockout **$120/day**.

---

## Remaining roadmap

- 3.3 Interactive vendor delivery charts
- 3.4 Cold-start fallback for new vendors
- 3.5 Cloud deployment and CI/CD
