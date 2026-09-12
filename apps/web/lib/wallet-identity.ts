"use client";
/**
 * One TEE session per tab, shared by every panel that needs it.
 *
 * The guided path and the licensing flow both show a wallet picker; signing the
 * TEE challenge in either one has to count for both, so the identity lives in a
 * module store rather than in each component's state. The token is a bearer
 * credential for reads: it stays in memory, never in storage, and is dropped
 * when the wallet changes.
 */
import { useSyncExternalStore } from "react";
import type { Identity } from "../components/studio/use-owner";

let current: Identity | null = null;
const subs = new Set<() => void>();

export function setSharedIdentity(next: Identity | null): void {
  if (next === current) return;
  current = next;
  for (const cb of subs) cb();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

const snapshot = () => current;
const serverSnapshot = () => null;

/** `[identity, setIdentity]`, shared across every component in the tab. */
export function useSharedIdentity(): [Identity | null, (next: Identity | null) => void] {
  return [useSyncExternalStore(subscribe, snapshot, serverSnapshot), setSharedIdentity];
}

/** The connected wallet's address, or null. */
export function identityOwner(id: Identity | null): string | null {
  return id?.kind === "wallet" ? id.owner : null;
}

/** The wallet's TEE auth token, or null when it has not signed in yet. */
export function identityToken(id: Identity | null): string | null {
  return id?.kind === "wallet" ? id.token : null;
}
