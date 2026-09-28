import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input data-slot="input" className={cn("input", className)} {...props} />
  );
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn("input textarea", className)}
      {...props}
    />
  );
}
