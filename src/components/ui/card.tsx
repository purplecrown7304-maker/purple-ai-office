import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section data-slot="card" className={cn("card", className)} {...props} />
  );
}
export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("card-header", className)} {...props} />;
}
