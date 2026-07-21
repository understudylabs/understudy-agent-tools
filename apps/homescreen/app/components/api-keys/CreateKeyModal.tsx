"use client";

import { useState, useTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/app/components/base-ui/button";
import { Checkbox } from "@/app/components/base-ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/base-ui/dialog";
import { Input } from "@/app/components/base-ui/input";
import { Label } from "@/app/components/base-ui/label";
import {
  invokeErrorMessage,
  type CreateKeyResult,
} from "@/app/lib/api-keys.mjs";

/**
 * Controlled create-key modal, ported from the web control plane
 * (apps/web/app/keys/CreateKeyModal.tsx). `open` lives in the parent
 * (ApiKeysPane's KeysSection) so that switching between empty-state and
 * list-state does not unmount the modal mid-reveal — which would destroy
 * the one-time plaintext value the user is trying to copy.
 *
 * Two visual states:
 *   - "form": user picks a name (optional) and submits.
 *   - "revealed": the new key's plaintext value is shown once with a copy
 *     button. Closing triggers `onDone()` so the pane re-runs the list
 *     load and the new key appears (without its plaintext value — the
 *     gateway never returns it again).
 *
 * The "save it now" warning is load-bearing. Outside-click, Escape, and
 * the X close button are all suppressed once the plaintext is on screen;
 * the user must check the acknowledgement box and click Done.
 *
 * Web-only baggage dropped in the port: the Next.js Server Action plumbing
 * and its NEXT_REDIRECT rethrow workaround (redirect-error.ts) — Tauri
 * `invoke` rejections are plain errors, nothing to re-throw.
 */
export function CreateKeyModal({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after any close — the pane refreshes its key list. */
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreateKeyResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const resetAndClose = () => {
    setName("");
    setCreated(null);
    setAcknowledged(false);
    setError(null);
    onOpenChange(false);
    onDone();
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const trimmed = name.trim();
        const result = await invoke<CreateKeyResult>("api_keys_create", {
          name: trimmed === "" ? null : trimmed,
        });
        if (result && typeof result.value === "string") {
          setCreated(result);
        } else {
          setError("The gateway did not return a key value.");
        }
      } catch (err) {
        setError(invokeErrorMessage(err, "Failed to create key."));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block any close attempt once the plaintext key is on screen —
        // the user must explicitly acknowledge they've saved it.
        if (!next && created) return;
        if (!next) {
          resetAndClose();
        } else {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent
        showCloseButton={!created}
        onPointerDownOutside={(e) => {
          if (created) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (created) e.preventDefault();
        }}
        className="sm:max-w-md"
      >
        {created ? (
          <RevealedView
            created={created}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
            onClose={resetAndClose}
          />
        ) : (
          <FormView
            name={name}
            onNameChange={setName}
            onSubmit={submit}
            onCancel={resetAndClose}
            isPending={isPending}
            error={error}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FormView({
  name,
  onNameChange,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  name: string;
  onNameChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
}) {
  const presets = ["production", "staging", "development"];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-5"
    >
      <DialogHeader>
        <DialogTitle>Create key</DialogTitle>
        <DialogDescription>
          Name the environment or workload this key will serve.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="key-name">Name (optional)</Label>
        <Input
          id="key-name"
          type="text"
          name="name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={120}
          placeholder="production"
          autoFocus
          disabled={isPending}
        />
        <div className="flex flex-wrap gap-2 pt-1">
          {presets.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onNameChange(preset)}
              disabled={isPending}
            >
              {preset}
            </Button>
          ))}
        </div>
      </div>
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
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RevealedView({
  created,
  acknowledged,
  onAcknowledge,
  onClose,
}: {
  created: CreateKeyResult;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Non-fatal; user can copy by hand.
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Save your key</DialogTitle>
        <DialogDescription>
          The plaintext value disappears after this modal closes.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm leading-relaxed text-foreground">
        This is the only time you&apos;ll see this key. Save it now — we
        don&apos;t store the plaintext, and there&apos;s no way to retrieve
        it later.
      </p>
      <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
        <code className="break-all font-mono text-sm text-foreground">
          {created.value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          className="self-start"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex items-start gap-3 text-sm text-foreground">
        <Checkbox
          id="key-saved-ack"
          checked={acknowledged}
          onCheckedChange={(value) => onAcknowledge(value === true)}
          className="mt-[0.2rem]"
        />
        <Label htmlFor="key-saved-ack" className="font-normal leading-5">
          I&apos;ve saved this key somewhere safe.
        </Label>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={!acknowledged}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
