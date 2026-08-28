#!/usr/bin/env python3
"""
Loxo company report - one script, one output file: output/company_report.csv
(Company ID, Company Name, Total Jobs, Total CVs, Total Revenue)

Flow, exactly as scoped per company (no global full-table scans):
    1. GET /companies                            - every company (scroll-paginated)
    2. GET /companies/{id}/people                 - that company's people -> person ids
    3. GET /placements?query=person_id:(id1 OR id2 ...)
                                                    - placements for exactly those people,
                                                      summed into revenue (formula below)
    4. GET /person_events?query=person_id:(id1 OR id2 ...)
                                                    - events for exactly those people:
                                                        - Total CVs: activity_type.key is a
                                                          CV-sent type (moved_to_cv_sent,
                                                          delivery_cv_sends)
                                                        - Total Jobs: distinct job_id values
                                                          across those events

`person_id` is not a plain query-string param on /placements (that 422s) - it's a field
inside the `query` param's Lucene syntax, confirmed against the Loxo OpenAPI spec and
tested live: query=person_id:(111 OR 222) returns exactly the placements/events for
those people. This is what "query by people id" means on this API. A company's people
are batched into groups of up to ID_BATCH_SIZE to keep the query string a sane length.

For each company, Total Jobs / Total CVs / Total Revenue are the SUM of its own
people's individual numbers - one row per company, never summed across companies.

Revenue per placement:
    - fee_type "percentage": salary * (fee / 100)
    - fee_type "flat":       fee (already an absolute amount)
    - no fee_type (typical for Contract/MSP placements): bill_rate - pay_rate
      (bill_rate = what we charge the client, pay_rate = what we pay the
      contractor; both legitimately can be 0)

Usage:
    python3 loxo_report.py                  # full run, all companies
    python3 loxo_report.py --limit 50       # only process the first 50 companies (testing)
    python3 loxo_report.py --workers 15     # concurrency across companies
    python3 loxo_report.py --no-resume      # ignore existing partial output and start over
"""
import argparse
import csv
import os
import sys
import time
import concurrent.futures
from threading import Lock

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

AGENCY_SLUG = "Lignum-group"
BASE_URL = f"https://app.loxo.co/api/{AGENCY_SLUG}"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, ".env")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
COMPANY_CSV = os.path.join(OUTPUT_DIR, "company_report.csv")

COMPANY_FIELDS = ["Company ID", "Company Name", "Total Jobs", "Total CVs", "Total Revenue"]

# The two activity_type keys in this agency's /person_events data that
# represent a CV/resume being sent (out of ~70 distinct activity types -
# interview stages, calls, emails, notes, etc. are excluded).
CV_EVENT_KEYS = {"moved_to_cv_sent", "delivery_cv_sends"}

# How many person ids to OR together in one Lucene query. The API hard-caps
# this at 26 conditions ("Too many \"OR\" conditions in query", confirmed
# live on both /placements and /person_events) - 25 leaves a safety margin.
# A company with more people than this gets its people queried in batches.
ID_BATCH_SIZE = 25


def load_token():
    """Read the bearer token out of .env. Supports KEY=VALUE lines
    (LOXO_TOKEN / LOXO_API_KEY / LOXO_BEARER_TOKEN / TOKEN) or a bare
    token with no key at all (this project's current .env format)."""
    if not os.path.exists(ENV_PATH):
        sys.exit(f"Missing .env file at {ENV_PATH}")

    with open(ENV_PATH, "r") as f:
        raw = f.read().strip()

    candidate_keys = {"LOXO_TOKEN", "LOXO_API_KEY", "LOXO_BEARER_TOKEN", "TOKEN", "BEARER_TOKEN"}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip().upper() in candidate_keys:
            return value.strip().strip('"').strip("'")

    token = raw.splitlines()[0].strip() if raw else ""
    if not token:
        sys.exit("Could not find a bearer token in .env")
    return token


def make_session(token):
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def paginate(session, path, params=None, per_page=None):
    """Generic scroll-cursor pagination for Loxo list endpoints.
    Yields each raw item dict; stops when a page comes back empty.
    `params` (e.g. {"query": "..."}) is re-sent on every page - the
    scroll_id alone does NOT preserve a query filter (confirmed live:
    dropping it resets the result set back to everything unfiltered)."""
    key = path.rsplit("/", 1)[-1]  # e.g. "companies/123/people" -> "people"
    base_params = dict(params or {})
    if per_page:
        base_params["per_page"] = per_page

    request_params = dict(base_params)
    while True:
        resp = session.get(f"{BASE_URL}/{path}", params=request_params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        items = data.get(key, [])
        if not items:
            return
        for item in items:
            yield item
        scroll_id = data.get("scroll_id")
        if not scroll_id:
            return
        request_params = dict(base_params)
        request_params["scroll_id"] = scroll_id


def chunked(seq, size):
    seq = list(seq)
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def compute_revenue(p):
    fee_type = (p.get("fee_type") or {}).get("key")
    fee = float(p.get("fee") or 0)
    salary = float(p.get("salary") or 0)
    bill_rate = float(p.get("bill_rate") or 0)
    pay_rate = float(p.get("pay_rate") or 0)

    if fee_type == "percentage" and fee:
        return salary * (fee / 100.0)
    if fee_type == "flat" and fee:
        return fee
    return bill_rate - pay_rate


def fetch_company_people(session, company_id):
    person_ids = []
    for person in paginate(session, f"companies/{company_id}/people"):
        if person.get("id") is not None:
            person_ids.append(person["id"])
    return person_ids


def revenue_for_people(session, person_ids):
    total = 0.0
    for batch in chunked(person_ids, ID_BATCH_SIZE):
        query = "person_id:(" + " OR ".join(str(i) for i in batch) + ")"
        for p in paginate(session, "placements", params={"query": query}):
            total += compute_revenue(p)
    return total


def jobs_and_cvs_for_people(session, person_ids):
    cv_count = 0
    job_ids = set()
    for batch in chunked(person_ids, ID_BATCH_SIZE):
        query = "person_id:(" + " OR ".join(str(i) for i in batch) + ")"
        for e in paginate(session, "person_events", params={"query": query}, per_page=100):
            activity_key = (e.get("activity_type") or {}).get("key")
            if activity_key in CV_EVENT_KEYS:
                cv_count += 1
            if e.get("job_id") is not None:
                job_ids.add(e["job_id"])
    return len(job_ids), cv_count


def load_processed_ids(csv_path):
    if not os.path.exists(csv_path):
        return set()
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        return {row["Company ID"] for row in reader}


def run(session, workers, resume, limit=None):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    processed_ids = load_processed_ids(COMPANY_CSV) if resume else set()
    write_header = not (resume and os.path.exists(COMPANY_CSV))
    file_mode = "a" if (resume and os.path.exists(COMPANY_CSV)) else "w"

    print("Fetching companies list (paginating)...")
    companies = []
    for c in paginate(session, "companies", per_page=100):
        cid = str(c["id"])
        if cid in processed_ids:
            continue
        companies.append({"id": cid, "name": c.get("name") or ""})
        if limit and len(companies) >= limit:
            break
    print(f"Found {len(companies)} companies left to process "
          f"({len(processed_ids)} already done, resuming)." if processed_ids
          else f"Found {len(companies)} companies.")

    if not companies:
        print("Nothing new to process.")
        return

    out_f = open(COMPANY_CSV, file_mode, newline="")
    writer = csv.DictWriter(out_f, fieldnames=COMPANY_FIELDS)
    if write_header:
        writer.writeheader()
    write_lock = Lock()
    done = 0
    lock = Lock()

    def worker(c):
        try:
            person_ids = fetch_company_people(session, c["id"])
            if person_ids:
                revenue = revenue_for_people(session, person_ids)
                total_jobs, total_cvs = jobs_and_cvs_for_people(session, person_ids)
            else:
                revenue, total_jobs, total_cvs = 0.0, 0, 0
        except requests.RequestException as e:
            print(f"  ! failed to process company {c['id']}: {e}", file=sys.stderr)
            return None

        return {
            "Company ID": c["id"],
            "Company Name": c["name"],
            "Total Jobs": total_jobs,
            "Total CVs": total_cvs,
            "Total Revenue": round(revenue, 2),
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(worker, c): c for c in companies}
        for future in concurrent.futures.as_completed(futures):
            row = future.result()
            with lock:
                done += 1
                if done % 100 == 0:
                    print(f"  processed {done}/{len(companies)} companies...")
            if row is None:
                continue
            with write_lock:
                writer.writerow(row)
                out_f.flush()

    out_f.close()
    print(f"Company report written to {COMPANY_CSV} (one row per company, not summed)")


def main():
    parser = argparse.ArgumentParser(description="Loxo company report: jobs, CVs, revenue per company")
    parser.add_argument("--workers", type=int, default=5, help="concurrent requests across companies")
    parser.add_argument("--no-resume", action="store_true", help="ignore existing partial output and start over")
    parser.add_argument("--limit", type=int, default=None, help="only process this many companies (e.g. for a quick test run)")
    args = parser.parse_args()

    token = load_token()
    session = make_session(token)

    t0 = time.time()
    run(session, workers=args.workers, resume=not args.no_resume, limit=args.limit)
    print(f"Done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
