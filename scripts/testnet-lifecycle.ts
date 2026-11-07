/**
 * Runs the full Tranfr lifecycle on CKB testnet against the deployed lock, using
 * the same SDK calls as the demo, and records every transaction in a JSON log.
 *
 *   TRANFR_KEYS=keys.json TRANFR_LOG=log.json tsx scripts/testnet-lifecycle.ts start
 *   TRANFR_KEYS=keys.json TRANFR_LOG=log.json tsx scripts/testnet-lifecycle.ts finish
 *   TRANFR_KEYS=keys.json TRANFR_LOG=log.json tsx scripts/testnet-lifecycle.ts udt
 *
 * keys.json: { funder, owner, recipient }, each { privateKey, address }.
 * The funder pays for creating cells (the demo's connected wallet); owner and
 * recipient need no funds for the plain (start/finish) flow. The `udt` phase is
 * the typed-cell lifecycle (docs/spec.md §5.1): it funds the recipient once (the
 * recipient brings capacity for the token cell, since the claim returns the
 * cell's whole capacity to the owner), mints a testnet xUDT into a Tranfr cell,
 * waits for the 1-epoch deadline, then claims it — refunding the capacity to the
 * owner and the tokens to the recipient. Private keys are never written to the log.
 *
 * `start` creates three cells with a 1-epoch deadline:
 *   A: extended, then claimed by the recipient after the deadline;
 *   B: reclaimed by the owner after the deadline;
 *   C: reclaimed by the owner before the deadline.
 * It also tries an early recipient claim on A, once through the SDK and once
 * bypassing the SDK's own check, so the node's rejection is on record.
 * `finish` waits until A and B are claimable, then claims A and reclaims B.
 *
 * Both phases are resumable: a step's tx hash is saved before waiting for it,
 * recorded steps are skipped, and a sent-but-unconfirmed step is just awaited.
 */
import * as ccc from "@ckb-ccc/core";
import fs from "node:fs";
import { TranfrClient, decodeArgs, decodeWitnessLock } from "../sdk/src/index.js";

const CELL_CAPACITY = ccc.fixedPointFrom(200);
const DURATION_EPOCHS = 1n;
const EXPLORER = "https://pudge.explorer.nervos.org/transaction/";

interface Keys {
  funder: { privateKey: ccc.Hex; address: string };
  owner: { privateKey: ccc.Hex; address: string };
  recipient: { privateKey: ccc.Hex; address: string };
}

interface Step {
  step: string;
  at: string;
  txHash?: string;
  explorer?: string;
  blockNumber?: string;
  epoch?: string;
  detail?: Record<string, string>;
  error?: string;
}

interface Log {
  network: "ckb_testnet";
  addresses: Record<string, string>;
  /** Current out point of each live Tranfr cell under test. */
  cells: Record<string, { txHash: string; index: number }>;
  /** Steps whose transaction was sent but not yet recorded as committed. */
  pending: Record<string, string>;
  steps: Step[];
}

const keysPath = process.env.TRANFR_KEYS;
const logPath = process.env.TRANFR_LOG;
if (!keysPath || !logPath) throw new Error("Set TRANFR_KEYS and TRANFR_LOG");
const keys: Keys = JSON.parse(fs.readFileSync(keysPath, "utf8"));

// Fail early with a clear message if any role is missing or malformed, instead
// of passing an undefined key deep into CCC (an opaque "undefined is not
// iterable"). Each role must be { privateKey: "0x…64 hex", address: "ckt1…" }.
for (const role of ["funder", "owner", "recipient"] as const) {
  const r = (keys as unknown as Record<string, { privateKey?: string; address?: string } | undefined>)[role];
  if (!r || typeof r.privateKey !== "string" || typeof r.address !== "string") {
    throw new Error(
      `${keysPath}: "${role}" must be an object { "privateKey": "0x<64 hex>", "address": "ckt1..." }. ` +
        `Got: ${JSON.stringify(r)}. Expected shape:\n` +
        `  { "funder": {"privateKey":"0x..","address":"ckt1.."}, "owner": {..}, "recipient": {..} }`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(r.privateKey)) {
    throw new Error(`${keysPath}: "${role}".privateKey must be a 0x-prefixed 32-byte hex string`);
  }
}

const client = new ccc.ClientPublicTestnet();
const tranfr = new TranfrClient({ client });

/** Same build as buildRecoveryClaim, minus the SDK's client-side deadline check. */
class UncheckedClaimClient extends TranfrClient {
  override async isRecoveryEligible(): Promise<boolean> {
    return true;
  }
}

function loadLog(): Log {
  if (fs.existsSync(logPath!)) {
    const log = JSON.parse(fs.readFileSync(logPath!, "utf8"));
    log.pending ??= {};
    return log;
  }
  return {
    network: "ckb_testnet",
    addresses: { funder: keys.funder.address, owner: keys.owner.address, recipient: keys.recipient.address },
    cells: {},
    pending: {},
    steps: [],
  };
}

function saveLog(log: Log) {
  fs.writeFileSync(logPath!, JSON.stringify(log, null, 2));
}

function done(log: Log, step: string): boolean {
  return log.steps.some((s) => s.step === step);
}

function formatEpoch(epoch: ccc.Epoch): string {
  return `${epoch.integer}+${epoch.numerator}/${epoch.denominator}`;
}

function deadlineOf(cell: ccc.Cell): string {
  const since = decodeArgs(cell.cellOutput.lock.args).deadlineSince;
  return formatEpoch(ccc.Epoch.fromNum(since & 0x00ff_ffff_ffff_ffffn));
}

function record(log: Log, step: string, entry: Omit<Step, "step" | "at">) {
  log.steps.push({ step, at: new Date().toISOString(), ...entry });
  saveLog(log);
  console.log(`${step}: ${entry.error ?? JSON.stringify(entry.detail)}`);
}

/** Runs `action` and returns its error message, or undefined if it unexpectedly succeeded. */
async function expectFailure(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Sends a step's transaction once, saves its hash before waiting, waits for it to
 * commit, then runs `afterCommit` (which may read the new chain state) for details.
 */
async function sendStep(
  log: Log,
  step: string,
  send: () => Promise<ccc.Hex>,
  afterCommit: (txHash: ccc.Hex) => Promise<Record<string, string>>,
) {
  if (done(log, step)) {
    console.log(`${step}: already recorded, skipping`);
    return;
  }
  let txHash = log.pending[step] as ccc.Hex | undefined;
  if (txHash) {
    console.log(`${step}: resuming pending ${txHash}`);
  } else {
    txHash = await send();
    log.pending[step] = txHash;
    saveLog(log);
    console.log(`${step}: sent ${txHash}`);
  }

  const response = await client.waitTransaction(txHash, 0, 900_000);
  if (response?.status !== "committed") throw new Error(`${step}: ${txHash} ended as ${response?.status}`);
  const header = await client.getHeaderByHash(response.blockHash!);
  const detail = await afterCommit(txHash);

  delete log.pending[step];
  log.steps.push({
    step,
    at: new Date().toISOString(),
    txHash,
    explorer: EXPLORER + txHash,
    blockNumber: response.blockNumber?.toString(),
    epoch: header ? formatEpoch(header.epoch) : undefined,
    detail,
  });
  saveLog(log);
  console.log(`${step}: committed in block ${response.blockNumber} ${JSON.stringify(detail)}`);
}

async function liveCell(log: Log, name: string): Promise<ccc.Cell> {
  return (await tranfr.getTranfrStatus(log.cells[name])).cell;
}

async function identity(privateKey: ccc.Hex) {
  return (await new ccc.SignerCkbPrivateKey(client, privateKey).getAddressObjSecp256k1()).script;
}

async function start() {
  const log = loadLog();
  const funder = new ccc.SignerCkbPrivateKey(client, keys.funder.privateKey);

  for (const name of ["A", "B", "C"]) {
    await sendStep(
      log,
      `create ${name}`,
      async () => {
        const tx = await tranfr.createTranfr({
          ownerLock: await identity(keys.owner.privateKey),
          recipientLock: await identity(keys.recipient.privateKey),
          capacity: CELL_CAPACITY,
          durationEpochs: DURATION_EPOCHS,
        });
        await tx.completeInputsByCapacity(funder);
        await tx.completeFeeBy(funder);
        return funder.sendTransaction(tx);
      },
      async (txHash) => {
        log.cells[name] = { txHash, index: 0 };
        return { capacity: "200 CKB", durationEpochs: DURATION_EPOCHS.toString(), deadline: deadlineOf(await liveCell(log, name)) };
      },
    );
  }

  // Extend A (heartbeat). An explicit 1-epoch period from now still lands after the old deadline.
  const createdA = log.steps.find((s) => s.step === "create A")!;
  await sendStep(
    log,
    "renew A (extend)",
    async () =>
      client.sendTransaction(
        await tranfr.renewTranfr({
          cell: await liveCell(log, "A"),
          ownerPrivateKey: keys.owner.privateKey,
          newDurationEpochs: DURATION_EPOCHS,
        }),
      ),
    async (txHash) => {
      log.cells.A = { txHash, index: 0 };
      return { oldDeadline: createdA.detail!.deadline, newDeadline: deadlineOf(await liveCell(log, "A")) };
    },
  );

  // Owner reclaims C before its deadline.
  const createdC = log.steps.find((s) => s.step === "create C")!;
  await sendStep(
    log,
    "owner reclaim C (before deadline)",
    async () =>
      client.sendTransaction(
        await tranfr.buildOwnerReclaim({ cell: await liveCell(log, "C"), ownerPrivateKey: keys.owner.privateKey }),
      ),
    async () => {
      delete log.cells.C;
      return { deadline: createdC.detail!.deadline, paidTo: keys.owner.address, witnessMode: "OWNER" };
    },
  );

  // Early recipient claims on A must fail: first the SDK refuses, then the node.
  const sdkStep = "early claim A via SDK (expected: refused)";
  const nodeStep = "early claim A sent to node, SDK check bypassed (expected: rejected)";
  if (!done(log, sdkStep) || !done(log, nodeStep)) {
    const cellA = await liveCell(log, "A");
    if (!done(log, sdkStep)) {
      const refusal = await expectFailure(() =>
        tranfr.buildRecoveryClaim({ cell: cellA, recipientPrivateKey: keys.recipient.privateKey }),
      );
      if (!refusal) throw new Error("SDK built an early claim; expected it to refuse");
      record(log, sdkStep, { error: refusal });
    }
    if (!done(log, nodeStep)) {
      const early = await new UncheckedClaimClient({ client }).buildRecoveryClaim({
        cell: cellA,
        recipientPrivateKey: keys.recipient.privateKey,
      });
      const rejection = await expectFailure(() => client.sendTransaction(early));
      if (!rejection) throw new Error("node accepted an early claim; expected rejection");
      record(log, nodeStep, { error: rejection.slice(0, 500) });
    }
  }

  const statusA = await tranfr.getTranfrStatus(log.cells.A);
  const statusB = await tranfr.getTranfrStatus(log.cells.B);
  record(log, "status after start", {
    detail: {
      A: `deadline ${deadlineOf(statusA.cell)}, claimable ${statusA.isClaimable}, epochsRemaining ${statusA.epochsRemaining}`,
      B: `deadline ${deadlineOf(statusB.cell)}, claimable ${statusB.isClaimable}, epochsRemaining ${statusB.epochsRemaining}`,
    },
  });
}

async function finish() {
  const log = loadLog();
  if (!done(log, "renew A (extend)") || !log.cells.B) throw new Error("run start first");

  const claimStep = "recipient claim A (at/after deadline)";
  const reclaimStep = "owner reclaim B (after deadline)";
  if (!log.pending[claimStep] && !done(log, claimStep)) {
    for (;;) {
      const [a, b] = await Promise.all([tranfr.getTranfrStatus(log.cells.A), tranfr.getTranfrStatus(log.cells.B)]);
      if (a.isClaimable && b.isClaimable) break;
      console.log(`${new Date().toISOString()} waiting: A ${a.epochsRemaining} epoch(s) left, B ${b.epochsRemaining}`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }

  let claimDetail: Record<string, string> = {};
  await sendStep(
    log,
    claimStep,
    async () => {
      const cellA = await liveCell(log, "A");
      const claim = await tranfr.buildRecoveryClaim({ cell: cellA, recipientPrivateKey: keys.recipient.privateKey });
      if (!claim.outputs[0].lock.eq(await identity(keys.recipient.privateKey))) {
        throw new Error("claim output is not the recipient's lock");
      }
      claimDetail = {
        deadline: deadlineOf(cellA),
        inputSince: `0x${claim.inputs[0].since.toString(16)}`,
        paidTo: keys.recipient.address,
        amount: `${ccc.fixedPointToString(claim.outputs[0].capacity)} CKB`,
        witnessMode: decodeWitnessLock(claim.getWitnessArgs(0)!.lock!).mode === 1 ? "RECIPIENT" : "OWNER",
      };
      return client.sendTransaction(claim);
    },
    async () => claimDetail,
  );

  let reclaimDetail: Record<string, string> = {};
  await sendStep(
    log,
    reclaimStep,
    async () => {
      const cellB = await liveCell(log, "B");
      const reclaim = await tranfr.buildOwnerReclaim({ cell: cellB, ownerPrivateKey: keys.owner.privateKey });
      reclaimDetail = {
        deadline: deadlineOf(cellB),
        paidTo: keys.owner.address,
        amount: `${ccc.fixedPointToString(reclaim.outputs[0].capacity)} CKB`,
      };
      return client.sendTransaction(reclaim);
    },
    async () => reclaimDetail,
  );

  for (const name of ["A", "B"]) {
    const step = `status ${name} after spend (expected: not live)`;
    if (done(log, step)) continue;
    const gone = await expectFailure(() => tranfr.getTranfrStatus(log.cells[name]));
    if (!gone) throw new Error(`${name} still shows as live after being spent`);
    record(log, step, { error: gone });
  }
}

// ── UDT (typed-cell) lifecycle ───────────────────────────────────────────────
//
// Exercises the typed-cell claim rule (docs/spec.md §5.1): the recipient's claim
// of a UDT-carrying Tranfr cell must refund the cell's capacity to the owner and
// hand the recipient a new token cell they fund themselves. Uses testnet xUDT
// minted by the funder (xUDT args = the funder's lock hash, so the funder can
// mint). The recipient is funded once up front because — unlike the plain claim,
// whose fee comes out of the cell — the recipient here brings fresh capacity for
// the token cell (the whole cell capacity goes back to the owner).
const UDT_CELL_CAPACITY = ccc.fixedPointFrom(200);
const UDT_AMOUNT = 1_000_000n;
const RECIPIENT_FUNDING = ccc.fixedPointFrom(300);

async function udt() {
  const log = loadLog();
  const funder = new ccc.SignerCkbPrivateKey(client, keys.funder.privateKey);
  const funderLockHash = (await funder.getAddressObjSecp256k1()).script.hash();
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  const udtType = ccc.Script.from({ codeHash: xudt.codeHash, hashType: xudt.hashType, args: funderLockHash });
  const udtCellDeps = xudt.cellDeps.map((d) => d.cellDep);

  // Fund the recipient so it can pay for the token cell it keeps on claim.
  await sendStep(
    log,
    "fund recipient (for UDT claim)",
    async () => {
      const tx = ccc.Transaction.from({
        outputs: [{ lock: await identity(keys.recipient.privateKey), capacity: RECIPIENT_FUNDING }],
        outputsData: ["0x"],
      });
      await tx.completeInputsByCapacity(funder);
      await tx.completeFeeBy(funder);
      return funder.sendTransaction(tx);
    },
    async () => ({ to: keys.recipient.address, amount: `${ccc.fixedPointToString(RECIPIENT_FUNDING)} CKB` }),
  );

  // Create a UDT-carrying Tranfr cell (mint xUDT into a Tranfr-locked output).
  await sendStep(
    log,
    "create U (UDT Tranfr cell)",
    async () => {
      const tx = await tranfr.createTranfr({
        ownerLock: await identity(keys.owner.privateKey),
        recipientLock: await identity(keys.recipient.privateKey),
        capacity: UDT_CELL_CAPACITY,
        durationEpochs: DURATION_EPOCHS,
      });
      tx.outputs[0].type = udtType;
      tx.outputsData[0] = ccc.hexFrom(ccc.numLeToBytes(UDT_AMOUNT, 16));
      tx.addCellDeps(udtCellDeps);
      await tx.completeInputsByCapacity(funder);
      await tx.completeFeeBy(funder);
      return funder.sendTransaction(tx);
    },
    async (txHash) => {
      log.cells.U = { txHash, index: 0 };
      const cell = await liveCell(log, "U");
      return { amount: UDT_AMOUNT.toString(), deadline: deadlineOf(cell), type: "xUDT" };
    },
  );

  // Wait for the 1-epoch deadline.
  const claimStep = "recipient claim U (typed: capacity to owner, tokens to recipient)";
  if (!log.pending[claimStep] && !done(log, claimStep)) {
    for (;;) {
      const u = await tranfr.getTranfrStatus(log.cells.U);
      if (u.isClaimable) break;
      console.log(`${new Date().toISOString()} waiting: U ${u.epochsRemaining} epoch(s) left`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }

  let claimDetail: Record<string, string> = {};
  await sendStep(
    log,
    claimStep,
    async () => {
      const cellU = await liveCell(log, "U");
      const ownerLock = await identity(keys.owner.privateKey);
      const recipientLock = await identity(keys.recipient.privateKey);
      const claim = await tranfr.buildRecoveryClaim({
        cell: cellU,
        recipientPrivateKey: keys.recipient.privateKey,
        ownerLock,
        cellDeps: udtCellDeps,
      });
      // Output 0: the cell's capacity refunded to the owner as plain CKB.
      if (!claim.outputs[0].lock.eq(ownerLock) || claim.outputs[0].type) {
        throw new Error("claim output 0 is not the plain owner refund");
      }
      // Output 1: the tokens, to the recipient.
      if (!claim.outputs[1].lock.eq(recipientLock) || !claim.outputs[1].type?.eq(udtType)) {
        throw new Error("claim output 1 is not the recipient's token cell");
      }
      claimDetail = {
        deadline: deadlineOf(cellU),
        inputSince: `0x${claim.inputs[0].since.toString(16)}`,
        ownerRefund: `${ccc.fixedPointToString(claim.outputs[0].capacity)} CKB to ${keys.owner.address}`,
        recipientTokens: `${ccc.udtBalanceFrom(claim.outputsData[1])} to ${keys.recipient.address}`,
        witnessMode: decodeWitnessLock(claim.getWitnessArgs(0)!.lock!).mode === 1 ? "RECIPIENT" : "OWNER",
      };
      return client.sendTransaction(claim);
    },
    async () => claimDetail,
  );

  const step = "status U after spend (expected: not live)";
  if (!done(log, step)) {
    const gone = await expectFailure(() => tranfr.getTranfrStatus(log.cells.U));
    if (!gone) throw new Error("U still shows as live after being spent");
    record(log, step, { error: gone });
  }
}

const phase = process.argv[2];
if (phase === "start") await start();
else if (phase === "finish") await finish();
else if (phase === "udt") await udt();
else throw new Error("usage: testnet-lifecycle.ts start|finish|udt");
// The CCC client keeps its RPC transport open; exit explicitly once the phase is done.
process.exit(0);
