import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The requested page may not exist or you may not have permission to view it.
      </p>
      <Button asChild>
        <Link href="/reporting">Back to reporting</Link>
      </Button>
    </main>
  );
}
