"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton({ children }: { children?: React.ReactNode }) {
  const router = useRouter();

  const onLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <Button type="button" variant="outline" size="icon" onClick={onLogout}>
      {children ?? "Logout"}
      <span className="sr-only">Logout</span>
    </Button>
  );
}
