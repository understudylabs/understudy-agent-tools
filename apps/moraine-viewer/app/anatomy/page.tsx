import type { Metadata } from "next";
import AnatomyClient from "@/components/anatomy/AnatomyClient";

export const metadata: Metadata = {
  title: "Trace anatomy · Moraine",
  description: "One session dissected as a WebGL flow",
};

export default function AnatomyPage() {
  return <AnatomyClient />;
}
