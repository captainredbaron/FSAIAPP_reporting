import type { Metadata, Viewport } from "next";
import { BuildStamp } from "@/components/brand/build-stamp";
import "./globals.css";

export const metadata: Metadata = {
  title: "GWR Reporting Portal",
  description: "Desktop reporting portal for AI-assisted food safety inspections",
  applicationName: "GWR Reporting Portal"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f4fae"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <div className="flex-1">{children}</div>
        <footer className="border-t border-border/70 bg-background/95 px-4 py-2">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-end">
            <BuildStamp />
          </div>
        </footer>
      </body>
    </html>
  );
}
