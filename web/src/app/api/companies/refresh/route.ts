import { NextRequest, NextResponse } from "next/server";
import { lookupCompanyById, findCompany, RateLimitedError } from "@/lib/loxo";
import { upsertCompanyRow, CompanyRow } from "@/lib/csv";

export const runtime = "nodejs";

interface RefreshBody {
  companyId?: string;
  companyName?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as RefreshBody;
  const companyId = body.companyId?.trim();
  const companyName = body.companyName?.trim();

  if (!companyId && !companyName) {
    return NextResponse.json({ error: "Provide companyId or companyName" }, { status: 400 });
  }

  try {
    const summary = companyId
      ? await lookupCompanyById(Number(companyId), companyName ?? "")
      : await (async () => {
          const company = await findCompany(companyName!);
          if (!company) return null;
          return lookupCompanyById(company.id, company.name);
        })();

    if (!summary) {
      return NextResponse.json({ error: `No company found matching "${companyName}"` }, { status: 404 });
    }

    const row: CompanyRow = {
      companyId: String(summary.companyId),
      companyName: summary.companyName,
      totalJobs: summary.totalJobs,
      totalCvs: summary.totalCvs,
      totalRevenue: summary.totalRevenue,
    };
    upsertCompanyRow(row);

    return NextResponse.json({ row });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    console.error(err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
