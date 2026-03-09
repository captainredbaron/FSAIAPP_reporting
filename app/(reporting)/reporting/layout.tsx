import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, ClipboardList, LogOut } from "lucide-react";
import { LogoutButton } from "@/components/auth/logout-button";
import { GwrLogo } from "@/components/brand/gwr-logo";
import { Button } from "@/components/ui/button";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const reportingNav = [
  {
    href: "/reporting",
    label: "Dashboard",
    icon: BarChart3
  },
  {
    href: "/reporting/inspections",
    label: "Explorer",
    icon: ClipboardList
  }
];

export default async function ReportingLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border/80 bg-card/70 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-4">
            <GwrLogo priority />
            <div className="hidden text-xs text-muted-foreground md:block">
              Reporting Portal
            </div>
          </div>
          <LogoutButton>
            <LogOut className="h-4 w-4" />
          </LogoutButton>
        </div>
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-6 pb-4">
          {reportingNav.map((item) => {
            const Icon = item.icon;
            return (
              <Button key={item.href} variant="outline" size="sm" asChild>
                <Link href={item.href} className="gap-1.5">
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </Button>
            );
          })}
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}
