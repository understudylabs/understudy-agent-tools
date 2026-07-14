"use client";

import {
  CircleCheckIcon,
  DownloadIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";

export type OperationNoticeState = "idle" | "running" | "success" | "error";
export type OperationNoticeIcon = "repair" | "download";

type OperationNoticeProgress = {
  value: number | null;
  max: number;
  label: string;
};

type OperationNoticeProps = {
  state: OperationNoticeState;
  icon: OperationNoticeIcon;
  title: string;
  message: string;
  meta?: string | null;
  progress?: OperationNoticeProgress | null;
  actionLabel?: string | null;
  actionDisabled?: boolean;
  onAction?: () => void;
  dismissLabel: string;
  dismissDisabled?: boolean;
  onDismiss: () => void;
  className?: string;
};

export function OperationNotice({
  state,
  icon,
  title,
  message,
  meta,
  progress,
  actionLabel,
  actionDisabled = false,
  onAction,
  dismissLabel,
  dismissDisabled = false,
  onDismiss,
  className,
}: OperationNoticeProps) {
  const iconClass = `operation-notice-icon${state === "running" ? " is-spinning" : ""}`;
  const statusIcon =
    state === "running" ? (
      <LoaderCircleIcon className={iconClass} size={17} aria-hidden="true" />
    ) : state === "success" ? (
      <CircleCheckIcon className={iconClass} size={17} aria-hidden="true" />
    ) : state === "error" ? (
      <TriangleAlertIcon className={iconClass} size={17} aria-hidden="true" />
    ) : icon === "download" ? (
      <DownloadIcon className={iconClass} size={17} aria-hidden="true" />
    ) : (
      <WrenchIcon className={iconClass} size={17} aria-hidden="true" />
    );

  return (
    <aside
      className={`operation-notice is-${state}${className ? ` ${className}` : ""}`}
      aria-live="polite"
      aria-label={title}
      aria-busy={state === "running"}
    >
      {statusIcon}
      <div className="operation-notice-copy">
        <strong>{title}</strong>
        <span title={message}>{message}</span>
        {progress ? (
          <div className="operation-notice-progress">
            <progress
              max={Math.max(1, progress.max)}
              {...(progress.value === null ? {} : { value: Math.max(0, progress.value) })}
              aria-label={progress.label}
            />
            <code>{meta || progress.label}</code>
          </div>
        ) : meta ? (
          <code>{meta}</code>
        ) : null}
      </div>
      <div className="operation-notice-actions">
        {actionLabel && onAction ? (
          <button
            type="button"
            className="operation-notice-action"
            disabled={actionDisabled}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="operation-notice-dismiss"
          aria-label={dismissLabel}
          title={dismissLabel}
          disabled={dismissDisabled}
          onClick={onDismiss}
        >
          <XIcon size={14} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
