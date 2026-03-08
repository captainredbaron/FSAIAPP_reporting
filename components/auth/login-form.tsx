"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

function normalizeErrorMessage(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
    return "Request failed. Please check your input and try again.";
  }
  return "Request failed. Please try again.";
}

export function LoginForm() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const onLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.replace("/");
    router.refresh();
  };

  const onSignup = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const data = (await response.json()) as { error?: unknown; message?: string };

    if (!response.ok) {
      setError(normalizeErrorMessage(data.error));
      setLoading(false);
      return;
    }

    setSuccess(data.message ?? "Account created. Please log in.");
    setLoading(false);
  };

  return (
    <Card className="w-full shadow-card">
      <CardHeader>
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>
          Sign in to access the reporting dashboard and inspections explorer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onLogin} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {success ? <p className="text-sm text-emerald-700">{success}</p> : null}

          <div className="space-y-2">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={onSignup}
            >
              {loading ? "Processing..." : "Create account"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            By using this app, you acknowledge results are AI-assisted preliminary findings and
            require human review.
          </p>
          <p className="text-center text-xs text-muted-foreground">
            Need help? <Link href="mailto:support@example.com" className="underline">Contact support</Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
