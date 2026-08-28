import { NextRequest, NextResponse } from "next/server";
import { lookupCompany, RateLimitedError } from "@/lib/loxo";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!name) {
    return NextResponse.json({ error: "Missing ?name= query param" }, { status: 400 });
  }

  try {
    const summary = await lookupCompany(name);
    if (!summary) {
      return NextResponse.json({ error: `No company found matching "${name}"` }, { status: 404 });
    }
    return NextResponse.json(summary);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    console.error(err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
