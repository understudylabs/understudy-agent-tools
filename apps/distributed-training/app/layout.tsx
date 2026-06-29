import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Understudy Distributed Training",
  description: "Temporary rollout bounty board for distributed inference and RL data collection.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
