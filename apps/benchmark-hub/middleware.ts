import { NextResponse, type NextRequest } from "next/server";

/**
 * TEMPORARY accent preview (wave 2′): copies ?accent=stamp|cyan|mint into the
 * x-accent-preview request header so the (server) root layout can stamp
 * data-accent on <html>. Layouts cannot read searchParams; this bridge keeps
 * the override server-rendered (curl-visible). Remove with the preview.
 */
export function middleware(request: NextRequest) {
  const accent = request.nextUrl.searchParams.get("accent");
  if (!accent) return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.set("x-accent-preview", accent);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
