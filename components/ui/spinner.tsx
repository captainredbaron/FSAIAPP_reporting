import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary",
        className
      )}
      aria-hidden
    />
  );
}
