#!/usr/bin/env python3
"""
Choice Properties — Scrape Run Summarizer
==========================================
Reads today's pipeline_scrape_runs and produces a formatted summary.

Flags:
  --github-summary  Write markdown to $GITHUB_STEP_SUMMARY (GitHub Actions)
  --send-email      Send email via Resend API (needs RESEND_API_KEY + NOTIFY_EMAIL)
  (no flag)         Print summary to stdout

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Optional env vars (for email):
  RESEND_API_KEY    API key from resend.com (free tier: 3,000 emails/month)
  NOTIFY_EMAIL      Destination email address
  FROM_EMAIL        Sender address (default: scraper@choiceproperties.com)
"""

import os
import sys
import json
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone, timedelta

SUPABASE_URL     = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
RESEND_API_KEY   = os.environ.get("RESEND_API_KEY", "")
NOTIFY_EMAIL     = os.environ.get("NOTIFY_EMAIL", "")
FROM_EMAIL       = os.environ.get("FROM_EMAIL", "scraper@choiceproperties.com")
ADMIN_URL        = os.environ.get("ADMIN_URL", "https://choice-properties-site.pages.dev/admin/pipeline.html")

_HEADERS = {
    "apikey":          SERVICE_ROLE_KEY,
    "Authorization":   f"Bearer {SERVICE_ROLE_KEY}",
    "Content-Type":    "application/json",
    "Accept":          "application/json",
    "Accept-Profile":  "pipeline",
    "Content-Profile": "pipeline",
}


# ── Supabase fetch ─────────────────────────────────────────────────────────────

def _fetch_recent_runs(hours: int = 26):
    """Fetch scrape runs from the last N hours (26h to catch yesterday's run too)."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    qs = urllib.parse.urlencode({
        "started_at": f"gte.{since}",
        "order":      "started_at.desc",
        "limit":      "200",
    })
    url = f"{SUPABASE_URL}/rest/v1/pipeline_scrape_runs?{qs}"
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        return [], f"HTTP {e.code}: {e.read().decode()[:200]}"
    except Exception as e:
        return [], str(e)


def _fetch_pipeline_totals():
    """Get current pipeline counts by status."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/pipeline_count"
    req = urllib.request.Request(
        url,
        headers={**_HEADERS, "Accept-Profile": "public", "Content-Profile": "public"}
    )
    # Override Accept-Profile since pipeline_count is a public RPC
    headers_pub = {k: v for k, v in _HEADERS.items()
                   if k not in ("Accept-Profile", "Content-Profile")}
    req2 = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/rpc/pipeline_count",
                                   headers=headers_pub, method="POST",
                                   data=b'{}')
    try:
        with urllib.request.urlopen(req2, timeout=10) as r:
            data = json.loads(r.read())
            if isinstance(data, str):
                data = json.loads(data)
            return data
    except Exception:
        return {}


# ── Summary builder ────────────────────────────────────────────────────────────

def _fmt_score(v):
    if v is None:
        return "—"
    v = round(float(v), 1)
    if v >= 80:
        return f"{v} 🟢"
    if v >= 60:
        return f"{v} 🟡"
    return f"{v} 🔴"


def build_markdown_summary(runs, pipeline_totals=None):
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if not runs:
        return f"## Choice Properties — Scrape Summary\n\n*No runs found in the last 26 hours.*\n\n_Generated {now_str}_"

    ok_runs  = [r for r in runs if not r.get("error_message")]
    err_runs = [r for r in runs if r.get("error_message")]

    total_found = sum(r.get("count_total",     0) or 0 for r in runs)
    total_new   = sum(r.get("count_new",       0) or 0 for r in runs)
    total_dup   = sum(r.get("count_duplicate", 0) or 0 for r in runs)

    scores      = [r.get("avg_score") for r in ok_runs if r.get("avg_score") is not None]
    avg_score   = round(sum(scores) / len(scores), 1) if scores else None

    # ── Header ────────────────────────────────────────────────────────────────
    lines = [
        f"## 🏠 Choice Properties — Scrape Summary",
        f"",
        f"**{total_new} new listings staged** from {len(runs)} market run(s)  ",
        f"Found: {total_found} &nbsp;·&nbsp; New: **{total_new}** &nbsp;·&nbsp; Dupes skipped: {total_dup} &nbsp;·&nbsp; Avg quality: {_fmt_score(avg_score)}",
        f"",
    ]

    # ── Per-market table ──────────────────────────────────────────────────────
    lines += [
        "### Per-market results",
        "",
        "| Status | Market | Found | New | Dupes | Avg Score |",
        "|:------:|--------|------:|----:|------:|----------:|",
    ]
    for r in runs:
        status = "❌" if r.get("error_message") else "✅"
        score  = _fmt_score(r.get("avg_score"))
        lines.append(
            f"| {status} | {r.get('location','?')} "
            f"| {r.get('count_total',0) or 0} "
            f"| {r.get('count_new',0) or 0} "
            f"| {r.get('count_duplicate',0) or 0} "
            f"| {score} |"
        )

    # ── Errors ────────────────────────────────────────────────────────────────
    if err_runs:
        lines += ["", "### ⚠️ Errors", ""]
        for r in err_runs:
            lines.append(f"- **{r.get('location','?')}**: {r.get('error_message','')[:200]}")

    # ── Pipeline totals ───────────────────────────────────────────────────────
    if pipeline_totals:
        scraped   = pipeline_totals.get("scraped",   0)
        edited    = pipeline_totals.get("edited",    0)
        published = pipeline_totals.get("published", 0)
        archived  = pipeline_totals.get("archived",  0)
        lines += [
            "",
            "### Pipeline totals (all time)",
            "",
            f"| Scraped (awaiting review) | Edited | Published | Archived |",
            f"|:-------------------------:|:------:|:---------:|:--------:|",
            f"| **{scraped}** | {edited} | {published} | {archived} |",
        ]

    # ── Footer ────────────────────────────────────────────────────────────────
    lines += [
        "",
        f"[Open Pipeline Review →]({ADMIN_URL})",
        "",
        f"_Generated {now_str}_",
    ]

    return "\n".join(lines)


def build_plain_text_summary(runs, pipeline_totals=None):
    """Plain-text version for email bodies."""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if not runs:
        return f"Choice Properties — Scrape Summary\n\nNo runs found in the last 26 hours.\n\nGenerated {now_str}"

    total_found = sum(r.get("count_total",     0) or 0 for r in runs)
    total_new   = sum(r.get("count_new",       0) or 0 for r in runs)
    total_dup   = sum(r.get("count_duplicate", 0) or 0 for r in runs)
    err_runs    = [r for r in runs if r.get("error_message")]

    lines = [
        "Choice Properties — Daily Scrape Summary",
        "=" * 42,
        f"Date: {now_str}",
        "",
        f"  New listings staged:  {total_new}",
        f"  Total found:          {total_found}",
        f"  Duplicates skipped:   {total_dup}",
        f"  Markets run:          {len(runs)}",
        f"  Errors:               {len(err_runs)}",
        "",
        "Per-market breakdown:",
        "-" * 42,
    ]

    for r in runs:
        status  = "ERR" if r.get("error_message") else " OK"
        score   = f"Q:{round(r.get('avg_score') or 0,1)}" if r.get("avg_score") else "    "
        lines.append(
            f"  [{status}] {r.get('location','?'):<25} "
            f"+{r.get('count_new',0) or 0:<4} new   {score}"
        )
        if r.get("error_message"):
            lines.append(f"         Error: {r['error_message'][:100]}")

    if pipeline_totals:
        scraped = pipeline_totals.get("scraped", 0)
        lines += [
            "",
            f"Pipeline: {scraped} listing(s) awaiting your review.",
        ]

    lines += [
        "",
        f"Review: {ADMIN_URL}",
    ]

    return "\n".join(lines)


# ── Output handlers ────────────────────────────────────────────────────────────

def write_github_summary(md_text):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        print("[github-summary] $GITHUB_STEP_SUMMARY not set — printing to stdout instead")
        print(md_text)
        return
    with open(path, "w") as f:
        f.write(md_text)
    print("✅ Summary written to GitHub Step Summary")


def send_email(plain_text, subject):
    if not RESEND_API_KEY:
        print("⚠️  RESEND_API_KEY not set — skipping email notification")
        return
    if not NOTIFY_EMAIL:
        print("⚠️  NOTIFY_EMAIL not set — skipping email notification")
        return

    payload = json.dumps({
        "from":    FROM_EMAIL,
        "to":      [NOTIFY_EMAIL],
        "subject": subject,
        "text":    plain_text,
    }).encode()

    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type":  "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read())
            print(f"✅ Email sent (id: {resp.get('id','?')})")
    except urllib.error.HTTPError as e:
        print(f"⚠️  Email failed (HTTP {e.code}): {e.read().decode()[:200]}")
    except Exception as e:
        print(f"⚠️  Email failed: {e}")


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]
    do_github = "--github-summary" in args
    do_email  = "--send-email"      in args

    if not SERVICE_ROLE_KEY:
        print("⚠️  SUPABASE_SERVICE_ROLE_KEY not set — skipping summary")
        sys.exit(0)

    runs, err = _fetch_recent_runs()
    if err:
        print(f"⚠️  Could not fetch scrape runs: {err}")
        sys.exit(0)

    totals = _fetch_pipeline_totals()

    if do_github:
        md = build_markdown_summary(runs, totals)
        write_github_summary(md)

    if do_email:
        today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        total_new = sum(r.get("count_new", 0) or 0 for r in runs)
        subject = f"Choice Properties — {total_new} new listings scraped ({today})"
        plain   = build_plain_text_summary(runs, totals)
        send_email(plain, subject)

    if not do_github and not do_email:
        print(build_plain_text_summary(runs, totals))
