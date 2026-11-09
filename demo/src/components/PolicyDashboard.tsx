import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { DEFAULT_DURATION_EPOCHS, TranfrStatus } from "../../../sdk/src/index.js";
import {
  ChainClock,
  KeyIdentity,
  client,
  epochToNumber,
  errorMessage,
  estimateEpochTimeMs,
  formatCkb,
  formatEpoch,
  scriptFromAddress,
  shortHex,
  sinceToEpoch,
  tranfr,
  txUrl,
} from "../chain";
import { LogEntry, TrackedCell, cellKey } from "../types";
import { ActivityLedger } from "./ActivityLedger";
import { BrandLockup } from "./BrandLockup";

interface PolicyDashboardProps {
  cell: TrackedCell;
  cells: TrackedCell[];
  owner?: KeyIdentity;
  recipient?: KeyIdentity;
  clock?: ChainClock;
  now: number;
  refreshToken: number;
  entries: LogEntry[];
  /** Embedded in a wallet: both roles resolve against the signed-in account. */
  walletMode: boolean;
  live: boolean;
  onSelect: (cell: TrackedCell) => void;
  onBack: () => void;
  onLog: (message: string, txHash?: string) => void;
  onRenewed: (txHash: ccc.Hex, durationEpochs?: number) => void;
  onSpent: () => void;
  onRemove: () => void;
}

/** Splits a millisecond countdown into the prototype's DAYS / HRS / MIN / SEC cells. */
function countdownCells(ms: number | undefined): [string, string][] {
  const total = ms === undefined ? 0 : Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    [pad(Math.floor(total / 86_400)), "DAYS"],
    [pad(Math.floor((total % 86_400) / 3600)), "HRS"],
    [pad(Math.floor((total % 3600) / 60)), "MIN"],
    [pad(total % 60), "SEC"],
  ];
}

export function PolicyDashboard(props: PolicyDashboardProps) {
  const { cell, cells, owner, recipient, clock, now, refreshToken, entries, walletMode, live } = props;
  const [status, setStatus] = useState<TranfrStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [viewingAs, setViewingAs] = useState<"owner" | "recipient">("owner");
  const [advanced, setAdvanced] = useState(false);
  const [renewEpochs, setRenewEpochs] = useState("");
  const [allowEarlier, setAllowEarlier] = useState(false);
  const [newRecipient, setNewRecipient] = useState("");
  const [reclaimTo, setReclaimTo] = useState("");
  const [claimTo, setClaimTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    tranfr
      .getTranfrStatus({ txHash: cell.txHash, index: cell.index })
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setLoadError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(undefined);
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [cell.txHash, cell.index, refreshToken]);

  // Open the dashboard in the role the loaded keys can actually act in.
  useEffect(() => {
    if (!status) return;
    const isOwner = owner?.lockHash === status.ownerLockHash;
    const isRecipient = recipient?.lockHash === status.recipientLockHash;
    setViewingAs(!isOwner && isRecipient ? "recipient" : "owner");
  }, [status?.ownerLockHash, status?.recipientLockHash, owner?.lockHash, recipient?.lockHash]);

  async function run(label: string, build: () => Promise<ccc.Transaction>, after: (txHash: ccc.Hex) => void) {
    setBusy(label);
    setActionError(undefined);
    try {
      const tx = await build();
      const txHash = await client.sendTransaction(tx);
      props.onLog(`${label} submitted, waiting for it to be committed…`, txHash);
      await client.waitTransaction(txHash, 0, 180_000);
      props.onLog(`${label} committed.`, txHash);
      after(txHash);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  }

  const outPointLabel = `${shortHex(cell.txHash)}:${cell.index}`;

  const topbar = (badge: string, deadlineStyle: boolean) => (
    <header className="dashboard-topbar">
      <BrandLockup live={live} titleId="dashboard-title" />
      <div className="topbar-actions">
        {cells.length > 1 && (
          <select
            className="policy-switch"
            aria-label="Tracked policy"
            value={cellKey(cell)}
            onChange={(event) => {
              const next = cells.find((candidate) => cellKey(candidate) === event.target.value);
              if (next) props.onSelect(next);
            }}
          >
            {cells.map((candidate) => (
              <option key={cellKey(candidate)} value={cellKey(candidate)}>
                {shortHex(candidate.txHash, 6)}:{candidate.index}
              </option>
            ))}
          </select>
        )}
        <span className={`active-badge${deadlineStyle ? " deadline-badge" : ""}`}>{badge}</span>
        <button type="button" className="reset-button" onClick={props.onBack}>
          Reset
        </button>
      </div>
    </header>
  );

  if (!status) {
    return (
      <main className="dashboard-shell">
        <section className="dashboard-card" aria-labelledby="dashboard-title">
          {topbar("LOADING", false)}
          <div className="dashboard-content">
            <section className="dashboard-main" aria-label="Policy status">
              <p className="mono">{outPointLabel}</p>
              {loadError ? <p className="error">{loadError}</p> : <p className="hint">Loading status…</p>}
              <div className="dashboard-actions-stacked owner-followup-actions">
                <button type="button" className="outline-action" onClick={props.onRemove}>
                  Stop tracking
                </button>
              </div>
            </section>
            <aside className="activity-panel" aria-label="Policy details and activity ledger">
              <ActivityLedger entries={entries} />
            </aside>
          </div>
        </section>
      </main>
    );
  }

  const deadlineEpoch = sinceToEpoch(status.deadlineSince);
  const currentEpoch = sinceToEpoch(status.currentEpochSince);
  const isOwner = owner?.lockHash === status.ownerLockHash;
  const isRecipient = recipient?.lockHash === status.recipientLockHash;
  const claimable = status.isClaimable;
  const deadlineMs = clock ? estimateEpochTimeMs(clock, epochToNumber(deadlineEpoch)) : undefined;
  const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - now;

  // The window the progress bar fills: the period this cell was created or
  // renewed with, falling back to the default when the cell was only tracked.
  const windowEpochs = cell.durationEpochs ?? Number(DEFAULT_DURATION_EPOCHS);
  const remainingEpochs = Number(status.epochsRemaining);
  const elapsedPct = claimable
    ? 100
    : Math.max(0, Math.min(100, ((windowEpochs - remainingEpochs) / windowEpochs) * 100));

  const badge = claimable ? "DEADLINE PASSED" : "ACTIVE";
  const renewValid = renewEpochs.trim() === "" || (Number.isInteger(Number(renewEpochs)) && Number(renewEpochs) >= 1);

  async function renew(explicitEpochs?: string) {
    const epochs = (explicitEpochs ?? renewEpochs).trim();
    await run(
      "Renew",
      async () =>
        tranfr.renewTranfr({
          cell: status!.cell,
          ownerPrivateKey: owner!.privateKey,
          newDurationEpochs: epochs ? BigInt(Number(epochs)) : undefined,
          allowEarlierDeadline: allowEarlier,
          newRecipientLock: newRecipient.trim() ? await scriptFromAddress(newRecipient) : undefined,
        }),
      (txHash) => props.onRenewed(txHash, epochs ? Number(epochs) : cell.durationEpochs),
    );
  }

  return (
    <main className="dashboard-shell">
      <section className="dashboard-card" aria-labelledby="dashboard-title">
        {topbar(badge, claimable)}

        <div className="dashboard-content">
          <section className="dashboard-main" aria-label="Policy status">
            <nav className="lifecycle" aria-label="Policy lifecycle">
              <span className="completed-step">CREATE</span>
              <i className="lifecycle-connector" aria-hidden="true" />
              {claimable ? <span className="completed-step">ACTIVE</span> : <strong className="current-step">ACTIVE</strong>}
              <i className="lifecycle-connector" aria-hidden="true" />
              {claimable ? <strong className="current-step">DEADLINE</strong> : <span>DEADLINE</span>}
              <i className="lifecycle-connector" aria-hidden="true" />
              <span>CLAIMED</span>
            </nav>

            <div className="asset-panel">
              <p>Protected assets</p>
              <strong>
                <span className="asset-amount">{formatCkb(status.cell.cellOutput.capacity)}</span>
                <span className="asset-denomination">CKB</span>
              </strong>
              <span>Cell · time-lock + cheque-lock 🔒</span>
              {claimable ? (
                <b className="claimable-flag">Recipient can claim</b>
              ) : (
                <b>Owner exclusive control</b>
              )}
            </div>

            <p className="countdown-label">
              {claimable ? "Recovery window is open" : "Recovery window opens in"}
            </p>
            <div
              className="countdown"
              aria-label={claimable ? "Recovery window open" : "Time until the recovery window opens"}
            >
              {countdownCells(claimable ? 0 : remainingMs).map(([value, label]) => (
                <div className="countdown-cell" key={label}>
                  <strong>{deadlineMs === undefined && !claimable ? "--" : value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div
              className="progress-track"
              aria-label={`${Math.round(elapsedPct)}% of the inactivity window elapsed`}
            >
              <span style={{ width: `${elapsedPct}%` }} />
            </div>

            <div className="account-grid">
              <div className="account-card">
                <span>OWNER</span>
                <strong title={status.ownerLockHash}>{shortHex(status.ownerLockHash)}</strong>
                <p>{claimable ? "Can still spend · reclaim" : "Can spend · heartbeat · reclaim"}</p>
                {isOwner && <span className="account-tag">{walletMode ? "your account" : "your owner key"}</span>}
              </div>
              <div className="account-card">
                <span>RECOVERY RECIPIENT</span>
                <strong title={status.recipientLockHash}>{shortHex(status.recipientLockHash)}</strong>
                <p>{claimable ? "Can claim (now)" : "Blocked by time-lock"}</p>
                {isRecipient && (
                  <span className="account-tag">{walletMode ? "your account" : "your recipient key"}</span>
                )}
              </div>
            </div>

            <section
              className={`role-controls ${viewingAs === "owner" ? "owner-controls" : "recipient-controls"}`}
              aria-labelledby="role-controls-title"
            >
              <div className="role-controls-heading">
                <span className="role-controls-dot" aria-hidden="true" />
                <h2 id="role-controls-title">
                  {viewingAs === "owner" ? "Owner controls" : "Recovery recipient controls"}
                </h2>
              </div>

              {viewingAs === "owner" ? (
                <>
                  <p className="role-controls-message">
                    {!isOwner
                      ? walletMode
                        ? "This policy is owned by another account, so you can watch it but not act as owner."
                        : "The loaded owner key doesn't match this policy, so you can watch it but not act as owner."
                      : claimable
                        ? "Deadline has passed. You can still reclaim — crossing the deadline never removes your right to your own assets."
                        : "Your assets remain under your control. Send a heartbeat to reset the recovery timer."}
                  </p>
                  <button
                    type="button"
                    className="role-controls-button role-primary"
                    disabled={!isOwner || !!busy}
                    onClick={() => renew("")}
                  >
                    {busy === "Renew" ? "Sending heartbeat…" : "Send heartbeat"}
                  </button>
                  <div className="dashboard-actions-stacked owner-followup-actions">
                    <button
                      type="button"
                      className="heartbeat-button"
                      disabled={!isOwner || !!busy}
                      onClick={() =>
                        run(
                          "Reclaim",
                          async () =>
                            tranfr.buildOwnerReclaim({
                              cell: status.cell,
                              ownerPrivateKey: owner!.privateKey,
                              toLock: reclaimTo.trim() ? await scriptFromAddress(reclaimTo) : undefined,
                            }),
                          props.onSpent,
                        )
                      }
                    >
                      {busy === "Reclaim" ? "Reclaiming…" : "Reclaim assets"}
                    </button>
                    <button
                      type="button"
                      className="outline-action"
                      aria-expanded={advanced}
                      onClick={() => setAdvanced(!advanced)}
                    >
                      {advanced ? "Hide policy settings" : "Update policy"}
                    </button>
                  </div>

                  {advanced && (
                    <div className="policy-advanced">
                      <label className="field-label" htmlFor="renew-epochs">
                        New delay (epochs, optional)
                      </label>
                      <input
                        id="renew-epochs"
                        className="field-control mono"
                        type="number"
                        min={1}
                        step={1}
                        value={renewEpochs}
                        onChange={(event) => setRenewEpochs(event.target.value)}
                        placeholder={`Keep this cell's period (at least ${DEFAULT_DURATION_EPOCHS})`}
                      />

                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={allowEarlier}
                          onChange={(event) => setAllowEarlier(event.target.checked)}
                        />
                        Allow moving the deadline earlier
                      </label>

                      <label className="field-label" htmlFor="new-recipient">
                        New recipient address (optional)
                      </label>
                      <input
                        id="new-recipient"
                        className="field-control mono"
                        value={newRecipient}
                        onChange={(event) => setNewRecipient(event.target.value)}
                        placeholder="ckt1…"
                      />
                      {!walletMode && recipient && !isRecipient && (
                        <button
                          type="button"
                          className="link-action"
                          onClick={() => setNewRecipient(recipient.address)}
                        >
                          Use the loaded recipient key
                        </button>
                      )}

                      <label className="field-label" htmlFor="reclaim-to">
                        Reclaim to address (optional)
                      </label>
                      <input
                        id="reclaim-to"
                        className="field-control mono"
                        value={reclaimTo}
                        onChange={(event) => setReclaimTo(event.target.value)}
                        placeholder="Defaults to the owner key"
                      />

                      <div className="dashboard-actions-stacked owner-followup-actions">
                        <button
                          type="button"
                          className="amber-button"
                          disabled={!isOwner || !!busy || !renewValid}
                          onClick={() => renew()}
                        >
                          {busy === "Renew" ? "Renewing…" : "Renew"}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="role-controls-message">
                    {!isRecipient
                      ? walletMode
                        ? "This policy names another account as its recovery recipient; they claim from their own wallet."
                        : "The loaded recipient key doesn't match this policy, so you can watch it but not claim."
                      : claimable
                        ? "Open. You may claim now — but the owner can still reclaim first. Whoever's transaction lands first wins."
                        : "The recovery window is not open yet. You may claim after the deadline if the owner has not reclaimed."}
                  </p>
                  <button
                    type="button"
                    className="role-controls-button role-primary claim-action"
                    disabled={!isRecipient || !claimable || !!busy}
                    onClick={() =>
                      run(
                        "Claim",
                        async () =>
                          tranfr.buildRecoveryClaim({
                            cell: status.cell,
                            recipientPrivateKey: recipient!.privateKey,
                            toLock: claimTo.trim() ? await scriptFromAddress(claimTo) : undefined,
                          }),
                        props.onSpent,
                      )
                    }
                  >
                    {busy === "Claim" ? "Claiming…" : "Attempt claim"}
                  </button>
                  <label className="field-label" htmlFor="claim-to" style={{ marginTop: 12 }}>
                    Claim to address (optional)
                  </label>
                  <input
                    id="claim-to"
                    className="field-control mono"
                    value={claimTo}
                    onChange={(event) => setClaimTo(event.target.value)}
                    placeholder="Defaults to the recipient key"
                  />
                </>
              )}

              {actionError && <p className="error">{actionError}</p>}
            </section>
          </section>

          <aside className="activity-panel" aria-label="Policy details and activity ledger">
            <div className="policy-details">
              <h2>POLICY</h2>
              <p>
                Cell:{" "}
                <b className="mono">
                  <a href={txUrl(cell.txHash)} target="_blank" rel="noreferrer">
                    {outPointLabel}
                  </a>
                </b>
              </p>
              <p>
                Period: <b>{cell.durationEpochs ? `${cell.durationEpochs} epochs` : "set at creation"}</b>
              </p>
              <p>
                Deadline epoch: <b className="mono">{formatEpoch(deadlineEpoch)}</b>
              </p>
              <p>
                Current epoch: <b className="mono">{formatEpoch(currentEpoch)}</b>
              </p>
              <p>
                Epochs remaining: <b>{status.epochsRemaining.toString()}</b>
              </p>
              <div className="dashboard-actions-stacked owner-followup-actions">
                <button type="button" className="outline-action" onClick={props.onRemove}>
                  Stop tracking
                </button>
              </div>
            </div>
            <ActivityLedger entries={entries} />
          </aside>
        </div>

        <footer className="view-switch" aria-label="Choose simulator view">
          <button type="button" aria-pressed={viewingAs === "owner"} onClick={() => setViewingAs("owner")}>
            View as owner
          </button>
          <button type="button" aria-pressed={viewingAs === "recipient"} onClick={() => setViewingAs("recipient")}>
            View as recovery recipient
          </button>
        </footer>
      </section>
    </main>
  );
}
