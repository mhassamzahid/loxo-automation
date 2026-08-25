#!/usr/bin/env python3
"""
Loxo reporting script. Produces two output files:

    output/report.csv          (one row per person)
        ID          - person id (from the People API)
        Total Jobs  - number of jobs they've been a candidate for (candidate_jobs)
        Total CVs   - number of resumes/CVs attached to their profile
        Revenue     - summed revenue across all of their placements

    output/company_report.csv  (one row per hiring company)
        Company ID       - company id (from placement.job.company)
        Company Name
        Total Jobs       - distinct jobs at that company that had a placement
        Total Resumes    - summed CV count of every candidate placed there
        Placement Count  - number of placements made for that company
        Total Revenue    - summed revenue across all of that company's placements
        (only companies that appear on at least one placement are listed -
        there's no companies list endpoint here to enumerate the rest)

Revenue per placement is calculated from the Placements API as:
    - fee_type "percentage": salary * (fee / 100)
    - fee_type "flat":       fee (already an absolute amount)
    - no fee_type (typical for Contract/MSP placements): bill_rate - pay_rate
      (bill_rate = what we charge the client, pay_rate = what we pay the
      contractor; both legitimately can be 0)
Both reports sum per-row (per person / per company) - rows are never
summed together into a single value.

Usage:
    python3 loxo_report.py                 # full run, both reports
    python3 loxo_report.py --people-only
    python3 loxo_report.py --company-only
    python3 loxo_report.py --workers 15    # concurrency for per-person detail calls
    python3 loxo_report.py --no-resume     # ignore existing partial report.csv and start over
    python3 loxo_report.py --limit 500     # cap how many people are processed (report.csv only)
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
REPORT_CSV = os.path.join(OUTPUT_DIR, "report.csv")
COMPANY_CSV = os.path.join(OUTPUT_DIR, "company_report.csv")

REPORT_FIELDS = ["ID", "Total Jobs", "Total CVs", "Revenue"]
COMPANY_FIELDS = ["Company ID", "Company Name", "Total Jobs", "Total Resumes", "Placement Count", "Total Revenue"]


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

    # Fall back to treating the whole file as a bare token (no KEY= prefix).
    token = raw.splitlines()[0].strip() if raw else ""
    if not token:
        sys.exit("Could not find a bearer token in .env")
    return token


def make_session(token):
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    retry = Retry(
        total=5,
        backoff_factor=1.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def paginate(session, path, per_page=None):
    """Generic scroll-cursor pagination for Loxo list endpoints.
    Yields each raw item dict; stops when a page comes back empty.
    per_page is only honored where the endpoint actually supports it
    (e.g. /people accepts it, /placements returns 422 if it's set)."""
    url = f"{BASE_URL}/{path}"
    if per_page:
        url += f"?per_page={per_page}"
    while True:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        items = data.get(path, [])
        if not items:
            return
        for item in items:
            yield item
        scroll_id = data.get("scroll_id")
        if not scroll_id:
            return
        url = f"{BASE_URL}/{path}?scroll_id={scroll_id}"


def fetch_person_detail(session, person_id):
    resp = session.get(f"{BASE_URL}/people/{person_id}", timeout=30)
    resp.raise_for_status()
    return resp.json()


def load_processed_ids(csv_path):
    if not os.path.exists(csv_path):
        return set()
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        return {row["ID"] for row in reader}


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
    # No fee set (typical for Contract/MSP placements): fall back to the
    # bill/pay rate margin. Both values legitimately can be 0.
    return bill_rate - pay_rate


def build_placement_aggregates(session):
    """Pulls every placement once and rolls it up two ways:
      - revenue_by_person: person_id(str) -> summed revenue
      - company_agg: company_id(str) -> {name, placement_count, revenue,
        job_ids (set), person_ids (set)}
    A person/company with multiple placements gets one summed total here;
    nothing is written to disk in this function."""
    print("Fetching placements (paginating) and calculating revenue...")
    revenue_by_person = {}
    company_agg = {}
    count = 0
    for p in paginate(session, "placements"):
        revenue = compute_revenue(p)
        person = p.get("person") or {}
        job = p.get("job") or {}
        company = job.get("company") or {}

        if person.get("id") is not None:
            pid = str(person["id"])
            revenue_by_person[pid] = revenue_by_person.get(pid, 0.0) + revenue

        if company.get("id") is not None:
            cid = str(company["id"])
            entry = company_agg.setdefault(cid, {
                "name": company.get("name") or "",
                "placement_count": 0,
                "revenue": 0.0,
                "job_ids": set(),
                "person_ids": set(),
            })
            entry["placement_count"] += 1
            entry["revenue"] += revenue
            if job.get("id") is not None:
                entry["job_ids"].add(job["id"])
            if person.get("id") is not None:
                entry["person_ids"].add(str(person["id"]))

        count += 1
        if count % 200 == 0:
            print(f"  processed {count} placements...")
    print(f"  done: {count} placements across {len(revenue_by_person)} people "
          f"and {len(company_agg)} companies.")
    return revenue_by_person, company_agg


def fetch_resume_counts(session, workers, person_ids, label="people", on_result=None):
    """Concurrently fetches person detail for each id in person_ids and
    returns {person_id(str): resume_count}. Failures are logged and
    omitted (caller sees 0 for a missing id). If on_result is given, it's
    called as (pid, count) for each success as soon as it completes -
    used by run_report to flush rows to disk incrementally on long runs."""
    resume_counts = {}
    lock = Lock()
    done = 0
    total = len(person_ids)

    def worker(pid):
        try:
            detail = fetch_person_detail(session, pid)
            return pid, len(detail.get("resumes") or [])
        except requests.RequestException as e:
            print(f"  ! failed to fetch person {pid}: {e}", file=sys.stderr)
            return pid, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(worker, pid) for pid in person_ids]
        for future in concurrent.futures.as_completed(futures):
            pid, count = future.result()
            with lock:
                done += 1
                if done % 200 == 0:
                    print(f"  resolved resumes for {done}/{total} {label}...")
            if count is not None:
                resume_counts[pid] = count
                if on_result:
                    on_result(pid, count)
    return resume_counts


def run_report(session, workers, resume, revenue_by_person, limit=None):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    processed_ids = load_processed_ids(REPORT_CSV) if resume else set()
    write_header = not (resume and os.path.exists(REPORT_CSV))
    file_mode = "a" if (resume and os.path.exists(REPORT_CSV)) else "w"

    print("Fetching people list (paginating)...")
    people = []
    for person in paginate(session, "people", per_page=100):
        pid = str(person["id"])
        if pid in processed_ids:
            continue
        people.append({
            "person_id": pid,
            "job_count": len(person.get("candidate_jobs") or []),
        })
        if limit and len(people) >= limit:
            break
    print(f"Found {len(people)} people left to process "
          f"({len(processed_ids)} already done, resuming)." if processed_ids
          else f"Found {len(people)} people.")

    if not people:
        print("Nothing new to process for report.csv.")
        return

    job_count_by_id = {p["person_id"]: p["job_count"] for p in people}
    out_f = open(REPORT_CSV, file_mode, newline="")
    writer = csv.DictWriter(out_f, fieldnames=REPORT_FIELDS)
    if write_header:
        writer.writeheader()
    write_lock = Lock()

    def on_result(pid, resume_count):
        with write_lock:
            writer.writerow({
                "ID": pid,
                "Total Jobs": job_count_by_id[pid],
                "Total CVs": resume_count,
                "Revenue": round(revenue_by_person.get(pid, 0.0), 2),
            })
            out_f.flush()

    fetch_resume_counts(session, workers, [p["person_id"] for p in people], label="people", on_result=on_result)
    out_f.close()
    print(f"Report written to {REPORT_CSV} (one row per person, not summed)")


def run_company_report(session, workers, company_agg):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not company_agg:
        print("No companies found in placements; skipping company_report.csv.")
        return

    all_person_ids = set()
    for entry in company_agg.values():
        all_person_ids |= entry["person_ids"]

    print(f"Resolving CV counts for {len(all_person_ids)} placed candidates (for company rollup)...")
    resume_counts = fetch_resume_counts(session, workers, all_person_ids, label="placed candidates")

    with open(COMPANY_CSV, "w", newline="") as out_f:
        writer = csv.DictWriter(out_f, fieldnames=COMPANY_FIELDS)
        writer.writeheader()
        for cid, entry in company_agg.items():
            total_resumes = sum(resume_counts.get(pid, 0) for pid in entry["person_ids"])
            writer.writerow({
                "Company ID": cid,
                "Company Name": entry["name"],
                "Total Jobs": len(entry["job_ids"]),
                "Total Resumes": total_resumes,
                "Placement Count": entry["placement_count"],
                "Total Revenue": round(entry["revenue"], 2),
            })
    print(f"Company report written to {COMPANY_CSV} (one row per company, not summed)")


def main():
    parser = argparse.ArgumentParser(description="Loxo people & placements reporting")
    parser.add_argument("--workers", type=int, default=10, help="concurrent requests for person detail calls")
    parser.add_argument("--no-resume", action="store_true", help="ignore existing partial report.csv and start over")
    parser.add_argument("--limit", type=int, default=None, help="only process this many people in report.csv (e.g. for a quick test run)")
    parser.add_argument("--people-only", action="store_true", help="only write report.csv, skip company_report.csv")
    parser.add_argument("--company-only", action="store_true", help="only write company_report.csv, skip report.csv")
    args = parser.parse_args()

    token = load_token()
    session = make_session(token)

    t0 = time.time()
    revenue_by_person, company_agg = build_placement_aggregates(session)

    if not args.company_only:
        run_report(session, workers=args.workers, resume=not args.no_resume,
                   revenue_by_person=revenue_by_person, limit=args.limit)
    if not args.people_only:
        run_company_report(session, workers=args.workers, company_agg=company_agg)
    print(f"Done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
