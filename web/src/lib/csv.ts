import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import Papa from "papaparse";

// Reads/writes the same output/company_report.csv that loxo_report.py
// produces - column names must stay identical to what Python's
// csv.DictWriter writes (COMPANY_FIELDS in loxo_report.py), since the
// Python script's own resume/checkpoint logic reads this file back by
// those exact header names.

const CSV_PATH = path.join(process.cwd(), "..", "output", "company_report.csv");

export interface CompanyRow {
  companyId: string;
  companyName: string;
  totalJobs: number;
  totalCvs: number;
  totalRevenue: number;
}

interface RawRow {
  "Company ID": string;
  "Company Name": string;
  "Total Jobs": string;
  "Total CVs": string;
  "Total Revenue": string;
}

function toRow(raw: RawRow): CompanyRow {
  return {
    companyId: raw["Company ID"],
    companyName: raw["Company Name"],
    totalJobs: Number(raw["Total Jobs"]) || 0,
    totalCvs: Number(raw["Total CVs"]) || 0,
    totalRevenue: Number(raw["Total Revenue"]) || 0,
  };
}

function toRaw(row: CompanyRow): RawRow {
  return {
    "Company ID": row.companyId,
    "Company Name": row.companyName,
    "Total Jobs": String(row.totalJobs),
    "Total CVs": String(row.totalCvs),
    "Total Revenue": String(row.totalRevenue),
  };
}

export function readCompanyRows(): CompanyRow[] {
  if (!existsSync(CSV_PATH)) return [];
  const text = readFileSync(CSV_PATH, "utf-8");
  const parsed = Papa.parse<RawRow>(text, { header: true, skipEmptyLines: true });
  return parsed.data.map(toRow);
}

// Note: loxo_report.py may still be running and appending to this same
// file. This reads fresh right before writing to keep the race window as
// small as possible, but a full lock isn't implemented - if the Python
// job appends a row in between, this read-modify-write could drop it.
// Fine for the current single-user/local-dev use case.
export function upsertCompanyRow(row: CompanyRow): CompanyRow[] {
  const rows = readCompanyRows();
  const idx = rows.findIndex((r) => r.companyId === row.companyId);
  if (idx >= 0) rows[idx] = row;
  else rows.unshift(row);

  const csv = Papa.unparse(rows.map(toRaw), { columns: ["Company ID", "Company Name", "Total Jobs", "Total CVs", "Total Revenue"] });
  writeFileSync(CSV_PATH, csv + "\n", "utf-8");
  return rows;
}
