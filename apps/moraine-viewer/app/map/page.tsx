import type { Metadata } from "next";
import MapView from "@/components/map/MapView";

export const metadata: Metadata = {
  title: "Map — Moraine Viewer",
  description: "Every session as a point. Placeholder projection until embeddings land.",
};

export default function MapPage() {
  return <MapView />;
}
