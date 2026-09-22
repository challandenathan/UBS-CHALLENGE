#!/usr/bin/env python3
"""
UBS Third-Party Risk Intelligence - Mistral pipeline for the FINAL dataset.

Inputs (relative to this script's folder, not the CWD):
  data/signals.csv   270 raw signals (11 cols incl. seed_category + provenance)
  data/vendors.csv   15 vendors with UBS dependency metadata

Stages:
  1. INGEST    signals.csv + vendors.csv -> normalised records.
               seed_category is HELD OUT (never shown to the classifier) and
               kept as ground truth to score the LLM against.
  2. CLASSIFY  mistral-small: category + sentiment + maturity + confidence,
               strict JSON schema. seed_category agreement is measured after.
  3. WARN      mistral-large agent with tools (query_signals,
               get_vendor_profile, compute_risk_score, raise_warning).
               Scores stay deterministic in Python; the LLM never invents
               numbers or evidence.

Usage:
  export MISTRAL_API_KEY=...
  python tpr_mistral.py ingest
  python tpr_mistral.py classify
  python tpr_mistral.py validate     # classifier vs seed_category agreement
  python tpr_mistral.py warn

Outputs consumed by risk_assessment.ipynb (step 4 - scoring, tiering, actions):
  ingested.json            normalised signals + vendor profiles (+ held-out truth)
  enriched_signals.jsonl   one record per signal with its LLM classification
  warnings.jsonl           the agent's own warnings, used there as a cross-check
"""
import csv, json, os, sys, time
import urllib.request
from datetime import date

API_KEY = os.environ.get("MISTRAL_API_KEY", "")
BASE = "https://api.mistral.ai/v1"
# all inputs/outputs resolve relative to this script, not the CWD
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INGESTED = os.path.join(BASE_DIR, "ingested.json")
ENRICHED = os.path.join(BASE_DIR, "enriched_signals.jsonl")
WARNINGS = os.path.join(BASE_DIR, "warnings.jsonl")

# ---------------------------------------------------------------- mistral io
def mistral(model, messages, tools=None, response_format=None, max_tokens=2000):
    body = {"model": model, "messages": messages, "max_tokens": max_tokens,
            "temperature": 0.2}
    if tools:
        body["tools"] = tools
    if response_format:
        body["response_format"] = response_format
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {API_KEY}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    return out["choices"][0]["message"]

# ---------------------------------------------------------------- 1. ingest
def ingest(signals_path=None, vendors_path=None):
    signals_path = signals_path or os.path.join(BASE_DIR, "data", "signals.csv")
    vendors_path = vendors_path or os.path.join(BASE_DIR, "data", "vendors.csv")
    signals = []
    with open(signals_path, newline="") as f:
        for r in csv.DictReader(f):
            signals.append({
                "signal_id": r["signal_id"],
                "vendor_id": r["vendor_id"],
                "vendor": r["vendor_name"],
                "date": r["date"],
                "source_type": r["source_type"],
                "source_name": r["source_name"] or r["source_type"],
                "url": r["source_url"],
                "text": r["text"],
                "mentions": r["mentions"],
                # held out from the LLM; ground truth for validation:
                "seed_category": r["seed_category"],
                "provenance": r["provenance"],   # REAL or ILLUSTRATIVE
            })
    profiles = {}
    with open(vendors_path, newline="") as f:
        for r in csv.DictReader(f):
            profiles[r["name"]] = {
                "vendor_id": r["vendor_id"],
                "aliases": r["aliases"].split("|"),
                "service": r["service"],
                "country": r["country"],
                "ubs_link": r["ubs_link"],   # CONFIRMED / REPORTED / INDUSTRY
                "relationship_note": r["relationship_note"],
                "ubs_link_source": r.get("ubs_link_source", ""),
                "data_sensitivity": int(r["data_sensitivity"]),        # 1-5
                "business_criticality": int(r["business_criticality"]), # 1-5
                # 1-5, 1 = hard to replace. Optional column; 3 = neutral default.
                "substitutability": int(r.get("substitutability") or 3),
            }
    with open(INGESTED, "w") as f:
        json.dump({"signals": signals, "profiles": profiles}, f, indent=1)
    n_real = sum(1 for s in signals if s["provenance"] == "REAL")
    print(f"ingested {len(signals)} signals ({n_real} REAL, "
          f"{len(signals)-n_real} ILLUSTRATIVE), {len(profiles)} vendor profiles")
    return signals, profiles

def load_ingested():
    d = json.load(open(INGESTED))
    return d["signals"], d["profiles"]

# ---------------------------------------------------------------- 2. classify
CLASSIFY_SCHEMA = {
    "type": "object",
    "required": ["is_about_vendor", "confidence", "category", "sentiment",
                 "maturity", "reason"],
    "properties": {
        "is_about_vendor": {"type": "boolean",
            "description": "Is the text about this vendor (not a homonym)?"},
        "confidence": {"type": "number",
            "description": "Confidence in the classification, 0.0 to 1.0"},
        "category": {"type": "string", "enum": [
            "CYBER", "CONDUCT", "COMPLIANCE", "CONCENTRATION",
            "OPERATIONAL", "FINANCIAL", "OTHER", "IRRELEVANT"],
            "description": ("IRRELEVANT = text is not about this vendor or "
                             "carries no vendor-risk information (homonym, "
                             "different company, unrelated sector, noise)")},
        "sentiment": {"type": "string", "enum": [
            "risk", "neutral", "positive"],
            "description": ("risk = this signal indicates a risk/exposure; "
                             "positive = good evidence (cert maintained, DR "
                             "test passed, remediation verified); neutral = "
                             "contextual/no risk direction")},
        "maturity": {"type": "string", "enum": [
            "rumor", "allegation", "corroborated", "confirmed", "n/a"]},
        "reason": {"type": "string"},
    },
}

def classify_all():
    signals, _ = load_ingested()
    # fail fast on connectivity/auth before looping 210 times
    try:
        mistral("mistral-small-latest",
                [{"role": "user", "content": "ping"}], max_tokens=5)
    except Exception as e:
        sys.exit(f"ABORT - cannot reach Mistral API: {e}\n"
                 "Check: WiFi/VPN/DNS (Errno 8) or API key (401).")
    enriched = []
    for s in signals:
        prompt = [
            {"role": "system", "content":
                "You classify third-party vendor risk signals for a bank. "
                "Signals come from vendor questionnaires, internal audit "
                "findings, incident tickets, news articles, regulatory "
                "filings and market data. First check the text is genuinely "
                "about the named vendor. Then pick the risk category "
                "(CYBER, CONDUCT, COMPLIANCE, CONCENTRATION, OPERATIONAL, "
                "FINANCIAL, OTHER, IRRELEVANT), the sentiment (risk / positive / "
                "neutral - many questionnaire responses and passed tests are "
                "POSITIVE evidence that reduces risk), and the maturity. "
                "Answer with a short reason.\n\n"
                "IRRELEVANT: use category IRRELEVANT (with "
                "is_about_vendor=false, sentiment neutral) when the text is "
                "NOT genuinely about the named vendor: it is about a "
                "different company or a homonym, it concerns the wider "
                "industry or macro events without new information about this "
                "vendor, or it is marketing/general news with no vendor-risk "
                "content. Do NOT force such texts into OTHER - OTHER is only "
                "for genuine vendor-risk signals that fit no listed "
                "category.\n\n"
                "OUR LABEL CONVENTIONS (follow these exactly):\n"
                "- Any evidence about SECURITY CONTROLS - certifications "
                "(ISO 27001, SOC 2), MFA, encryption, patching, access "
                "recertification, phishing results, breaches - is CYBER, "
                "even when reported in a questionnaire or attestation. "
                "Example: 'reports ISO 27001 and SOC 2 Type II maintained, "
                "with MFA enforced across all privileged accounts' -> "
                "category CYBER, sentiment positive.\n"
                "- Architecture and sourcing structure (multi-region, "
                "redundant failover, single data centre, sole source, "
                "vendor lock-in, exit plans, sub-contracting) is "
                "CONCENTRATION. Example: 'confirms a multi-region "
                "architecture with geographically redundant failover' -> "
                "CONCENTRATION, sentiment positive. Example: 'delivers the "
                "engagement from a single data centre' -> CONCENTRATION, "
                "sentiment risk.\n"
                # NEW: disambiguate OPERATIONAL service-delivery events
                "- BUT service-delivery events - DR test results, outages, "
                "degraded performance, delivery delays, batch backlogs - "
                "are OPERATIONAL, not CONCENTRATION. Example: 'DR test "
                "passed; failover tested successfully to a secondary site' "
                "-> OPERATIONAL, sentiment positive. Concentration is about "
                "STRUCTURE (who depends on whom), not about whether the "
                "service worked this quarter.\n"
                "- MFA not enforced, unpatched end-of-life software, "
                "dormant privileged accounts -> CYBER, sentiment risk.\n"
                "- Regulator actions, auditor refusals, attestations, "
                "certification renewals under an agreed control framework, "
                "data-residency contract gaps -> COMPLIANCE.\n"
                "- Fraud, executive misconduct, insider trading -> CONDUCT.\n"
                "Note: a certification RENEWAL under an agreed control "
                "framework is COMPLIANCE, but ISO 27001 / SOC 2 security "
                "certifications are CYBER."},
            {"role": "user", "content":
                f"Vendor: {s['vendor']}\nSource: {s['source_name']} "
                f"({s['source_type']})\nDate: {s['date']}\nText: {s['text']}"}]
        try:
            msg = mistral("mistral-small-latest", prompt,
                          response_format={"type": "json_schema",
                                           "json_schema": {"name": "signal",
                                                           "schema": CLASSIFY_SCHEMA,
                                                           "strict": True}})
            cls = json.loads(msg["content"])
            # clamp: the notebook contract requires 0-1, models sometimes answer 0-100
            cls["confidence"] = min(1.0, max(0.0, float(cls["confidence"])))
        except Exception as e:
            print("  classify failed:", e)
            cls = {"is_about_vendor": True, "confidence": 0, "category": "OTHER",
                   "sentiment": "neutral", "maturity": "n/a", "reason": f"error: {e}"}
        rec = {**s, "classification": cls}
        rec.pop("seed_category")
        enriched.append(rec)
        print(f"  {s['signal_id']} {s['vendor'][:22]:22} {cls['category']:13} "
              f"{cls['sentiment']:8} about={cls['is_about_vendor']}")
        time.sleep(0.3)
    with open(ENRICHED, "w") as f:
        for s in enriched:
            f.write(json.dumps(s) + "\n")
    print(f"enriched_signals.jsonl: {len(enriched)}")

# ------------------------------------------------------------- 2b. validate
def validate():
    """Score the LLM classifier against the held-out seed_category."""
    signals, _ = load_ingested()
    truth = {s["signal_id"]: s["seed_category"] for s in signals}
    enriched = [json.loads(l) for l in open(ENRICHED)]
    n, agree = 0, 0
    misses = []
    for e in enriched:
        t = truth.get(e["signal_id"])
        c = e["classification"]["category"]
        if not t:
            continue
        n += 1
        if t == c:
            agree += 1
        else:
            misses.append((e["signal_id"], t, c, e["vendor"]))
    print(f"classifier agreement vs seed_category: {agree}/{n} "
          f"({100*agree/max(n,1):.1f}%)")
    for sid, t, c, v in misses[:15]:
        print(f"  {sid} {v[:22]:22} seed={t:13} mistral={c}")
    return agree, n

# ---------------------------------------------------------------- 3. scoring
# source reliability: internal audit is highly reliable; self-reported
# questionnaires are weak evidence of good health but reliable admissions.
SOURCE_W = {
    "audit_finding": 1.2,
    "regulatory_filing": 1.3,
    "news_article": 1.0,
    "market_data": 0.9,
    "incident_ticket": 1.0,
    "vendor_questionnaire": 0.6,
}
MAT_W = {"rumor": 0.4, "allegation": 0.6, "corroborated": 0.85,
         "confirmed": 1.0, "n/a": 0.5}
SENT_W = {"risk": 1.0, "neutral": 0.0, "positive": -0.6}

def compute_risk_score(vendor, signals, profiles):
    """Deterministic recency-weighted vendor score 0-100. LLM calls this."""
    dated = [s["date"] for s in signals if s.get("date")]
    today = max(dated) if dated else date.today().isoformat()
    p = profiles.get(vendor, {})
    crit = (p.get("data_sensitivity", 3) + p.get("business_criticality", 3)
            + (6 - p.get("substitutability", 3))) / 15  # 0..1 UBS dependency
    raw = 0.0
    for s in signals:
        if s["vendor"] != vendor:
            continue
        c = s.get("classification", {})
        if not c.get("is_about_vendor", True):
            continue
        if c.get("category") == "IRRELEVANT":
            continue
        try:
            age = (date.fromisoformat(today) - date.fromisoformat(s["date"])).days
        except ValueError:
            continue
        rec = 0.5 ** (age / 365)          # 1-year half-life (long horizon data)
        sw = SOURCE_W.get(s["source_type"], 0.8)
        mw = MAT_W.get(c.get("maturity"), 0.5)
        sentw = SENT_W.get(c.get("sentiment"), 0.0)
        raw += 55 * sw * mw * sentw * rec
    score = min(100, max(0, 100 * raw / 200))
    dep = round(crit * 5, 1)  # 0-5 UBS dependency
    return {"risk_score": round(score, 1), "ubs_dependency_0_5": dep,
            "score_x_dependency": round(score * crit, 1)}

# ---------------------------------------------------------------- 4. agent
AGENT_TOOLS = [
    {"type": "function", "function": {
        "name": "query_signals",
        "description": "Get classified signals for a vendor (with sentiment)",
        "parameters": {"type": "object", "properties": {
            "vendor": {"type": "string"}}, "required": ["vendor"]}}},
    {"type": "function", "function": {
        "name": "get_vendor_profile",
        "description": "UBS dependency metadata (tier, criticality, relationship)",
        "parameters": {"type": "object", "properties": {
            "vendor": {"type": "string"}}, "required": ["vendor"]}}},
    {"type": "function", "function": {
        "name": "compute_risk_score",
        "description": "Deterministic recency-weighted risk score 0-100 plus UBS dependency weighting",
        "parameters": {"type": "object", "properties": {
            "vendor": {"type": "string"}}, "required": ["vendor"]}}},
    {"type": "function", "function": {
        "name": "raise_warning",
        "description": "Raise an early-warning flag. Only if evidence supports it. Cite real signal_ids.",
        "parameters": {"type": "object",
            "required": ["vendor", "level", "reason", "evidence_signal_ids"],
            "properties": {
                "vendor": {"type": "string"},
                "level": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]},
                "reason": {"type": "string"},
                "evidence_signal_ids": {"type": "array",
                    "items": {"type": "string"}}}}}},
]

def run_warning_agent(profiles):
    signals, _ = load_ingested()
    enriched = [json.loads(l) for l in open(ENRICHED)]
    warnings, tool_log = [], []

    def dispatch(name, args):
        tool_log.append((name, dict(args)))
        if name == "query_signals":
            return [{"signal_id": e["signal_id"], "date": e["date"],
                     "source_type": e["source_type"],
                     "classification": e["classification"],
                     "text": e["text"]}
                    for e in enriched if e["vendor"] == args["vendor"]]
        if name == "get_vendor_profile":
            return profiles.get(args["vendor"], {"ubs_link": "INDUSTRY"})
        if name == "compute_risk_score":
            return compute_risk_score(args["vendor"], enriched, profiles)
        if name == "raise_warning":
            byid = {e["signal_id"]: e for e in enriched}
            ev = [byid[sid] for sid in args["evidence_signal_ids"] if sid in byid]
            warnings.append({**args, "evidence": [
                {"signal_id": e["signal_id"], "date": e["date"],
                 "source_type": e["source_type"], "text": e["text"]}
                for e in ev]})
            return {"status": "warning raised", "n_evidence_attached": len(ev)}
        return {"error": f"unknown tool {name}"}

    for v in profiles:
        msgs = [
            {"role": "system", "content":
                "You are a third-party risk analyst at a bank. Investigate the "
                "vendor with your tools: query its classified signals, get the "
                "UBS dependency profile, compute the risk score. Then decide: "
                "raise a warning (citing the best evidence signal_ids) or state "
                "no warning is warranted. Weigh BOTH score AND UBS dependency: "
                "a high score on an INDUSTRY-link vendor may merit LOW; a "
                "moderate score on a CONFIRMED tier-1 vendor with sensitive "
                "data may merit HIGH. Positive signals (certs maintained, "
                "remediation verified) should reassure you. Never invent ids."},
            {"role": "user", "content": f"Investigate vendor: {v}"}]
        for _ in range(8):
            msg = mistral("mistral-large-latest", msgs, tools=AGENT_TOOLS)
            if msg.get("tool_calls"):
                msgs.append(msg)
                for tc in msg["tool_calls"]:
                    res = dispatch(tc["function"]["name"],
                                   json.loads(tc["function"]["arguments"]))
                    msgs.append({"role": "tool", "tool_call_id": tc["id"],
                                 "content": json.dumps(res, default=str)[:8000]})
            else:
                msgs.append(msg)
                print(f"[{v}] {msg['content'][:200]}")
                break
    with open(WARNINGS, "w") as f:
        for w in warnings:
            f.write(json.dumps(w) + "\n")
    print(f"\nwarnings raised: {len(warnings)} (tool calls: {len(tool_log)})")
    for w in warnings:
        print(f"  [{w['level']}] {w['vendor']}: {w['reason'][:110]}")
    return warnings

# ---------------------------------------------------------------- main
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("ingest", "all"):
        ingest()
    if cmd in ("classify", "all"):
        classify_all()
    if cmd == "validate":
        validate()
    if cmd in ("warn", "all"):
        _, profiles = load_ingested()
        run_warning_agent(profiles)