import { readFileSync } from "fs";
import path from "path";

// Port of loxo_report.py's core logic for a single live company lookup:
// find the company, get its placements (job.company.id match), sum
// revenue, then query person_events for the candidates placed there
// (Lucene person_id:(id1 OR id2 ...)) for jobs/CVs. See loxo_report.py's
// module docstring for the full flow and why revenue is attributed via
// placements rather than /companies/{id}/people.

const AGENCY_SLUG = "Lignum-group";
const BASE_URL = `https://app.loxo.co/api/${AGENCY_SLUG}`;

// The API hard-caps Lucene queries at 26 OR conditions ("Too many \"OR\"
// conditions in query", confirmed live against /placements and
// /person_events) - 25 leaves a safety margin.
const ID_BATCH_SIZE = 25;

// The two activity_type keys that represent a CV/resume being sent, out of
// ~70 distinct activity types observed (interview stages, calls, emails,
// notes, etc. are excluded).
const CV_EVENT_KEYS = new Set(["moved_to_cv_sent", "delivery_cv_sends"]);

let cachedToken: string | null = null;

function loadToken(): string {
  if (cachedToken) return cachedToken;

  const envPath = path.join(process.cwd(), "..", ".env");
  const raw = readFileSync(envPath, "utf-8").trim();

  const candidateKeys = new Set([
    "LOXO_TOKEN",
    "LOXO_API_KEY",
    "LOXO_BEARER_TOKEN",
    "TOKEN",
    "BEARER_TOKEN",
  ]);
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim().toUpperCase();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (candidateKeys.has(key)) {
      cachedToken = value;
      return value;
    }
  }

  // Fall back to treating the whole file as a bare token (no KEY= prefix).
  const bare = raw.split("\n")[0]?.trim();
  if (!bare) throw new Error("Could not find a bearer token in .env");
  cachedToken = bare;
  return bare;
}

export class RateLimitedError extends Error {
  constructor() {
    super("Loxo API is rate-limiting requests right now - try again shortly.");
    this.name = "RateLimitedError";
  }
}

async function loxoFetch(url: URL): Promise<Record<string, unknown>> {
  const token = loadToken();
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status === 429 || resp.status >= 500) {
      lastError = new Error(`HTTP ${resp.status}`);
      const retryAfter = Number(resp.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} for ${url.pathname}${url.search}: ${body.slice(0, 300)}`);
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  if (lastError instanceof Error && lastError.message === "HTTP 429") {
    throw new RateLimitedError();
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}

interface PaginateOptions {
  params?: Record<string, string>;
  perPage?: number;
}

async function* paginate<T = Record<string, unknown>>(
  path: string,
  options: PaginateOptions = {}
): AsyncGenerator<T> {
  const key = path.split("/").pop()!; // e.g. "companies/123/people" -> "people"
  const baseParams = { ...(options.params ?? {}) };
  if (options.perPage) baseParams.per_page = String(options.perPage);

  let requestParams = { ...baseParams };
  while (true) {
    const url = new URL(`${BASE_URL}/${path}`);
    for (const [k, v] of Object.entries(requestParams)) url.searchParams.set(k, v);

    const data = await loxoFetch(url);
    const items = (data[key] as T[]) ?? [];
    if (items.length === 0) return;
    for (const item of items) yield item;

    const scrollId = data.scroll_id as string | undefined;
    if (!scrollId) return;
    requestParams = { ...baseParams, scroll_id: scrollId };
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .split("")
    .filter((ch) => /[a-z0-9\s]/.test(ch))
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

interface Company {
  id: number;
  name: string;
  [key: string]: unknown;
}

export async function findCompany(name: string): Promise<Company | null> {
  const target = normalize(name);

  for await (const c of paginate<Company>("companies", { params: { query: name }, perPage: 100 })) {
    if (normalize(c.name) === target) return c;
  }

  // Fallback: query search found nothing exact - page through every company.
  for await (const c of paginate<Company>("companies", { perPage: 100 })) {
    if (normalize(c.name) === target) return c;
  }
  return null;
}

interface Placement {
  fee_type?: { key?: string } | null;
  fee?: string | number | null;
  salary?: string | number | null;
  bill_rate?: string | number | null;
  pay_rate?: string | number | null;
  job?: { company?: { id?: number } | null } | null;
  person?: { id?: number } | null;
  job_type?: { name?: string } | null;
}

function computeRevenue(p: Placement): number {
  const feeType = p.fee_type?.key;
  const fee = Number(p.fee ?? 0);
  const salary = Number(p.salary ?? 0);
  const billRate = Number(p.bill_rate ?? 0);
  const payRate = Number(p.pay_rate ?? 0);

  if (feeType === "percentage" && fee) return salary * (fee / 100);
  if (feeType === "flat" && fee) return fee;
  return billRate - payRate;
}

// Dropout placements are internal reversal/adjustment records (a candidate
// who fell through), not real revenue. Confirmed with a real example:
// Western Building Group placement 48128 has job_type "Dropout", fee
// -22667.43, and notes literally saying "this is just adding the actual
// dropout onto the figures ... a credit is not necessary anymore" -
// summing it double-counted against the same candidate's real placement.
function isDropout(p: Placement): boolean {
  return p.job_type?.name === "Dropout";
}

// Revenue/jobs/CVs are attributed via placements[].job.company - the
// company a candidate was PLACED AT - not via /companies/{id}/people
// (a company's own contacts/staff, an unrelated set of people). Confirmed
// with real data: KENPAT has $51,000 of real revenue from a candidate who
// isn't in KENPAT's own contact list at all - attributing by contacts
// silently produced $0 for a company that actually made $51,000.
//
// /placements has no company_id filter (only job_id is a structured filter,
// and the free-text query only fuzzy-matches company_name, not company_id
// exactly - confirmed against the Loxo OpenAPI spec), so this narrows via
// the company name search first (fast) and falls back to a full unfiltered
// scan only if that finds nothing for this company id (fuzzy search can
// miss a company entirely - same safety net loxo_report.py's predecessor
// script used).
async function placementsForCompany(companyId: number, companyName: string): Promise<Placement[]> {
  const seen = new Set<unknown>();
  const matches: Placement[] = [];
  for await (const p of paginate<Placement & { id?: unknown }>("placements", { params: { query: companyName } })) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.job?.company?.id === companyId && !isDropout(p)) matches.push(p);
  }
  if (matches.length > 0) return matches;

  for await (const p of paginate<Placement>("placements")) {
    if (p.job?.company?.id === companyId && !isDropout(p)) matches.push(p);
  }
  return matches;
}

interface PersonEvent {
  activity_type?: { key?: string } | null;
  job_id?: number | null;
}

export async function jobsAndCvsForPeople(
  personIds: number[]
): Promise<{ totalJobs: number; totalCvs: number }> {
  let cvCount = 0;
  const jobIds = new Set<number>();
  for (const batch of chunked(personIds, ID_BATCH_SIZE)) {
    const query = `person_id:(${batch.join(" OR ")})`;
    for await (const e of paginate<PersonEvent>("person_events", { params: { query }, perPage: 100 })) {
      const key = e.activity_type?.key;
      if (key && CV_EVENT_KEYS.has(key)) cvCount++;
      if (e.job_id != null) jobIds.add(e.job_id);
    }
  }
  return { totalJobs: jobIds.size, totalCvs: cvCount };
}

export interface CompanySummary {
  companyId: number;
  companyName: string;
  totalJobs: number;
  totalCvs: number;
  totalRevenue: number;
}

async function summarize(companyId: number, companyName: string): Promise<CompanySummary> {
  const placements = await placementsForCompany(companyId, companyName);
  if (placements.length === 0) {
    return { companyId, companyName, totalJobs: 0, totalCvs: 0, totalRevenue: 0 };
  }

  const revenue = placements.reduce((sum, p) => sum + computeRevenue(p), 0);
  const personIds = [...new Set(placements.map((p) => p.person?.id).filter((id): id is number => id != null))];
  const jobsAndCvs = await jobsAndCvsForPeople(personIds);

  return {
    companyId,
    companyName,
    totalJobs: jobsAndCvs.totalJobs,
    totalCvs: jobsAndCvs.totalCvs,
    totalRevenue: Math.round(revenue * 100) / 100,
  };
}

export async function lookupCompany(name: string): Promise<CompanySummary | null> {
  const company = await findCompany(name);
  if (!company) return null;
  return summarize(company.id, company.name);
}

// Faster than lookupCompany() when the id is already known (e.g. refreshing
// a row already loaded from company_report.csv) - skips the name search.
export async function lookupCompanyById(id: number, knownName: string): Promise<CompanySummary> {
  return summarize(id, knownName);
}
