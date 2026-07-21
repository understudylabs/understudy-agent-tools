"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge } from "@/app/components/base-ui/badge";
import { Button } from "@/app/components/base-ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/base-ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/base-ui/table";
import {
  formatDate,
  formatLastUsed,
  invokeErrorMessage,
  normalizeKeys,
  type KeyRow,
} from "@/app/lib/api-keys.mjs";
import { CreateKeyModal } from "./api-keys/CreateKeyModal";
import { RevokeKeyButton } from "./api-keys/RevokeKeyButton";

/**
 * API keys management pane — a faithful port of the web control plane's
 * keys surface (apps/web/app/(control-plane)/keys/page.tsx + app/keys/*).
 * The Next.js server component becomes a client-side loader over the
 * app's native gateway plumbing: `api_keys_list` / `api_keys_create` /
 * `api_keys_revoke` Tauri commands hold the sk_ credential in Rust; the
 * webview never sees it (except the one-time plaintext of a *new* key,
 * which is the product).
 */

type AccountStatus = {
  signed_in?: boolean;
  org_id?: string | null;
};

type LoadState =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "no-org" }
  | { phase: "error"; message: string }
  | { phase: "ready"; keys: KeyRow[] };

export function ApiKeysPane({ onOpenAccount }: { onOpenAccount?: () => void }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const status = await invoke<AccountStatus>("account_status");
      if (!status?.signed_in) {
        setState({ phase: "signed-out" });
        return;
      }
      if (!status.org_id) {
        setState({ phase: "no-org" });
        return;
      }
      const envelope = await invoke<unknown>("api_keys_list");
      setState({ phase: "ready", keys: normalizeKeys(envelope) });
    } catch (err) {
      setState({
        phase: "error",
        message: invokeErrorMessage(err, "Could not load keys."),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">API keys</h1>
        <p className="pane-sub">
          Understudy sk_* keys authenticate gateway traffic and the agent
          CLI. The plaintext value is shown once at creation.
        </p>
      </div>
      <div className="pane-body">
        <div className="grid gap-4">
          {state.phase === "loading" ? (
            <Notice label="loading">Loading keys…</Notice>
          ) : state.phase === "signed-out" ? (
            <Notice label="access">
              <span>
                Sign in to manage gateway keys.
                {onOpenAccount ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-3"
                    onClick={onOpenAccount}
                  >
                    Sign in
                  </Button>
                ) : null}
              </span>
            </Notice>
          ) : state.phase === "no-org" ? (
            <Notice label="attention">
              Your credentials do not name exactly one organization — the
              app cannot pick one. Re-run <code>understudy login</code> for
              the org you want to manage.
            </Notice>
          ) : state.phase === "error" ? (
            <Notice label="attention">
              <span>
                {state.message}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-3"
                  onClick={refresh}
                >
                  Retry
                </Button>
              </span>
            </Notice>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>API keys</CardTitle>
                <CardDescription>
                  Use one key per environment so revocation and usage
                  attribution stay clean.
                </CardDescription>
                <CardAction>
                  <Badge
                    variant="outline"
                    className="uppercase tracking-[0.14em]"
                  >
                    {state.keys.length} active
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <KeysSection keys={state.keys} onRefresh={refresh} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Where a key goes</CardTitle>
              <CardDescription>
                The same key works on every Understudy surface.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm leading-6 text-muted-foreground sm:grid-cols-3">
              <UsageHint
                title="Proxy traffic"
                detail="Send it as the bearer token (or x-api-key) on api.understudylabs.com — a drop-in for the Anthropic and OpenAI endpoints."
              />
              <UsageHint
                title="Catalog models"
                detail="Request any managed model by id with just this key — see the Models page for the call shape."
              />
              <UsageHint
                title="Agent CLI"
                detail="Set UNDERSTUDY_API_KEY so workload capture, evals, and routing changes run against your org."
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * The modal lives at this level (not inside the empty-state / list
 * children) so it stays mounted across the empty→list transition that
 * fires on first key creation. Without this stable mount point, the
 * plaintext value flashes on screen for a tick and then disappears
 * before the user can copy it. (Verbatim rationale from the web port.)
 */
function KeysSection({
  keys,
  onRefresh,
}: {
  keys: KeyRow[];
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const openModal = () => setOpen(true);

  return (
    <>
      <CreateKeyModal open={open} onOpenChange={setOpen} onDone={onRefresh} />
      {keys.length === 0 ? (
        <KeysEmptyState onCreate={openModal} />
      ) : (
        <KeysList keys={keys} onCreate={openModal} onRefresh={onRefresh} />
      )}
    </>
  );
}

function KeysEmptyState({ onCreate }: { onCreate: () => void }): ReactNode {
  return (
    <div className="grid gap-5 rounded-md border border-dashed bg-muted/20 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <p className="font-medium leading-snug">No active keys.</p>
        <p className="mt-2 max-w-[34rem] text-sm leading-6 text-muted-foreground">
          Create one Understudy key per environment. The plaintext key is
          revealed once, then only the key id remains visible here.
        </p>
      </div>
      <div className="sm:justify-self-end">
        <Button variant="outline" size="lg" onClick={onCreate}>
          New key
        </Button>
      </div>
    </div>
  );
}

function KeysList({
  keys,
  onCreate,
  onRefresh,
}: {
  keys: KeyRow[];
  onCreate: () => void;
  onRefresh: () => void;
}): ReactNode {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 rounded-md border bg-muted/20 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="font-medium leading-snug">
            {keys.length} active {keys.length === 1 ? "key" : "keys"}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Use one key per environment. Last-used updates when the gateway
            validates the key on live traffic.
          </p>
        </div>
        <div className="sm:justify-self-end">
          <Button variant="outline" size="lg" onClick={onCreate}>
            New key
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4 text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">
                secret / id
              </TableHead>
              <TableHead className="px-4 text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">
                name
              </TableHead>
              <TableHead className="px-4 text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">
                created
              </TableHead>
              <TableHead className="px-4 text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">
                last used
              </TableHead>
              <TableHead className="px-4 text-right text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">
                action
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="min-w-[13rem] px-4">
                  <code className="block truncate font-mono text-sm text-foreground">
                    {k.obfuscated_value}
                  </code>
                  {/*
                    Surfaced for operators routing a key in D1: `pnpm route
                    set-route <id> <deployment>` takes the public api_key
                    id, not the secret value. This pane is the canonical
                    place to look it up.
                  */}
                  <code className="mt-1 block select-all break-all font-mono text-xs leading-5 text-muted-foreground">
                    {k.id}
                  </code>
                </TableCell>
                <TableCell className="min-w-[8rem] px-4 text-muted-foreground">
                  {k.name || "untitled"}
                </TableCell>
                <TableCell className="px-4 text-xs text-muted-foreground">
                  {formatDate(k.created_at)}
                </TableCell>
                <TableCell className="px-4 text-xs text-muted-foreground">
                  {formatLastUsed(k.last_used_at)}
                </TableCell>
                <TableCell className="px-4 text-right">
                  <RevokeKeyButton
                    keyId={k.id}
                    prefix={k.obfuscated_value}
                    onRevoked={onRefresh}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function UsageHint({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): ReactNode {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-[0.68rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </p>
      <p className="mt-2 text-xs leading-5">{detail}</p>
    </div>
  );
}

/** Port of the web control plane's Notice label+body row. */
function Notice({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-muted/20 p-4 text-sm leading-6">
      <span className="mt-[0.15rem] shrink-0 text-[0.62rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-foreground">{children}</div>
    </div>
  );
}
