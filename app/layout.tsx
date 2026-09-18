import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Churn Rescue — Customer Success",
  description:
    "Internal tool for the customer success team: spot accounts at risk of churning before their renewal.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <span className="topbar-title">Churn Rescue</span>
            <span className="topbar-sub">
              Customer success · retention risk triage
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
