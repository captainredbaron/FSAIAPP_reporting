import { redirect } from "next/navigation";
import { BuildStamp } from "@/components/brand/build-stamp";
import { LoginForm } from "@/components/auth/login-form";
import { GwrLogo } from "@/components/brand/gwr-logo";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-4">
      <div className="mx-auto">
        <GwrLogo href="/login" priority imageClassName="w-[240px]" />
      </div>
      <LoginForm />
      <div className="text-center">
        <BuildStamp className="text-[11px] text-muted-foreground" />
      </div>
    </main>
  );
}
