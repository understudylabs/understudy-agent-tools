import TranscriptClient from "@/components/session/TranscriptClient";

// Full lossless transcript view for one session.
// Next 16: params/searchParams are Promises.
export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const raw = typeof sp.event === "string" ? Number(sp.event) : NaN;
  const initialEvent = Number.isFinite(raw) && raw >= 0 ? raw : null;
  return <TranscriptClient id={id} initialEvent={initialEvent} />;
}
