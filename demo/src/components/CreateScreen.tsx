import { ReactNode, useEffect, useMemo, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { DEFAULT_DURATION_EPOCHS } from "../../../sdk/src/index.js";
import {
  KeyIdentity,
  client,
  errorMessage,
  formatCkb,
  scriptFromAddress,
  shortHex,
  tranfr,
} from "../chain";
import { HostAccount } from "../host";
import { TrackedCell, cellKey } from "../types";
import { BrandLockup } from "./BrandLockup";
import { KeyCard } from "./KeyCard";

// A Tranfr cell occupies 113 CKB; renewals pay their fee out of the cell, so leave headroom.
const MIN_CAPACITY_CKB = 120;

interface CreateScreenProps {
  ownerKey?: ccc.Hex;
  recipientKey?: ccc.Hex;
  owner?: KeyIdentity;
  recipient?: KeyIdentity;
  onOwnerKey: (key: ccc.Hex | undefined) => void;
  onRecipientKey: (key: ccc.Hex | undefined) => void;
  cells: TrackedCell[];
  /** Embedded in a wallet: the user is already signed in (see host.ts). */
  walletMode: boolean;
  host?: HostAccount;
  hostIdentity?: KeyIdentity;
  live: boolean;
  chainLine: ReactNode;
  onTrack: (cell: TrackedCell) => void;
  onUntrack: (cell: TrackedCell) => void;
  onOpen: (cell: TrackedCell) => void;
  onCreated: (txHash: ccc.Hex, durationEpochs: number) => void;
  onLog: (message: string, txHash?: string) => void;
}

/**
 * The prototype's "Create recovery policy" screen.
 *
 * In wallet mode it is the prototype's form: the signed-in account owns and
 * funds the policy, so the only inputs are the recipient, the amount to
 * protect, and the inactivity window. Standalone, it also carries the key and
 * wallet setup the demo needs to stand on its own.
 */
export function CreateScreen(props: CreateScreenProps) {
  const { ownerKey, recipientKey, owner, recipient, cells, walletMode, host, hostIdentity, live, chainLine } = props;
  const { open, disconnect, wallet } = ccc.useCcc();
  const connector = ccc.useSigner();
  const [walletAddress, setWalletAddress] = useState<string>();
  const [walletBalance, setWalletBalance] = useState<bigint>();
  const [recipientAddress, setRecipientAddress] = useState("");
  const [capacity, setCapacity] = useState("200");
  const [duration, setDuration] = useState(DEFAULT_DURATION_EPOCHS.toString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [loadTxHash, setLoadTxHash] = useState("");
  const [loadIndex, setLoadIndex] = useState("0");

  // In wallet mode the signed-in account pays for the cell; standalone, a CCC
  // connector does.
  const hostSigner = useMemo(
    () => (host ? new ccc.SignerCkbPrivateKey(client, host.privateKey) : undefined),
    [host?.privateKey],
  );
  const signer = walletMode ? hostSigner : connector;

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  useEffect(() => {
    let cancelled = false;
    setWalletAddress(undefined);
    setWalletBalance(undefined);
    if (!signer) return;
    (async () => {
      const [address, balance] = await Promise.all([signer.getRecommendedAddress(), signer.getBalance()]);
      if (!cancelled) {
        setWalletAddress(address);
        setWalletBalance(balance);
      }
    })().catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [signer, busy]);

  const capacityNumber = Number(capacity);
  const durationNumber = Number(duration);
  const inputError =
    !Number.isFinite(capacityNumber) || capacityNumber < MIN_CAPACITY_CKB
      ? `Amount must be at least ${MIN_CAPACITY_CKB} CKB.`
      : !Number.isInteger(durationNumber) || durationNumber < 1
        ? "Inactivity period must be a whole number of epochs, at least 1."
        : undefined;
  const missing = walletMode
    ? !hostIdentity
      ? "the signed-in account"
      : !recipientAddress.trim()
        ? "a recovery recipient address"
        : undefined
    : !owner
      ? "an owner key"
      : !recipient
        ? "a recipient key"
        : !connector
          ? "a connected wallet"
          : undefined;

  const loadIndexNumber = Number(loadIndex);
  const canLoad =
    /^0x[0-9a-fA-F]{64}$/.test(loadTxHash.trim()) && Number.isInteger(loadIndexNumber) && loadIndexNumber >= 0;

  async function create() {
    const ownerIdentity = walletMode ? hostIdentity : owner;
    if (!signer || !ownerIdentity || inputError || missing) return;
    setBusy(true);
    setError(undefined);
    try {
      const recipientLock = walletMode ? await scriptFromAddress(recipientAddress) : recipient!.script;
      const tx = await tranfr.createTranfr({
        ownerLock: ownerIdentity.script,
        recipientLock,
        capacity: ccc.fixedPointFrom(capacity),
        durationEpochs: BigInt(durationNumber),
      });
      await tx.completeInputsByCapacity(signer);
      await tx.completeFeeBy(signer);
      const txHash = await signer.sendTransaction(tx);
      props.onLog("Create submitted, waiting for it to be committed…", txHash);
      await client.waitTransaction(txHash, 0, 180_000);
      props.onLog("Tranfr cell created.", txHash);
      props.onCreated(txHash, durationNumber);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="policy-card" aria-labelledby="page-title">
        <div className="corner corner-top-left" aria-hidden="true" />
        <div className="corner corner-top-right" aria-hidden="true" />
        <div className="corner corner-bottom-left" aria-hidden="true" />
        <div className="corner corner-bottom-right" aria-hidden="true" />

        <header className="dashboard-topbar create-policy-topbar">
          <BrandLockup live={live} />
          <div className="topbar-actions">
            {walletMode ? (
              <span className="account-chip" title={walletAddress}>
                <span className="mono">{walletAddress ? shortHex(walletAddress, 8) : "…"}</span>
                {walletBalance !== undefined && <b>{formatCkb(walletBalance)} CKB</b>}
              </span>
            ) : (
              <span className="network-badge">CKB TESTNET</span>
            )}
            <span className="active-badge create-badge">CREATE</span>
          </div>
        </header>

        <div className="create-policy-form">
          <header className="policy-header">
            <h1 id="page-title">Create recovery policy</h1>
            <p>
              Define owner, recipient, and inactivity window. Assets stay under exclusive owner control until the
              deadline.
            </p>
          </header>

          <div className="breadcrumb" aria-hidden="true">
            <span className="breadcrumb-dot" />
            <span>Create a Tranfr</span>
          </div>

          {walletMode ? (
            host?.simulated && (
              <p className="notice">
                No wallet host detected, so the demo generated the signed-in account below and keeps its key in this
                browser. Fund it from the testnet faucet before deploying. A real host sets{" "}
                <span className="mono">window.__TRANFR_HOST__</span>.
              </p>
            )
          ) : (
            <p className="notice">
              Testnet only. Owner and recipient keys are generated and stored unencrypted in this browser&rsquo;s
              local storage. Never use a key that holds real funds.
            </p>
          )}

          <div className="chain-line">{chainLine}</div>

          {walletMode ? (
            <section className="form-section">
              <h2 className="form-section-title">Owner</h2>
              <div className="wallet-row">
                <span className="network-badge">{host?.name ?? "Wallet account"}</span>
                <span className="mono" title={walletAddress}>
                  {walletAddress ?? "…"}
                </span>
                {walletAddress && (
                  <button type="button" className="ghost-button" onClick={() => copyAddress(walletAddress)}>
                    {copyState === "copied" ? "Copied" : "Copy address"}
                  </button>
                )}
              </div>
              {walletAddress && copyState === "failed" && (
                <p className="hint">
                  Couldn&rsquo;t copy automatically. Select the address and copy it:{" "}
                  <span className="mono wrap selectable">{walletAddress}</span>
                </p>
              )}
            </section>
          ) : (
            <>
              <section className="form-section">
                <h2 className="form-section-title">Owner and recipient keys</h2>
                <div className="key-grid">
                  <KeyCard
                    title="Owner key"
                    description="Signs renewals and reclaims. Never needs funds: fees come out of the Tranfr cell."
                    privateKey={ownerKey}
                    identity={owner}
                    onChange={props.onOwnerKey}
                  />
                  <KeyCard
                    title="Recipient key"
                    description="Can claim the cell once the deadline passes. Also needs no funds."
                    privateKey={recipientKey}
                    identity={recipient}
                    onChange={props.onRecipientKey}
                  />
                </div>
              </section>

              <section className="form-section">
                <h2 className="form-section-title">Funding wallet</h2>
                <div className="wallet-row">
                  {wallet ? (
                    <>
                      <span className="network-badge">{wallet.name}</span>
                      <span className="mono" title={walletAddress}>
                        {walletAddress ? shortHex(walletAddress, 10) : "…"}
                      </span>
                      {walletAddress && (
                        <button type="button" className="ghost-button" onClick={() => copyAddress(walletAddress)}>
                          {copyState === "copied" ? "Copied" : "Copy address"}
                        </button>
                      )}
                      {walletBalance !== undefined && <span>{ccc.fixedPointToString(walletBalance)} CKB</span>}
                      <button type="button" className="ghost-button" onClick={disconnect}>
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="amber-button" onClick={open}>
                        Connect wallet
                      </button>
                      <span>
                        A CCC wallet pays for the new cell. Wallet connectors can&rsquo;t sign as Tranfr owner or
                        recipient: the lock only accepts plain secp256k1 signatures.
                      </span>
                    </>
                  )}
                </div>
                {wallet && walletAddress && copyState === "failed" && (
                  <p className="hint">
                    Couldn&rsquo;t copy automatically. Select the address and copy it:{" "}
                    <span className="mono wrap selectable">{walletAddress}</span>
                  </p>
                )}
              </section>
            </>
          )}

          <section className="form-section">
            <h2 className="form-section-title">Policy</h2>

            {walletMode && (
              <>
                <label className="field-label" htmlFor="recipient">
                  Enter recipient address
                </label>
                <input
                  id="recipient"
                  className="field-control mono"
                  value={recipientAddress}
                  onChange={(event) => setRecipientAddress(event.target.value)}
                  placeholder="ckt1…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </>
            )}

            <label className={`field-label${walletMode ? " period-label" : ""}`} htmlFor="capacity">
              {walletMode ? "Amount to protect (CKB)" : "Capacity (CKB)"}
            </label>
            <input
              id="capacity"
              className="field-control mono"
              type="number"
              min={MIN_CAPACITY_CKB}
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />

            <label className="field-label period-label" htmlFor="duration">
              Inactivity period (epochs)
            </label>
            <input
              id="duration"
              className="field-control mono"
              type="number"
              min={1}
              step={1}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
            <span className="hint">
              540 ≈ 90 days. Use 1 (≈ 4 hours) to try the recipient claim on testnet.{" "}
              <button type="button" className="link-action" onClick={() => setDuration("1")}>
                Use 1
              </button>
            </span>
          </section>

          <p className="helper-copy">
            Real Tranfr policies run on day-scale inactivity periods. Every renewal resets the deadline, so the
            recipient can only claim after the owner has genuinely stopped signing.
          </p>

          {inputError && <p className="error">{inputError}</p>}
          {missing && <p className="hint">Needs {missing} first.</p>}
          {error && <p className="error">{error}</p>}

          <button
            type="button"
            className="submit-button"
            onClick={create}
            disabled={busy || !!inputError || !!missing}
          >
            {busy ? "Deploying policy…" : "Deploy policy → ACTIVE"}
          </button>

          <section className="form-section tracked-section">
            <h2 className="form-section-title">{walletMode ? "Your policies" : "Tracked policies"}</h2>
            {cells.length === 0 ? (
              <p className="hint">No policies tracked yet. Deploy one above, or paste an existing out point.</p>
            ) : (
              <ul className="tracked-list">
                {cells.map((cell) => (
                  <li key={cellKey(cell)}>
                    <span className="mono">
                      {shortHex(cell.txHash)}:{cell.index}
                    </span>
                    <button type="button" className="amber-button" onClick={() => props.onOpen(cell)}>
                      Open
                    </button>
                    <button type="button" className="ghost-button" onClick={() => props.onUntrack(cell)}>
                      Stop tracking
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="track-existing">
              <input
                className="field-control mono track-hash"
                placeholder="Transaction hash (0x…)"
                value={loadTxHash}
                onChange={(event) => setLoadTxHash(event.target.value)}
                aria-label="Transaction hash"
              />
              <input
                className="field-control mono track-index"
                type="number"
                min={0}
                value={loadIndex}
                onChange={(event) => setLoadIndex(event.target.value)}
                aria-label="Output index"
              />
              <button
                type="button"
                className="ghost-button"
                disabled={!canLoad}
                onClick={() => {
                  props.onTrack({ txHash: loadTxHash.trim().toLowerCase(), index: loadIndexNumber });
                  setLoadTxHash("");
                }}
              >
                Track
              </button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
