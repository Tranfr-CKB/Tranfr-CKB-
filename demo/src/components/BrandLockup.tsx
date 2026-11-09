interface BrandLockupProps {
  /** Green when the chain clock is readable, grey when it isn't. */
  live?: boolean;
  titleId?: string;
}

/** The prototype's topbar brand: status dot plus the Tranfr wordmark. */
export function BrandLockup({ live = true, titleId }: BrandLockupProps) {
  return (
    <div className="brand-lockup">
      <span className={live ? "status-dot" : "status-dot offline"} aria-hidden="true" />
      <h1 id={titleId}>
        <img className="brand-logo" src="/tranfr-logo.png" alt="Tranfr" />
      </h1>
    </div>
  );
}
