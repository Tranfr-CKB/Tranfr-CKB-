import { LogEntry } from "../types";
import { shortHex, txUrl } from "../chain";

const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type LedgerType = "heartbeat" | "deadline" | "claim" | "create";

/** Same classification the prototype uses to colour ledger badges. */
function ledgerType(message: string): LedgerType {
  const event = message.toLowerCase();
  if (event.includes("heartbeat") || event.includes("renew") || event.includes("liveness")) return "heartbeat";
  if (event.includes("deadline")) return "deadline";
  if (event.includes("claim")) return "claim";
  return "create";
}

export function ActivityLedger({ entries }: { entries: LogEntry[] }) {
  return (
    <section className="transaction-log" aria-labelledby="activity-ledger-title">
      <h2 id="activity-ledger-title">Activity ledger</h2>
      <div className="transaction-log-entries">
        {entries.length === 0 ? (
          <p className="ledger-empty">Transactions you send from this page appear here.</p>
        ) : (
          entries.map((entry) => {
            const type = ledgerType(entry.message);
            return (
              <article className={`ledger-entry ledger-${type}`} key={entry.id}>
                <div className="ledger-entry-meta">
                  <time>{timeFormat.format(entry.time)}</time>
                  <span className="ledger-badge">{type.toUpperCase()}</span>
                </div>
                <p>
                  {entry.message}{" "}
                  {entry.txHash && (
                    <a href={txUrl(entry.txHash)} target="_blank" rel="noreferrer">
                      {shortHex(entry.txHash)}
                    </a>
                  )}
                </p>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
