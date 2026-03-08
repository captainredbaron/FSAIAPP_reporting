import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/");
  }

  const buildCode =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
    process.env.NEXT_PUBLIC_APP_BUILD_CODE ??
    "local";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-3 p-4">
      <LoginForm />
      <p className="text-center text-[11px] text-muted-foreground">Build: {buildCode}</p>
    </main>
  );
}
