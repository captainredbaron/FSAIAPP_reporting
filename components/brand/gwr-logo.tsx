import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface GwrLogoProps {
  href?: string;
  className?: string;
  imageClassName?: string;
  priority?: boolean;
}

export function GwrLogo({
  href = "/reporting",
  className,
  imageClassName,
  priority = false
}: GwrLogoProps) {
  return (
    <Link href={href} className={cn("inline-flex items-center", className)}>
      <Image
        src="/branding/gwr-logo.png"
        alt="G.W.R Consulting"
        width={260}
        height={62}
        priority={priority}
        className={cn("h-auto w-[200px] sm:w-[240px]", imageClassName)}
      />
    </Link>
  );
}
