# Tranfr

Programmable recovery for CKB self-custody: a lock script that lets an owner
keep full control of their assets while active, and lets a designated
recovery recipient claim them if the owner goes inactive past a deadline.
No custodian, no oracle, no protocol changes.

**Status:** proof of concept, deployed on CKB testnet only. Not audited. Don't
use it with real funds.

---

## The problem

A CKB cell's spending conditions answer to its lock. With an ordinary
single-key lock, if that key is lost or its holder becomes unavailable, the
funds are unreachable for good: the cell stays valid on chain, but nobody can
satisfy its lock. The existing options each trade something away:

- **Multisig**: needs several parties for every normal operation
- **Custodians**: add a trusted intermediary
- **Manual inheritance**: relies on off-chain coordination
- **Application-specific recovery**: isn't reusable elsewhere
- **A plain single-key lock**: has no fallback at all

Tranfr adds a recovery path using CKB's cell model and its `since` timelock,
without any of those tradeoffs.

## How it works

A Tranfr cell is locked by one small lock script whose args name an
**owner**, a **recipient**, and a **deadline** (an absolute epoch). The lock
has two independent ways to unlock:

| Path | Who signs | When it's valid |
|---|---|---|
| **Owner** | Owner key | Always, with no time check at all |
| **Recipient** | Recipient key | Only once the chain has reached the deadline |

Everything else is built from these two paths:

- **Renew** (the "heartbeat"): the owner spends the cell and recreates it
  with a later deadline, optionally naming a new recipient. There's no
  separate renewal mechanism; it's just an owner spend. By default the SDK
  renews for the cell's own period (at least 90 days), so a heartbeat never
  silently shortens a longer period.
- **Reclaim**: the owner spends the cell anywhere, at any time, including a
  typed cell (capacity and tokens together).
- **Claim**: once the deadline has passed, the recipient spends the cell. For a
  plain CKB cell they take everything; for a **typed** cell (a UDT, say) they
  keep the tokens while the cell's CKB capacity returns to the owner, so leaving
  someone only tokens doesn't also give away the backing CKB.

The recipient's transaction must declare a `since` value at or past the
deadline. CKB consensus won't include a transaction in a block until the
chain reaches every input's `since`, so the recipient can't claim early,
however the transaction is signed.

### Why the owner path has no time limit

Earlier versions of this design tried to stop the owner from acting after
the deadline. Community review (thanks, Tianji) showed that this can't be
enforced simply. CKB's `since` only expresses a lower bound ("not before X"),
so an owner transaction signed before the deadline but broadcast after it
couldn't be reliably rejected. Closing that gap needed a multi-step
`BEGIN_OWNER_OP` / `PENDING_OWNER_OP` state machine with header dependencies.

v1 removes the requirement instead. The owner can always act, so there's no
"before the deadline" condition to race against. The recipient path needs
only a lower bound, which `since` enforces against the real chain at
inclusion time. The trade-off is deliberate: after the deadline, owner and
recipient can both spend, and whoever's transaction lands first wins. An
active owner always keeps control; recovery is for owners who stop acting.

Full rules: [`docs/spec.md`](docs/spec.md). Reasoning, trust assumptions and
limits: [`docs/security-model.md`](docs/security-model.md).

## Important limitations

- **The testnet deployment is upgradeable.** It uses Type ID, so whoever
  holds the deployer key can replace the script for every Tranfr cell. This
  must not carry over to a mainnet deployment.
- **Owner and recipient must be standard CKB secp256k1 keys** (default-lock
  addresses). The lock can't verify JoyID, MetaMask/Omnilock, multisig or
  other signers, so a connected CCC wallet can fund a Tranfr cell but can't
  act as its owner or recipient. The SDK refuses other lock types.
- **It doesn't protect against a stolen owner key.** The owner path is
  unconditional, so a thief with the owner key has full control. Tranfr
  covers inactivity and key loss, not theft.
- **Single recipient only.** No social or threshold recovery.
- **Epoch-based deadlines.** An epoch is roughly 4 hours and drifts with
  difficulty; 540 epochs measured at about 90 days. Wall-clock estimates are
  approximate.
- **No off-chain notification.** Nothing reminds the owner to renew.
- **The SDK only creates plain CKB cells.** It keeps a typed cell's type
  script and data when spending: owner spends move the whole cell as one unit,
  and a recipient claim returns the capacity to the owner while handing the
  recipient the tokens. It doesn't split a UDT balance or merge cells.
- **Not audited.**

## Testnet deployment

| Field | Value |
|---|---|
| Network | CKB Testnet (Pudge) |
| `code_hash` | `0x258d2a85b854c9a1ae9824a2c60aa88e32a95d81a9386f734275629918dd757a` |
| `hash_type` | `type` (Type ID) |
| Cell dep | [`0xd0e66d4f3c401a949b8baa1f15fd11fcbdb5625542b58ff20b40bfdaac7969a6`](https://pudge.explorer.nervos.org/transaction/0xd0e66d4f3c401a949b8baa1f15fd11fcbdb5625542b58ff20b40bfdaac7969a6) index `0`, `dep_type = code` |
| Binary data hash | `0xf580ce5698d42198a615c4f582e4d24fd39fbb1109460980a070babe750b0a59` |

This is the lock binary **with** the typed-cell capacity-refund rule
(`docs/spec.md` §5.1). The earlier pre-refund deployment is kept as superseded in
[`docs/deployment.md`](docs/deployment.md). The lifecycle was re-run against this
deployment, covering a full plain lifecycle and a UDT cell whose recipient claim
refunds the 200 CKB capacity to the owner and hands the 1,000,000 tokens to the
recipient — see [`docs/testnet-evidence.md`](docs/testnet-evidence.md).

Build and deploy steps for reproducing these hashes are in
[`docs/deployment.md`](docs/deployment.md). The build hash has so far been
produced on one machine only; an independent rebuild hasn't been done yet.

## Repository structure

```
contracts/tranfr-lock/   Lock script (Rust, ckb-std): args/witness parsing, both unlock paths
tests/                   ckb-testtool integration and adversarial tests for the lock
reference/               Rust since-comparison (used by the lock) and golden vectors
sdk/                     TypeScript SDK on CCC (incl. the TS since-comparison); builds to sdk/dist
demo/                    Testnet web UI (React + Vite) on top of the SDK
scripts/                 Testnet deployment script
docs/                    Spec, security model, deployment record, epoch-length data, plan
```

## Using it

Requirements: Rust with the `riscv64imac-unknown-none-elf` target and clang
≥ 14 (for building the contract), and Node.js 18+.

```bash
npm install

npm run test:contract    # 56 Rust tests: lock unit + integration (incl. the Time Lock + Cheque composition eval), since-comparison
npm run test:sdk         # 47 SDK tests, incl. the TypeScript since-comparison
npm run build            # SDK -> sdk/dist (JS + .d.ts); the package entry points
npm run typecheck

npm run build:contract   # build/release/tranfr-lock
```

The SDK package (`tranfr`, built to `sdk/dist`) exposes `TranfrClient`:

```ts
import { TranfrClient } from "tranfr";

const tranfr = new TranfrClient(); // CKB testnet by default

// Create: returns an unfunded transaction; fund, sign and send it with any CCC signer.
const tx = await tranfr.createTranfr({ ownerLock, recipientLock, capacity, durationEpochs: 540n });
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer);
await signer.sendTransaction(tx);

// Status, renew, reclaim, claim. The spends come back signed; the fee is paid from the cell.
const status = await tranfr.getTranfrStatus(outPoint);
const renew = await tranfr.renewTranfr({ cell: status.cell, ownerPrivateKey });
const reclaim = await tranfr.buildOwnerReclaim({ cell: status.cell, ownerPrivateKey });
const claim = await tranfr.buildRecoveryClaim({ cell: status.cell, recipientPrivateKey }); // throws before the deadline
await tranfr.client.sendTransaction(claim);
```

Demo:

```bash
cd demo && npm install && npm run dev
```

The demo stores the owner and recipient test keys unencrypted in the
browser, so use testnet keys only.

## Test coverage

- **Lock script:** the owner path succeeds before, at and after the deadline,
  with any `since`, and even with a malformed deadline. The recipient path
  succeeds exactly at the deadline and is rejected one step before it. Ratio
  edge cases are covered (equal ratios with different denominators, 16-bit
  maximum denominators, epoch 0, the maximum epoch). The recipient path
  rejects degenerate `(0, 0)` fractions, relative or other-metric `since`,
  early inputs hidden in a multi-input group, mode-byte swaps, wrong signers,
  tampered and malformed signatures and witnesses, and signature replay.
  For typed cells it checks the recipient-path capacity refund: a claim with no
  refund or an underpaid one fails, a full refund passes, a plain claim is
  unaffected, and a mixed typed/plain group only needs the typed part refunded.
  All tests use real secp256k1 signatures under `ckb-testtool`.
- **Composition evaluation:** a `ckb-testtool` suite
  (`tests/src/composition.rs`) that runs the real deployed Time Lock and Cheque
  (RFC 0039) testnet binaries, vendored under `contracts/deployed/`. It confirms
  the vendored binaries' data hashes, exercises both role assignments, and
  asserts why the composition can't implement Tranfr for plain CKB: the
  recipient claim and the swapped-role owner reclaim are each rejected with
  Cheque error 8 (`SenderCapacityNotSame`), and the owner is locked out for 6
  epochs (error 11). See [`docs/composition-evaluation.md`](docs/composition-evaluation.md).
- **Shared comparison:** one test suite run against both the Rust and
  TypeScript ports, plus byte-for-byte golden vectors for the args and
  witness encodings.
- **SDK:** eligibility boundaries, status decoding, deadline arithmetic,
  signer-key recovery from every produced signature, minimum-capacity and
  lock-type guards, type-script preservation, and the typed-cell claim that
  refunds the capacity to the owner and funds the recipient's token cell.

**On testnet:** the full lifecycle (create, extend, owner reclaim before and
after the deadline, a recipient claim refused early by the node itself, and a
recipient claim after the deadline paid to the recipient) was run with
SDK-built transactions. Every transaction hash is in
[`docs/testnet-evidence.md`](docs/testnet-evidence.md). That original run
predates the typed-cell refund rule and covers plain CKB cells only. The lock
has since been redeployed with the refund rule and re-run against that
deployment, covering both a plain lifecycle and a UDT cell; those hashes are in
the "Refund-rule re-run" section of the evidence doc.

The demo UI was also clicked through on testnet with Playwright
(`demo/e2e/`): keys generated in the UI, a wallet connected through the CCC
connector, then create, renew, reclaim and claim, with screenshots.

**Not yet verified:** a real wallet (JoyID, MetaMask) behind the connector (the
Playwright run used an injected EIP-6963 test wallet), an independent rebuild
of the deployed binary, and an external audit.

## Roadmap

| Status | Item |
|---|---|
| Done | Lock script, adversarial test suite, testnet deployment |
| Done | TypeScript SDK and testnet demo |
| Done | Specification and security model |
| Done | Full lifecycle on testnet with SDK-built transactions ([evidence](docs/testnet-evidence.md)) |
| Done | Demo UI click-through on testnet (Playwright, EIP-6963 test wallet) |
| Next | Try the demo with a real wallet (JoyID, MetaMask) |
| Before mainnet | Immutable deployment (`data1`, or a locked Type ID cell), independent build reproduction, external audit |
| Future | Multi-recipient/threshold recovery; support for other signer types |

## References

- [CKB RFC 0017: Transaction valid since](https://github.com/nervosnetwork/rfcs), the `since` encoding and epoch-with-fraction semantics
- [`nervosnetwork/ckb-system-scripts`](https://github.com/nervosnetwork/ckb-system-scripts): `secp256k1_blake160_sighash_all.c` and `check_since`, which the signature and `since` logic port
- [`ckb-devrel/ccc`](https://github.com/ckb-devrel/ccc): the SDK foundation and wallet connector
- [`nervosnetwork/ckb-script-templates`](https://github.com/nervosnetwork/ckb-script-templates): contract scaffold

## License

[ISC](LICENSE).

## Acknowledgements

Thanks to community reviewer Tianji for identifying the commit-bound expiry
race in the earlier design, which led to v1's unconditional owner path.
