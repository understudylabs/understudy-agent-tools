"use client";

import { Badge } from "@/app/components/base-ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/base-ui/collapsible";
import { cn } from "@/app/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "group not-prose mb-3 w-full overflow-hidden rounded-md border border-white/8 bg-white/[0.025]",
      className
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3.5 text-yellow-500" />,
  "approval-responded": <CheckCircleIcon className="size-3.5 text-blue-500" />,
  "input-available": <ClockIcon className="size-3.5 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-3.5" />,
  "output-available": <CheckCircleIcon className="size-3.5 text-green-500" />,
  "output-denied": <XCircleIcon className="size-3.5 text-orange-500" />,
  "output-error": <XCircleIcon className="size-3.5 text-red-500" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge
    className="gap-1.5 rounded-full border-white/6 bg-white/6 px-2 text-[10px] text-white/58"
    variant="secondary"
  >
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon className="size-3.5 shrink-0 text-white/42" />
        <span className="truncate font-mono text-[11px] font-medium text-white/70">
          {title ?? derivedName}
        </span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-3.5 shrink-0 text-white/36 transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("space-y-3 border-t border-white/6 px-3 py-3", className)}
    {...props}
  />
);

const JsonBlock = ({ value }: { value: unknown }) => (
  <pre className="max-h-44 overflow-auto rounded-md bg-black/18 p-3 font-mono text-[11px] leading-relaxed text-white/54">
    {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
  </pre>
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/34">
      Parameters
    </h4>
    <JsonBlock value={input} />
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: ToolPart["output"];
  errorText?: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) return null;

  let Output = <div>{output as ReactNode}</div>;
  if (typeof output === "object" && !isValidElement(output)) {
    Output = <JsonBlock value={output} />;
  } else if (typeof output === "string") {
    Output = <JsonBlock value={output} />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/34">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn("text-xs", errorText ? "text-red-300" : "text-white/62")}
      >
        {errorText ? (
          <div className="rounded-md bg-red-500/8 p-3">{errorText}</div>
        ) : (
          Output
        )}
      </div>
    </div>
  );
};
