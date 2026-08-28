#!/usr/bin/env python3
"""
Look up a company by name, resolve its Loxo company id, filter /placements
to only that company's placements, sum revenue across all of them, and
print the number.

Uses each endpoint's ?query= fuzzy search to narrow the candidate set
server-side first (fast), then filters exactly by company id in code:
    /companies?query=<name>   -> resolve company id
    /placements?query=<name>  -> narrowed placement candidates, filtered
                                  down to job.company.id == that id

The query param must be re-sent on every paginated request - the scroll_id
alone does NOT preserve the filter (confirmed: dropping it resets the
result set back to everything). The fuzzy search also has minor duplicate
noise across pages, so results are deduped by placement id.

If the narrowed placements search turns up zero matches for the resolved
company (fuzzy search can miss things), falls back to scanning every
placement unfiltered - a safety net so revenue is never silently
under-reported, just slower.

Usage:
    python3 company_lookup.py "Western Building Group LLC"
    python3 company_lookup.py "Western Building Group LLC" --company 3844088   # skip search, test a known id
"""
import argparse
import sys
import urllib.parse

import requests

from loxo_report import BASE_URL, load_token, make_session, paginate, compute_revenue, fetch_resume_counts


def normalize(name):
    return "".join(ch for ch in name.lower() if ch.isalnum() or ch.isspace()).split()


def paginate_query(session, path, query_text):
    """Like loxo_report.paginate(), but re-sends ?query= on every page -
    required because the scroll_id alone doesn't preserve the filter."""
    q = urllib.parse.quote(query_text)
    url = f"{BASE_URL}/{path}?query={q}"
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
        url = f"{BASE_URL}/{path}?query={q}&scroll_id={scroll_id}"


def find_company(session, name):
    """Fast path: fuzzy /companies?query= search, kept only if a result's
    name matches exactly (ignoring case/punctuation) - the query search
    matches loosely (word-by-word), so it can return unrelated companies."""
    target = normalize(name)
    for c in paginate_query(session, "companies", name):
        if normalize(c["name"]) == target:
            return c

    # Fallback: query search found nothing exact - page through every
    # company (5000+) and compare names directly.
    print("Not an exact match via query search, falling back to a full company scan...")
    for c in paginate(session, "companies"):
        if normalize(c["name"]) == target:
            return c
    return None


def matching_placements(session, company_id, name):
    """Yields every placement for company_id: fast narrowed query search
    first, falling back to a full unfiltered scan if that finds nothing
    (fuzzy search can miss a company entirely)."""
    seen_ids = set()
    found_any = False
    for p in paginate_query(session, "placements", name):
        if p["id"] in seen_ids:
            continue
        seen_ids.add(p["id"])
        pc = (p.get("job") or {}).get("company") or {}
        if str(pc.get("id")) == company_id:
            found_any = True
            yield p

    if not found_any:
        print("Narrowed placements search found nothing for this company, "
              "falling back to a full placements scan...")
        for p in paginate(session, "placements"):
            pc = (p.get("job") or {}).get("company") or {}
            if str(pc.get("id")) == company_id:
                yield p


def summarize_company(session, workers, company, name):
    """Sums Total Revenue, distinct Total Jobs (with a placement), and
    Total CVs (summed resume count of every candidate placed there) -
    all rolled up across every placement for this one company."""
    company_id = str(company["id"])
    total_revenue = 0.0
    placement_count = 0
    job_ids = set()
    person_ids = set()
    for p in matching_placements(session, company_id, name):
        total_revenue += compute_revenue(p)
        placement_count += 1
        job = p.get("job") or {}
        person = p.get("person") or {}
        if job.get("id") is not None:
            job_ids.add(job["id"])
        if person.get("id") is not None:
            person_ids.add(str(person["id"]))

    resume_counts = fetch_resume_counts(session, workers, person_ids, label="placed candidates") if person_ids else {}
    total_cvs = sum(resume_counts.values())

    return {
        "placement_count": placement_count,
        "total_jobs": len(job_ids),
        "total_cvs": total_cvs,
        "total_revenue": round(total_revenue, 2),
    }


def main():
    parser = argparse.ArgumentParser(description="Sum placement revenue for one company")
    parser.add_argument("name", nargs="?", default=None, help="company name to search for")
    parser.add_argument("--company", type=int, default=None,
                         help="skip the name search, use this exact company id (for testing)")
    parser.add_argument("--workers", type=int, default=10, help="concurrent requests for candidate resume lookups")
    args = parser.parse_args()
    if args.company is None and not args.name:
        parser.error("name is required unless --company is given")

    token = load_token()
    session = make_session(token)

    if args.company is not None:
        try:
            resp = session.get(f"{BASE_URL}/companies/{args.company}", timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            sys.exit(f"Failed to fetch company {args.company}: {e}")
        company = resp.json()
    else:
        print(f'Searching companies for "{args.name}" (query endpoint)...')
        try:
            company = find_company(session, args.name)
        except requests.RequestException as e:
            sys.exit(f"Company search failed: {e}")
        if not company:
            sys.exit(f'No company found matching "{args.name}"')

    print(f"Company: {company['name']} (ID {company['id']})")
    summary = summarize_company(session, args.workers, company, company["name"])
    print(f"Placements found: {summary['placement_count']}")
    print(f"Total Jobs: {summary['total_jobs']}")
    print(f"Total CVs: {summary['total_cvs']}")
    print(f"Total Revenue: {summary['total_revenue']:,.2f}")


if __name__ == "__main__":
    main()
