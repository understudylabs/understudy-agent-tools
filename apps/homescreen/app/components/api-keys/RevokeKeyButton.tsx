"use client";

import { useState, useTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/app/components/base-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/app/components/base-ui/dialog";
import { invokeErrorMessage } from "@/app/lib/api-keys.mjs";

/**
 * Revoke flow — confirm dialog followed by a native gateway call. Ported
 * from apps/web/app/keys/RevokeKeyButton.tsx (Server Action → Tauri
 * invoke; router.refresh() → onRevoked callback). `prefix` is the
 * obfuscated key value (`sk_•••••••live`); we render it in the confirm
 * prompt so the user can see *which* key they're about to lose.
 */
export function RevokeKeyButton({
  keyId,
  prefix,
  onRevoked,
}: {
  keyId: string;
  prefix: string;
  /** Called after a successful revoke — the pane refreshes its key list. */
  onRevoked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const revoke = () => {
    setError(null);
    startTransition(async () => {
      try {
        await invoke("api_keys_revoke", { keyId });
        setOpen(false);
        onRevoked();
      } catch (err) {
        setError(invokeErrorMessage(err, "Failed to revoke key."));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow dismiss-while-pending — the request is in flight
        // and silently swallowing it would leave the UI in a stale state.
        if (!next && isPending) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          Revoke
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke key</DialogTitle>
          <DialogDescription>
            Clients using this secret will fail immediately.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-foreground">
          Revoke key{" "}
          <code className="font-mono text-sm text-destructive">{prefix}</code>?
          This cannot be undone — any client using this key will start
          failing immediately.
        </p>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              // Mirror onOpenChange's cleanup explicitly. Radix only
              // fires onOpenChange for user-driven dismisses (overlay
              // click, ESC, X button) — programmatic setOpen(false)
              // bypasses it, leaving error state stale on reopen.
              setError(null);
              setOpen(false);
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={revoke}
            disabled={isPending}
          >
            {isPending ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
