import type { Metadata } from "next";
import TimelineClient from "@/components/timeline/TimelineClient";

export const metadata: Metadata = {
  title: "Timeline — Moraine Viewer",
  description: "Your entire agent history as a temporal field of traces.",
};

export default function TimelinePage() {
  return <TimelineClient />;
}
