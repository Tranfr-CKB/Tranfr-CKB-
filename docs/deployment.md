# Deployment

## Status: DEPLOYED (Testnet) — typed-cell refund-rule binary

The lock binary **with** the typed-cell capacity-refund rule (`docs/spec.md`
§5.1) is deployed on CKB Testnet (Pudge) using a native Type ID type script, and
confirmed on-chain. `sdk/src/config.ts` (`TRANFR_TESTNET_CONFIG`) points here.

## Deployment Details

| Field | Value |
|---|---|
| Network / Genesis | `ckb_testnet` (`0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`) |
| Transaction Hash (`tx_hash`) | `0xd0e66d4f3c401a949b8baa1f15fd11fcbdb5625542b58ff20b40bfdaac7969a6` |
| Output Index | `0` |
| Cell Capacity | 110,118 CKB (`11011800000000` Shannons) |
| `code_hash` (Type ID) | `0x258d2a85b854c9a1ae9824a2c60aa88e32a95d81a9386f734275629918dd757a` |
| `hash_type` | `type` |
| Binary Data Hash (`data_hash`) | `0xf580ce5698d42198a615c4f582e4d24fd39fbb1109460980a070babe750b0a59` |
| Explorer Link | [View on CKB Testnet Explorer](https://pudge.explorer.nervos.org/transaction/0xd0e66d4f3c401a949b8baa1f15fd11fcbdb5625542b58ff20b40bfdaac7969a6) |

Deployer address (funded the deployment): `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvap25ph43qd3f7yxtgmmqwa343hgj2mpsh6ct9r`.

## Previous deployment (superseded — pre-refund binary)

| Field | Value |
|---|---|
| Network / Genesis | `ckb_testnet` (`0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`) |
| Transaction Hash (`tx_hash`) | `0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08` |
| Output Index | `0` |
| Cell Capacity | 108,726 CKB (`10872600000000` Shannons) |
| `code_hash` (Type ID) | `0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd` |
| `hash_type` | `type` |
| Type ID Script Args | `0xb7dde334fbb3c3d0eb9bda670ad406922c09a8fa000b51f7b140078ff115d3dc` |
| Binary Data Hash (`data_hash`) | `0x24a5f576896042fa4583b9536189edfd21731c3d82f29ba28395a8145d77da3d` |
| Block Number | 22,699,494 (`0x15a5de6`) |
| Block Hash | `0x938a882707c2df43a872879d08af578e3d1aeee6e064b8b0ef8a51436cb89309` |
| Explorer Link | [View on CKB Testnet Explorer](https://pudge.explorer.nervos.org/transaction/0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08) |

## Cell Dep Reference for Transactions

To use `tranfr-lock` in CKB transactions:

```typescript
const TRANFR_CELL_DEP = {
  outPoint: {
    txHash: "0xd0e66d4f3c401a949b8baa1f15fd11fcbdb5625542b58ff20b40bfdaac7969a6",
    index: 0,
  },
  depType: "code",
};

const TRANFR_SCRIPT_CONFIG = {
  codeHash: "0x258d2a85b854c9a1ae9824a2c60aa88e32a95d81a9386f734275629918dd757a",
  hashType: "type",
};
```

## Build artifact (local, unverified by a second machine)

Current binary — **with** the typed-cell refund rule (`docs/spec.md` §5.1):

| Field | Value |
|---|---|
| Binary | `build/release/tranfr-lock` (`make build CONTRACT=tranfr-lock`) |
| Size | 109992 bytes |
| sha256 | `71e3aaa4cc0612bdc616b0ce2da5a2d7cc80a365458c2320db32ab5a0ab3dcc9` |
| CKB data hash (blake2b-256, `ckb-default-hash`) | `0xf580ce5698d42198a615c4f582e4d24fd39fbb1109460980a070babe750b0a59` |

Superseded (pre-refund) binary: size 108600, sha256
`866da13128580f22d9bcf713ffd1f2fb6286bf512e2870744ccdb9d7288feb0e`, data hash
`0x24a5f576896042fa4583b9536189edfd21731c3d82f29ba28395a8145d77da3d`.

These hashes are from a local `clang-14` release build; a reproducible Docker
build (`scripts/reproducible_build_docker`) may differ, in which case re-derive
the three values and update `scripts/deploy.ts`'s `EXPECTED_*` constants, which
are display-only and don't block deployment.

The `make build` run ends with a `tranfr-lock-sim` package error from the
template's simulator step. The binary is already copied by then; the error is
unrelated to the artifact.

## Deployment Script (Step 10 / Step 11)

A reproducible deployment script powered by `@ckb-ccc/core` is located at `scripts/deploy.ts`. It deploys the compiled binary to CKB testnet using native Type ID (`hash_type = type`) so the deployed contract reference remains upgradeable.

### Prerequisites

- Build artifact: `build/release/tranfr-lock` (109,992 bytes, current refund-rule binary)
- Node.js & dependencies (`npm install`)
- A funded CKB testnet private key with at least ~110,118 CKB (to cover cell capacity + tx fee). Faucet available at: [https://faucet.nervos.org/](https://faucet.nervos.org/).

### Running the Deployment

```bash
# 1. Validate environment, hashes, and network RPC without broadcasting
npm run deploy

# 2. Dry-run with an account to verify balance and derived address
npx tsx scripts/deploy.ts --key 0x<YOUR_PRIVATE_KEY> --dry-run

# 3. Broadcast deployment transaction to testnet and update this doc
CKB_TESTNET_PRIVATE_KEY=0x<YOUR_PRIVATE_KEY> npm run deploy
```

## Status: Complete

1. Official testnet identity confirmed: `ckb_testnet`, genesis `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`.
2. Refund-rule binary deployed with Type ID script to preserve upgradeability.
3. Broadcasted and confirmed: tx `0xd0e66d4f3c401a949b8baa1f15fd11fcbdb5625542b58ff20b40bfdaac7969a6`.
4. Type ID `code_hash`: `0x258d2a85b854c9a1ae9824a2c60aa88e32a95d81a9386f734275629918dd757a`.


