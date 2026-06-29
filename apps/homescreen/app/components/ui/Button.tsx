"use client";
import React from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "link";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 font-medium rounded-[8px] border border-transparent " +
  "whitespace-nowrap select-none outline-none " +
  "transition-[background-color,border-color,color,opacity,transform] duration-[120ms] " +
  "ease-[cubic-bezier(.4,0,.2,1)] " +
  "focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-stamp)_45%,transparent)] " +
  "disabled:opacity-50 disabled:pointer-events-none active:translate-y-px";

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--color-stamp)] text-[var(--color-paper)] hover:brightness-110",
  secondary:
    "bg-[var(--color-card)] text-[var(--color-ink)] border-[var(--color-rule)] " +
    "hover:bg-[var(--color-hover)] hover:border-[var(--color-rule-strong)]",
  ghost:
    "bg-transparent text-[var(--color-ink-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-ink)]",
  danger:
    "bg-transparent text-[var(--color-bad)] border-[var(--color-rule)] " +
    "hover:bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)]",
  link: "bg-transparent text-[var(--color-stamp)] underline-offset-4 px-0 hover:underline",
};

const sizes: Record<Size, string> = {
  md: "h-9 px-3.5 text-[13px]",
  sm: "h-8 px-3 text-[12px]",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "secondary", size = "md", icon, loading, className, children, disabled, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className ?? ""}`}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
    />
  );
}
