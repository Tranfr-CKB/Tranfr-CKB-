import { useCallback, useEffect, useMemo, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import {
  ChainClock,
  KeyIdentity,
  errorMessage,
  formatDuration,
  identityOf,
  readChainClock,
} from "./chain";
import { loadStored, saveStored } from "./storage";
import { resolveHostAccount, walletModeEnabled } from "./host";
import { LogEntry, TrackedCell, cellKey } from "./types";
import { CreateScreen } from "./components/CreateScreen";
import { PolicyDashboard } from "./components/PolicyDashboard";

const CLOCK_REFRESH_MS = 30_000;

function useIdentity(privateKey: ccc.Hex | undefined): KeyIdentity | undefined {
  const [identity, setIdentity] = useState<KeyIdentity>();
  useEffect(() => {
    let cancelled = false;
    setIdentity(undefined);
    if (privateKey) identityOf(privateKey).then((id) => !cancelled && setIdentity(id));
    return () => {
      cancelled = true;
    };
  }, [privateKey]);
  return identity;
}

export function App() {
  // Wallet mode: the host wallet is already signed in, so the demo skips its
  // own key and connect steps and that account owns and funds the policy.
  const walletMode = useMemo(walletModeEnabled, []);
  const host = useMemo(() => (walletMode ? resolveHostAccount() : undefined), [walletMode]);
  const hostIdentity = useIdentity(host?.privateKey);

  const [ownerKey, setOwnerKey] = useState<ccc.Hex | undefined>(() => loadStored("ownerKey", undefined));
  const [recipientKey, setRecipientKey] = useState<ccc.Hex | undefined>(() => loadStored("recipientKey", undefined));
  const [cells, setCells] = useState<TrackedCell[]>(() => loadStored("cells", []));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const standaloneOwner = useIdentity(ownerKey);
  const standaloneRecipient = useIdentity(recipientKey);
  // In wallet mode both roles resolve against the signed-in account: it owns
  // the policies it creates, and it can claim any policy naming it recipient.
  const owner = walletMode ? hostIdentity : standaloneOwner;
  const recipient = walletMode ? hostIdentity : standaloneRecipient;

  const [clock, setClock] = useState<ChainClock>();
  const [clockError, setClockError] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [log, setLog] = useState<LogEntry[]>([]);

  useEffect(() => saveStored("ownerKey", ownerKey), [ownerKey]);
  useEffect(() => saveStored("recipientKey", recipientKey), [recipientKey]);
  useEffect(() => saveStored("cells", cells), [cells]);

  const refresh = useCallback(() => {
    readChainClock()
      .then((next) => {
        setClock(next);
        setClockError(undefined);
      })
      .catch((err) => setClockError(errorMessage(err)));
    setRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, CLOCK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const addLog = useCallback((message: string, txHash?: string) => {
    setLog((entries) => [{ id: Date.now() + Math.random(), time: new Date(), message, txHash }, ...entries].slice(0, 30));
  }, []);

  function track(cell: TrackedCell) {
    setCells((current) =>
      current.some((c) => c.txHash === cell.txHash && c.index === cell.index) ? current : [cell, ...current],
    );
  }

  function untrack(cell: TrackedCell) {
    setCells((current) => current.filter((c) => !(c.txHash === cell.txHash && c.index === cell.index)));
    setSelectedKey((current) => (current === cellKey(cell) ? null : current));
  }

  function replace(oldCell: TrackedCell, newCell: TrackedCell) {
    setCells((current) =>
      current.map((c) => (c.txHash === oldCell.txHash && c.index === oldCell.index ? newCell : c)),
    );
    setSelectedKey((current) => (current === cellKey(oldCell) ? cellKey(newCell) : current));
  }

  const selected = cells.find((cell) => cellKey(cell) === selectedKey);
  const chainLine = clock ? (
    <>
      Tip epoch {clock.tipEpoch.toFixed(3)} · 1 epoch ≈ {formatDuration(clock.msPerEpoch)}
      {clock.nominal ? " (nominal; live sample unavailable)" : " (live, last 2000 blocks)"}
    </>
  ) : clockError ? (
    <span className="error">Couldn&rsquo;t read the chain: {clockError}</span>
  ) : (
    "Reading chain…"
  );

  if (!selected) {
    return (
      <CreateScreen
        ownerKey={ownerKey}
        recipientKey={recipientKey}
        owner={owner}
        recipient={recipient}
        onOwnerKey={setOwnerKey}
        onRecipientKey={setRecipientKey}
        cells={cells}
        walletMode={walletMode}
        host={host}
        hostIdentity={hostIdentity}
        live={!!clock}
        chainLine={chainLine}
        onTrack={(cell) => {
          track(cell);
          setSelectedKey(cellKey(cell));
        }}
        onUntrack={untrack}
        onOpen={(cell) => setSelectedKey(cellKey(cell))}
        onCreated={(txHash, durationEpochs) => {
          const cell: TrackedCell = { txHash, index: 0, durationEpochs };
          track(cell);
          setSelectedKey(cellKey(cell));
        }}
        onLog={addLog}
      />
    );
  }

  return (
    <PolicyDashboard
      key={cellKey(selected)}
      cell={selected}
      cells={cells}
      owner={owner}
      recipient={recipient}
      clock={clock}
      now={now}
      refreshToken={refreshToken}
      entries={log}
      walletMode={walletMode}
      live={!!clock}
      onSelect={(cell) => setSelectedKey(cellKey(cell))}
      onBack={() => setSelectedKey(null)}
      onLog={addLog}
      onRenewed={(txHash, durationEpochs) => replace(selected, { txHash, index: 0, durationEpochs })}
      onSpent={() => untrack(selected)}
      onRemove={() => untrack(selected)}
    />
  );
}
