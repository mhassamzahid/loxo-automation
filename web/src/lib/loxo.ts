import { readFileSync } from "fs";
import path from "path";

// Port of loxo_report.py's core logic (companies -> people -> placements /
// person_events, scoped per company via Lucene person_id:(id1 OR id2 ...)
// queries) for a single live company lookup. See loxo_report.py for the
// full documented flow and why each design choice was made.

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

export async function fetchCompanyPeople(companyId: number): Promise<number[]> {
  const ids: number[] = [];
  for await (const person of paginate<{ id?: number }>(`companies/${companyId}/people`)) {
    if (person.id != null) ids.push(person.id);
  }
  return ids;
}

interface Placement {
  fee_type?: { key?: string } | null;
  fee?: string | number | null;
  salary?: string | number | null;
  bill_rate?: string | number | null;
  pay_rate?: string | number | null;
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

export async function revenueForPeople(personIds: number[]): Promise<number> {
  let total = 0;
  for (const batch of chunked(personIds, ID_BATCH_SIZE)) {
    const query = `person_id:(${batch.join(" OR ")})`;
    for await (const p of paginate<Placement>("placements", { params: { query } })) {
      total += computeRevenue(p);
    }
  }
  return total;
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
  const personIds = await fetchCompanyPeople(companyId);
  if (personIds.length === 0) {
    return { companyId, companyName, totalJobs: 0, totalCvs: 0, totalRevenue: 0 };
  }

  const [revenue, jobsAndCvs] = await Promise.all([
    revenueForPeople(personIds),
    jobsAndCvsForPeople(personIds),
  ]);

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
