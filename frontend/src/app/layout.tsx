import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Binance BTC Monitor | Real-Time Dashboard",
  description:
    "Real-time Bitcoin price monitoring dashboard powered by C++ backend services",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
