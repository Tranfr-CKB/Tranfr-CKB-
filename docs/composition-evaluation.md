# Composition evaluation: Time Lock + Cheque

Before committing to a custom lock, Tranfr's original brief was to build it as a
**composition of two existing, deployed CKB scripts** — the RFC 0039 Cheque lock
and the `ckb-proxy-locks` Time Lock — with no custom script at all. This document
records why that composition was evaluated, how, and why it was rejected. It
corrects an earlier claim in `docs/implementation-plan.md` that the Time Lock
"does not exist": it does.

## The two scripts are real and deployed

- **Time Lock** — [`ckb-devrel/ckb-proxy-locks`](https://github.com/ckb-devrel/ckb-proxy-locks),
  listed on docs.nervos.org with live **mainnet and testnet** deployments. It is
  under the `ckb-devrel` org, not `nervosnetwork`, which is why an earlier
  `nervosnetwork`-only search missed it. Args are a required lock hash (32 bytes)
  followed by a `since` value (8 bytes); it unlocks only once the input's `since`
  reaches that deadline and the required lock is present among the inputs.
- **Cheque lock (RFC 0039)** — deployed on mainnet and testnet. A Cheque cell is
  `Cheque(receiver_lock_hash, sender_lock_hash)` (20-byte truncated hashes). The
  receiver can claim at any time; the sender can only withdraw after a **hardcoded
  6 epochs** (`since = 0xA000000000000006`, relative, epoch metric).

The deployed testnet binaries were pulled, matched to their documented data
hashes, and vendored for the test:

| Script | Data hash |
|---|---|
| Time Lock | `0x6fac4b2e89360a1e692efcddcb3a28656d8446549fb83da6d896db8b714f4451` |
| Cheque | `0xbe734faa9ead3cfeef2efba92de6b6bdb5b0cadb6cd36c896081e8cab18e79b9` |

## The construction tested

The protected CKB sits in a Cheque cell. One Cheque role is a plain lock (the
**owner**), the other is `TimeLock(recipient_lock_hash, deadline)`. Both
assignments were tested:

- `OwnerIsSender`: receiver = `TimeLock(recipient)`, sender = owner.
- `OwnerIsReceiver`: receiver = owner, sender = `TimeLock(recipient)`.

## Findings

The composition cannot satisfy both of Tranfr's core requirements at once.

1. **The recipient's claim can't pay the recipient.** With the recipient on the
   Cheque *receiver* path, RFC 0039 rule **1.b.ii** requires the Cheque's capacity
   to be returned to the *sender* (the owner). Trying to pay it to the recipient
   fails with **Cheque error 8 (`SenderCapacityNotSame`)**. So the protected CKB
   can never reach the recipient through this path.
2. **Swapping the roles blocks the owner instead.** With the owner on the Cheque
   receiver path, the same rule 1.b.ii now forces the owner's own reclaim to send
   the capacity to the *sender* (the recipient's Time Lock) — the owner can't take
   their own funds back as plain CKB.
3. **The owner is locked out for 6 epochs after every spend.** The Cheque sender
   withdrawal only accepts `since = 0xA000000000000006` (6 epochs, ~24h), so each
   create or renew freezes the owner for a full day. This fails immediately with
   **Cheque error 11 (`WithdrawChequeInputSinceError`)** before the window.

Requirements 1 and 2 are jointly unsatisfiable: whichever role is the Cheque
receiver, rule 1.b.ii sends the capacity to the other party. No role assignment
delivers "recipient claims the CKB after the deadline" *and* "owner reclaims the
CKB any time."

## Conclusion

A composition of the deployed Time Lock and Cheque locks cannot implement Tranfr
for plain CKB. Tranfr is therefore built as one small custom lock
(`contracts/tranfr-lock/`), whose two unlock paths have no such capacity-routing
constraint — and which, with the typed-cell refund rule (`docs/spec.md` §5),
*deliberately* routes a claimed typed cell's capacity back to the owner, the one
case where that behaviour is wanted.

## Reproducing

The runnable evaluation is on `main`:

- `tests/src/composition.rs` — the `ckb-testtool` suite (8 tests), including
  `vendored_binaries_match_the_deployed_cells` (asserts the vendored binaries'
  data hashes match the on-chain ones), the owner/recipient path tests, and the
  two tests that assert Tranfr's requirements are blocked by Cheque error 8:
  `recipient_claim_to_the_recipient_is_blocked_by_cheque_rule` and
  `swapped_roles_owner_reclaim_is_blocked_by_cheque_rule`.
- `contracts/deployed/time-lock`, `contracts/deployed/cheque-lock` — the vendored
  testnet binaries, loaded into the suite with `include_bytes!`.

```sh
cargo test --manifest-path tests/Cargo.toml composition
```

All eight tests pass. The finding is not a build or run failure: the two
"requirement" tests assert, with `expect_err`, that the required spends are
*rejected* with Cheque error 8, exactly as RFC 0039 rule 1.b.ii dictates. The
broader `composed-locks` branch keeps the original end-to-end prototype these
binaries came from.

`ckb-testtool` runs the scripts but not consensus's own `since` check; the scripts
read each input's declared `since`, and consensus is what stops that value from
running ahead of the chain.
