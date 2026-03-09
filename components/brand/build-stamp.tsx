interface BuildStampProps {
  className?: string;
}

export function BuildStamp({ className }: BuildStampProps) {
  const buildCode =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
    process.env.NEXT_PUBLIC_APP_BUILD_CODE ??
    "local";

  return (
    <p className={className ?? "text-[11px] text-muted-foreground"}>Build: {buildCode}</p>
  );
}
