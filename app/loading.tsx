import { Spinner } from "@/components/ui/spinner";

export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
