import { ccc } from "@ckb-ccc/connector-react";
import { generatePrivateKey, normalizePrivateKey } from "./chain";
import { loadStored, saveStored } from "./storage";

/**
 * Wallet mode — the demo embedded in a wallet, where the user is already
 * signed in.
 *
 * The create-tranfr-policy prototype starts from that state: no key setup and
 * no connect step, just recipient and inactivity period. Wallet mode renders
 * that flow. The signed-in account owns and funds the policy.
 *
 * A host wallet sets `window.__TRANFR_HOST__` before the app boots:
 *
 *     window.__TRANFR_HOST__ = { name: "Acme Wallet", privateKey: "0x…" };
 *
 * The key is required because Tranfr's lock accepts a raw secp256k1 signature
 * resolving to a standard secp256k1_blake160 lock (docs/security-model.md), and
 * the SDK's renew / reclaim / claim builders take `ownerPrivateKey` or
 * `recipientPrivateKey` directly. A host that will only sign on the user's
 * behalf — the normal case for a production wallet — needs the SDK to accept a
 * sign callback instead; that is not supported yet, and is the one SDK change
 * a real integration requires.
 */
export interface TranfrHost {
  /** Wallet name shown beside the account. */
  name?: string;
  /** The signed-in account's secp256k1 key, 32 bytes of hex. */
  privateKey: string;
}

declare global {
  interface Window {
    __TRANFR_HOST__?: TranfrHost;
  }
}

export interface HostAccount {
  name: string;
  privateKey: ccc.Hex;
  /** True when no host injected itself and the demo generated the account. */
  simulated: boolean;
}

function envFlag(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const value = env?.VITE_WALLET_MODE;
  return value === "1" || value === "true";
}

/** Wallet mode is on when a host injected itself, or `?mode=wallet`, or VITE_WALLET_MODE. */
export function walletModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__TRANFR_HOST__) return true;
  if (new URLSearchParams(window.location.search).get("mode") === "wallet") return true;
  return envFlag();
}

/**
 * The signed-in account. With no host present the demo generates one and keeps
 * it in local storage, so wallet mode can be shown standalone — fund that
 * address from the testnet faucet before deploying a policy.
 */
export function resolveHostAccount(): HostAccount {
  const injected = typeof window === "undefined" ? undefined : window.__TRANFR_HOST__;
  if (injected) {
    const privateKey = normalizePrivateKey(injected.privateKey);
    if (!privateKey) throw new Error("window.__TRANFR_HOST__.privateKey must be 32 bytes of hex");
    return { name: injected.name ?? "Wallet account", privateKey, simulated: false };
  }

  const stored = loadStored<ccc.Hex | undefined>("hostKey", undefined);
  const privateKey = stored ?? generatePrivateKey();
  if (!stored) saveStored("hostKey", privateKey);
  return { name: "Demo wallet account", privateKey, simulated: true };
}
