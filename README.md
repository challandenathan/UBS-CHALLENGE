# Third-Party Risk Intelligence

**UBS Student Mini-Hackathon · Scenario 2 — "Can we detect risks before they hit UBS?"**

Turns public signals about suppliers into ranked, evidence-backed early warnings with an owner
and a deadline. An LLM reads and labels each signal; a deterministic Python policy decides what
it is worth. No score on the dashboard comes out of the model.

> Student prototype. Not a UBS system and not affiliated with or endorsed by UBS. The vendors are
> real companies, but signals marked `ILLUSTRATIVE` are synthetic examples written for the demo,
> and `ubs_link` records only what is publicly stated about a relationship.

## Pipeline

| Stage | Command | Output |
|---|---|---|
| 1. Ingest | `python tpr_mistral.py ingest` | `ingested.json` — normalised signals + vendor profiles |
| 2. Classify | `python tpr_mistral.py classify` | `enriched_signals.jsonl` — category, sentiment, maturity, confidence |
| 3. Grade the classifier | `python tpr_mistral.py validate` | agreement vs the held-out `seed_category` |
| 4. Agent warnings | `python tpr_mistral.py warn` | `warnings.jsonl` — `mistral-large` with tools |
| 5. Assess | run `risk_assessment.ipynb` | `scored_signals.csv`, `vendor_summary.csv`, `action_items.csv`, `alerts.json`, `run_meta.json` |
| 6. Dashboard | `python build_dashboard.py` | `frontend/data.js` |

Stages 2 and 4 call the Mistral API:

```bash
export MISTRAL_API_KEY=...
```

## Running the dashboard

```bash
python build_dashboard.py
open frontend/index.html          # macOS; or just double-click it
```

No server, no build step, no dependencies — the data is written as `frontend/data.js`, so the
page works straight from disk. Re-run `build_dashboard.py` after re-running the notebook.

The five tabs are deep-linkable (`index.html#analytics`):

- **Early warnings** — the alert feed: tier, score, why it was flagged, evidence, owner, deadline
- **Vendors** — portfolio table; select a vendor for its profile and full signal history
- **Signals** — every scored signal with its likelihood and impact (the table view behind the matrix)
- **Analytics** — likelihood × impact matrix, category and source breakdowns
- **How it scores** — the scoring policy and the guardrails, in words

## How a signal becomes a warning

1. **Gate** — wrong-entity signals dropped; only `risk`-direction signals are scored, `positive`
   ones (certs kept, DR tests passed, remediation verified) become control evidence.
2. **Likelihood (1–5)** = evidence strength (source credibility 35%, maturity 30%, classifier
   confidence 15%, corroboration 20%) × freshness (365-day half-life, floor 0.15).
3. **Impact (1–5)** = category base impact, moved by data sensitivity / business criticality /
   substitutability, scaled by how established the UBS link is (1.00 / 0.85 / 0.65).
4. **Residual risk** = L × I reduced by recent positive evidence, capped at 30%.
5. **Tier** — Critical ≥ 16, High ≥ 10, Medium ≥ 5, else Low. High and Critical become action items.

Guardrails: rumours and allegations cannot auto-escalate; a vendor with no confirmed UBS
relationship never reaches Critical; self-reported questionnaires carry the least weight; every
warning states whether its evidence is public or illustrative; nothing contacts a vendor
automatically.

## Requirements

`pandas`, `numpy`, `plotly` and `nbformat` for the notebook (`pip install pandas numpy plotly
"nbformat>=4.2"`); the pipeline script and the dashboard builder use only the standard library.
The frontend has no dependencies.

## Layout

```
tpr_mistral.py         collection + LLM classification + agent warnings
risk_assessment.ipynb  scoring, tiering, routing, sanity tests
build_dashboard.py     pipeline output -> frontend/data.js
frontend/              index.html · styles.css · app.js · data.js (generated)
data/                  signals.csv, vendors.csv
```
