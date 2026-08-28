"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface CompanyRow {
  companyId: string;
  companyName: string;
  totalJobs: number;
  totalCvs: number;
  totalRevenue: number;
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function perUnit(revenue: number, count: number): number | null {
  if (!count) return null;
  return revenue / count;
}

function formatPerUnit(revenue: number, count: number): string {
  const v = perUnit(revenue, count);
  return v === null ? "-" : currency.format(v);
}

const VISIBLE_WITHOUT_SEARCH = 200;
const BULK_CONCURRENCY = 3;
const BULK_CONFIRM_THRESHOLD = 100;

type SortKey = "companyName" | "totalJobs" | "totalCvs" | "totalRevenue" | "perCv" | "perJob";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "companyName", label: "Company", align: "left" },
  { key: "totalJobs", label: "Total Jobs", align: "right" },
  { key: "totalCvs", label: "Total CVs", align: "right" },
  { key: "totalRevenue", label: "Total Revenue", align: "right" },
  { key: "perCv", label: "Per CV", align: "right" },
  { key: "perJob", label: "Per Job", align: "right" },
];

function sortValue(row: CompanyRow, key: SortKey): number | string {
  switch (key) {
    case "companyName":
      return row.companyName.toLowerCase();
    case "totalJobs":
      return row.totalJobs;
    case "totalCvs":
      return row.totalCvs;
    case "totalRevenue":
      return row.totalRevenue;
    case "perCv":
      return perUnit(row.totalRevenue, row.totalCvs) ?? -Infinity;
    case "perJob":
      return perUnit(row.totalRevenue, row.totalJobs) ?? -Infinity;
  }
}

// --- Filter conditions (Total CVs > 8, Per CV not empty, etc.) ---

type FilterField = "totalJobs" | "totalCvs" | "totalRevenue" | "perCv" | "perJob";
type FilterOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "notEmpty" | "empty";

interface FilterCondition {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

const FIELD_LABELS: Record<FilterField, string> = {
  totalJobs: "Total Jobs",
  totalCvs: "Total CVs",
  totalRevenue: "Total Revenue",
  perCv: "Per CV",
  perJob: "Per Job",
};

const NUMERIC_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "eq", label: "=" },
];
const EMPTY_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "notEmpty", label: "is not empty" },
  { value: "empty", label: "is empty" },
];

function operatorsFor(field: FilterField) {
  return field === "perCv" || field === "perJob"
    ? [...NUMERIC_OPERATORS, ...EMPTY_OPERATORS]
    : NUMERIC_OPERATORS;
}

function fieldValue(row: CompanyRow, field: FilterField): number | null {
  switch (field) {
    case "totalJobs":
      return row.totalJobs;
    case "totalCvs":
      return row.totalCvs;
    case "totalRevenue":
      return row.totalRevenue;
    case "perCv":
      return perUnit(row.totalRevenue, row.totalCvs);
    case "perJob":
      return perUnit(row.totalRevenue, row.totalJobs);
  }
}

function matchesCondition(row: CompanyRow, cond: FilterCondition): boolean {
  const val = fieldValue(row, cond.field);

  if (cond.operator === "notEmpty") return val !== null;
  if (cond.operator === "empty") return val === null;

  const threshold = Number(cond.value);
  if (cond.value.trim() === "" || Number.isNaN(threshold)) return true; // incomplete filter, don't hide everything
  if (val === null) return false;

  switch (cond.operator) {
    case "gt":
      return val > threshold;
    case "gte":
      return val >= threshold;
    case "lt":
      return val < threshold;
    case "lte":
      return val <= threshold;
    case "eq":
      return val === threshold;
    default:
      return true;
  }
}

let nextFilterId = 1;
function newFilter(field: FilterField = "totalCvs", operator: FilterOperator = "gt"): FilterCondition {
  return { id: `f${nextFilterId++}`, field, operator, value: "" };
}

function summarizeFilter(f: FilterCondition): string {
  const label = FIELD_LABELS[f.field];
  if (f.operator === "notEmpty") return `${label} is not empty`;
  if (f.operator === "empty") return `${label} is empty`;
  const opLabel = NUMERIC_OPERATORS.find((o) => o.value === f.operator)?.label ?? f.operator;
  if (f.value.trim() === "") return `${label} ${opLabel} …`;
  const num = Number(f.value);
  const display =
    f.field === "totalRevenue" || f.field === "perCv" || f.field === "perJob"
      ? currency.format(num)
      : num.toLocaleString();
  return `${label} ${opLabel} ${display}`;
}

function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-neutral-400"
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function FilterSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full appearance-none rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 pl-3 pr-7 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Chevron />
    </div>
  );
}

export default function Home() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [justUpdatedId, setJustUpdatedId] = useState<string | null>(null);
  const [liveSearchLoading, setLiveSearchLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelBulkRef = useRef(false);

  const [popover, setPopover] = useState<{ mode: "new" } | { mode: "edit"; id: string } | null>(null);
  const [draft, setDraft] = useState<{ field: FilterField; operator: FilterOperator; value: string }>({
    field: "totalCvs",
    operator: "gt",
    value: "",
  });
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popover) return;
    function onPointerDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setPopover(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPopover(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popover]);

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setRows(data.rows);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load report"))
      .finally(() => setLoadingRows(false));
  }, []);

  const filteredAll = useMemo(() => {
    const q = query.trim().toLowerCase();
    let result = rows;

    if (q) {
      result = result.filter(
        (r) => r.companyName.toLowerCase().includes(q) || r.companyId.includes(q)
      );
    }
    for (const cond of filters) {
      result = result.filter((r) => matchesCondition(r, cond));
    }
    if (sortKey) {
      result = [...result].sort((a, b) => {
        const av = sortValue(a, sortKey);
        const bv = sortValue(b, sortKey);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return result;
  }, [rows, query, filters, sortKey, sortDir]);

  const visible = useMemo(() => {
    return query.trim() || filters.length > 0
      ? filteredAll
      : filteredAll.slice(0, VISIBLE_WITHOUT_SEARCH);
  }, [filteredAll, query, filters]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function openAddPopover() {
    setDraft({ field: "totalCvs", operator: "gt", value: "" });
    setPopover({ mode: "new" });
  }
  function openEditPopover(f: FilterCondition) {
    setDraft({ field: f.field, operator: f.operator, value: f.value });
    setPopover({ mode: "edit", id: f.id });
  }
  function setDraftField(field: FilterField) {
    setDraft((d) => ({
      ...d,
      field,
      operator: operatorsFor(field).some((o) => o.value === d.operator) ? d.operator : "gt",
    }));
  }
  function applyDraft() {
    if (!popover) return;
    if (popover.mode === "new") {
      setFilters((prev) => [...prev, { ...newFilter(), ...draft }]);
    } else {
      setFilters((prev) => prev.map((f) => (f.id === popover.id ? { ...f, ...draft } : f)));
    }
    setPopover(null);
  }
  function removeFilter(id: string) {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  }
  function addPreset(field: FilterField) {
    if (filters.some((f) => f.field === field && f.operator === "gt" && f.value === "0")) return;
    setFilters((prev) => [...prev, newFilter(field, "gt")].map((f) => (f.field === field && f.value === "" ? { ...f, value: "0" } : f)));
  }

  async function refreshOne(row: CompanyRow): Promise<CompanyRow | null> {
    try {
      const resp = await fetch("/api/companies/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: row.companyId, companyName: row.companyName }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`);
      return data.row as CompanyRow;
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Update failed");
      return null;
    }
  }

  async function refreshRow(row: CompanyRow) {
    setRefreshingIds((prev) => new Set(prev).add(row.companyId));
    setRefreshError(null);
    const updated = await refreshOne(row);
    if (updated) {
      setRows((prev) => prev.map((r) => (r.companyId === updated.companyId ? updated : r)));
      setJustUpdatedId(row.companyId);
      setTimeout(() => setJustUpdatedId(null), 2500);
    }
    setRefreshingIds((prev) => {
      const next = new Set(prev);
      next.delete(row.companyId);
      return next;
    });
  }

  async function updateAll() {
    const targets = filteredAll;
    if (targets.length === 0) return;
    if (targets.length > BULK_CONFIRM_THRESHOLD) {
      const ok = window.confirm(
        `This will update ${targets.length} companies live from Loxo, one by one. That can take a while and may hit rate limits. Continue?`
      );
      if (!ok) return;
    }

    cancelBulkRef.current = false;
    setRefreshError(null);
    setBulkProgress({ done: 0, total: targets.length });

    let cursor = 0;
    let done = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        if (cancelBulkRef.current) return;
        const row = targets[cursor++];
        setRefreshingIds((prev) => new Set(prev).add(row.companyId));
        const updated = await refreshOne(row);
        if (updated) {
          setRows((prev) => prev.map((r) => (r.companyId === updated.companyId ? updated : r)));
        }
        setRefreshingIds((prev) => {
          const next = new Set(prev);
          next.delete(row.companyId);
          return next;
        });
        done++;
        setBulkProgress({ done, total: targets.length });
      }
    };

    await Promise.all(Array.from({ length: BULK_CONCURRENCY }, () => worker()));
    setBulkProgress(null);
  }

  function cancelBulk() {
    cancelBulkRef.current = true;
  }

  async function searchLive() {
    const name = query.trim();
    if (!name) return;
    setLiveSearchLoading(true);
    setRefreshError(null);
    try {
      const resp = await fetch("/api/companies/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: name }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`);

      setRows((prev) => [data.row, ...prev.filter((r) => r.companyId !== data.row.companyId)]);
      setQuery(data.row.companyName);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Live search failed");
    } finally {
      setLiveSearchLoading(false);
    }
  }

  const bulkRunning = bulkProgress !== null;

  return (
    <main className="flex-1 flex flex-col items-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-5xl flex flex-col gap-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Loxo Company Report</h1>
          <p className="text-sm text-neutral-500">
            Values loaded from company_report.csv. Update a row, or update everything currently filtered.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by company name or ID..."
            className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-500"
          />

          <div className="flex flex-wrap items-center gap-2">
            {filters.map((f) => (
              <div
                key={f.id}
                className="flex items-center rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 pl-3 pr-1 py-1 text-xs"
              >
                <button onClick={() => openEditPopover(f)} className="hover:underline">
                  {summarizeFilter(f)}
                </button>
                <button
                  onClick={() => removeFilter(f.id)}
                  aria-label="Remove filter"
                  className="ml-1 rounded-full w-5 h-5 flex items-center justify-center text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  ×
                </button>
              </div>
            ))}

            <div className="relative">
              <button
                onClick={() => (popover ? setPopover(null) : openAddPopover())}
                className="flex items-center gap-1 rounded-full border border-dashed border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                + Filter
              </button>

              {popover && (
                <div
                  ref={popoverRef}
                  className="absolute left-0 top-full mt-2 z-20 w-64 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xl p-3 flex flex-col gap-2"
                >
                  <FilterSelect
                    value={draft.field}
                    onChange={setDraftField}
                    options={(Object.keys(FIELD_LABELS) as FilterField[]).map((key) => ({
                      value: key,
                      label: FIELD_LABELS[key],
                    }))}
                  />
                  <FilterSelect
                    value={draft.operator}
                    onChange={(operator) => setDraft((d) => ({ ...d, operator }))}
                    options={operatorsFor(draft.field)}
                  />
                  {draft.operator !== "notEmpty" && draft.operator !== "empty" && (
                    <input
                      type="number"
                      autoFocus
                      value={draft.value}
                      onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && applyDraft()}
                      placeholder="Value"
                      className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-500"
                    />
                  )}
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      onClick={() => setPopover(null)}
                      className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 px-2 py-1.5"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={applyDraft}
                      className="rounded-md bg-neutral-900 dark:bg-neutral-100 text-neutral-50 dark:text-neutral-900 px-3 py-1.5 text-xs font-medium"
                    >
                      {popover.mode === "edit" ? "Save" : "Add filter"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="ml-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" />

            <span className="text-xs text-neutral-400">Quick:</span>
            {(["totalJobs", "totalCvs", "totalRevenue"] as FilterField[]).map((f) => (
              <button
                key={f}
                onClick={() => addPreset(f)}
                className="rounded-full border border-neutral-200 dark:border-neutral-800 px-2.5 py-1 text-xs text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 whitespace-nowrap"
              >
                Has {FIELD_LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {filteredAll.length.toLocaleString()} matching compan{filteredAll.length === 1 ? "y" : "ies"}
          </div>
          <div className="flex items-center gap-2">
            {bulkRunning ? (
              <>
                <span className="text-xs text-neutral-500 tabular-nums">
                  Updating {bulkProgress!.done}/{bulkProgress!.total}...
                </span>
                <button
                  onClick={cancelBulk}
                  className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={updateAll}
                disabled={filteredAll.length === 0}
                className="rounded-md bg-neutral-900 dark:bg-neutral-100 text-neutral-50 dark:text-neutral-900 px-3 py-1.5 text-xs font-medium disabled:opacity-40 whitespace-nowrap"
              >
                Update All ({filteredAll.length.toLocaleString()})
              </button>
            )}
          </div>
        </div>

        {loadingRows && <div className="text-sm text-neutral-500">Loading report...</div>}
        {loadError && (
          <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm px-4 py-3">
            {loadError}
          </div>
        )}
        {refreshError && (
          <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm px-4 py-3">
            {refreshError}
          </div>
        )}

        {!loadingRows && !loadError && (
          <>
            {query.trim() && visible.length === 0 && (
              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-3 flex items-center justify-between text-sm">
                <span className="text-neutral-500">
                  No match in the report for &quot;{query.trim()}&quot;.
                </span>
                <button
                  onClick={searchLive}
                  disabled={liveSearchLoading}
                  className="rounded-md bg-neutral-900 dark:bg-neutral-100 text-neutral-50 dark:text-neutral-900 px-3 py-1.5 text-xs font-medium disabled:opacity-40 whitespace-nowrap"
                >
                  {liveSearchLoading ? "Searching..." : "Search live"}
                </button>
              </div>
            )}

            {visible.length > 0 && (
              <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 dark:border-neutral-800 text-left text-xs text-neutral-500">
                      {COLUMNS.map((col) => (
                        <th
                          key={col.key}
                          onClick={() => toggleSort(col.key)}
                          className={`px-4 py-2.5 font-medium cursor-pointer select-none hover:text-neutral-800 dark:hover:text-neutral-200 ${col.align === "right" ? "text-right" : "text-left"}`}
                        >
                          {col.label}
                          {sortKey === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                      <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr
                        key={row.companyId}
                        className="border-b border-neutral-100 dark:border-neutral-900 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{row.companyName}</div>
                          <div className="text-xs text-neutral-400">ID {row.companyId}</div>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{row.totalJobs.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{row.totalCvs.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{currency.format(row.totalRevenue)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500">
                          {formatPerUnit(row.totalRevenue, row.totalCvs)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500">
                          {formatPerUnit(row.totalRevenue, row.totalJobs)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => refreshRow(row)}
                            disabled={refreshingIds.has(row.companyId)}
                            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 whitespace-nowrap"
                          >
                            {refreshingIds.has(row.companyId)
                              ? "Updating..."
                              : justUpdatedId === row.companyId
                              ? "Updated ✓"
                              : "Update"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!query.trim() && filters.length === 0 && rows.length > VISIBLE_WITHOUT_SEARCH && (
              <div className="text-xs text-neutral-400 text-center">
                Showing first {VISIBLE_WITHOUT_SEARCH} of {rows.length.toLocaleString()} companies - search or filter to narrow down.
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
