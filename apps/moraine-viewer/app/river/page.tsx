import type { Metadata } from "next";
import RiverClient from "@/components/river/RiverClient";

export const metadata: Metadata = {
  title: "river — moraine",
  description: "History river: harness event flow over time",
};

export default function RiverPage() {
  return <RiverClient />;
}
