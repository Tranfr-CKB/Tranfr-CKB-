use ckb_testtool::ckb_error::Error;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use ckb_testtool::context::Context;

const ERR_UNKNOWN_MODE: i8 = 1;
const ERR_ARGS_LEN: i8 = 2;
const ERR_WITNESS_LEN: i8 = 3;
const ERR_LOAD_WITNESS: i8 = 4;

fn make_valid_args() -> Bytes {
    let mut args = vec![0u8; 72];
    args[0..32].fill(0x11); // owner_lock_hash
    args[32..64].fill(0x22); // recipient_lock_hash
    let deadline: u64 = 0x2000000000000050; // absolute epoch-with-fraction deadline
    args[64..72].copy_from_slice(&deadline.to_le_bytes());
    Bytes::from(args)
}

fn make_witness(lock_bytes: Option<Bytes>) -> Bytes {
    let mut builder = WitnessArgs::new_builder();
    if let Some(lb) = lock_bytes {
        builder = builder.lock(Some(lb).pack());
    }
    builder.build().as_bytes()
}

fn make_valid_witness(mode: u8) -> Bytes {
    let mut lock = vec![0u8; 66];
    lock[0] = mode;
    lock[1..66].fill(0x99); // 65-byte dummy signature
    make_witness(Some(Bytes::from(lock)))
}

fn assert_error_code(err: &Error, expected_code: i8) {
    let err_str = err.to_string();
    let expected_pattern = format!("error code {expected_code}");
    assert!(
        err_str.contains(&expected_pattern),
        "Expected error code {expected_code}, got: {err_str}"
    );
}

fn build_tx(
    context: &mut Context,
    args: Bytes,
    witness_opt: Option<Bytes>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let out_point = context.deploy_cell_by_name("tranfr-lock");
    let lock_script = context.build_script(&out_point, args).expect("script");

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(1000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );
    let input = CellInput::new_builder()
        .previous_output(input_out_point)
        .build();

    let output = CellOutput::new_builder()
        .capacity(1000u64)
        .lock(lock_script)
        .build();

    let mut tx_builder = TransactionBuilder::default()
        .input(input)
        .output(output)
        .output_data(Bytes::new().pack());

    if let Some(w) = witness_opt {
        tx_builder = tx_builder.witness(w.pack());
    }

    let tx = tx_builder.build();
    context.complete_tx(tx)
}

// ── Real-signature helpers (OWNER/RECIPIENT paths) ───────────────────────────

use ckb_testtool::ckb_hash::{blake2b_256, new_blake2b};
use k256::ecdsa::SigningKey;

const ERR_OWNER_SIG: i8 = 5;
const ERR_RECIPIENT_SIG: i8 = 6;
const ERR_RELATIVE_SINCE: i8 = 7;
const ERR_SINCE_NOT_ELIGIBLE: i8 = 8;

const SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH: [u8; 32] = [
    0x9b, 0xd7, 0xe0, 0x6f, 0x3e, 0xcf, 0x4b, 0xe0, 0xf2, 0xfc, 0xd2, 0x18, 0x8b, 0x23, 0xf1, 0xb9,
    0xfc, 0xc8, 0x8e, 0x5d, 0x4b, 0x65, 0xa8, 0x63, 0x7b, 0x17, 0x72, 0x3b, 0xbd, 0xa3, 0xcc, 0xe8,
];

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32].into()).expect("valid scalar")
}

/// The standard `secp256k1_blake160_sighash_all` lock script a wallet holding
/// `key` has.
fn secp256k1_script_of(key: &SigningKey) -> Script {
    let pubkey = key.verifying_key().to_sec1_point(true);
    let args = &blake2b_256(pubkey.as_bytes())[0..20];
    Script::new_builder()
        .code_hash(SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH.pack())
        .hash_type(ckb_testtool::ckb_types::core::ScriptHashType::Type)
        .args(Bytes::copy_from_slice(args).pack())
        .build()
}

/// The `secp256k1_blake160_sighash_all` lock hash a wallet holding `key` has.
fn lock_hash_of(key: &SigningKey) -> [u8; 32] {
    blake2b_256(secp256k1_script_of(key).as_slice())
}

/// Packs an RFC 0017 `since`: flags byte, then (epoch, index, length).
fn since(flags: u8, epoch: u64, index: u64, length: u64) -> u64 {
    ((flags as u64) << 56) | (length << 40) | (index << 24) | epoch
}

const ABS_EPOCH: u8 = 0x20;
const REL_EPOCH: u8 = 0xA0;

fn args_for(owner: &SigningKey, recipient: &SigningKey, deadline: u64) -> Bytes {
    let mut args = Vec::with_capacity(72);
    args.extend_from_slice(&lock_hash_of(owner));
    args.extend_from_slice(&lock_hash_of(recipient));
    args.extend_from_slice(&deadline.to_le_bytes());
    Bytes::from(args)
}

/// Builds a one-input tx with the given input `since`, signed by `signer`
/// under `mode`, using the real sighash_all message (single input/witness).
fn build_signed_tx(
    context: &mut Context,
    args: Bytes,
    mode: u8,
    signer: &SigningKey,
    input_since: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    build_signed_tx_multi(context, args, mode, signer, &[input_since])
}

/// Like `build_signed_tx` but with one input per entry of `input_sinces`,
/// all sharing the same lock (one script group). Extra witnesses are empty.
fn build_signed_tx_multi(
    context: &mut Context,
    args: Bytes,
    mode: u8,
    signer: &SigningKey,
    input_sinces: &[u64],
) -> ckb_testtool::ckb_types::core::TransactionView {
    let placeholder = |sig: [u8; 65]| {
        let mut lock = vec![mode];
        lock.extend_from_slice(&sig);
        make_witness(Some(Bytes::from(lock)))
    };
    let out_point = context.deploy_cell_by_name("tranfr-lock");
    let lock_script = context.build_script(&out_point, args).expect("script");
    let mut builder = TransactionBuilder::default();
    for input_since in input_sinces {
        let input_out_point = context.create_cell(
            CellOutput::new_builder()
                .capacity(1000u64)
                .lock(lock_script.clone())
                .build(),
            Bytes::new(),
        );
        builder = builder.input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .since(Pack::<Uint64>::pack(input_since))
                .build(),
        );
    }
    let tx = builder
        .output(
            CellOutput::new_builder()
                .capacity(1000u64)
                .lock(lock_script)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .witness(placeholder([0u8; 65]).pack())
        .witnesses((1..input_sinces.len()).map(|_| Bytes::new().pack()))
        .build();
    let tx = context.complete_tx(tx);

    // sighash_all: the script zeroes the entire 66-byte lock field (mode
    // byte included, per docs/spec.md) before hashing.
    let zeroed = make_witness(Some(Bytes::from(vec![0u8; 66])));
    let mut hasher = new_blake2b();
    hasher.update(tx.hash().as_slice());
    hasher.update(&(zeroed.len() as u64).to_le_bytes());
    hasher.update(&zeroed);
    for _ in 1..input_sinces.len() {
        hasher.update(&0u64.to_le_bytes()); // empty extra group witnesses
    }
    let mut message = [0u8; 32];
    hasher.finalize(&mut message);

    let (sig, recid) = signer.sign_prehash_recoverable(&message);
    let mut sig_bytes = [0u8; 65];
    sig_bytes[0..64].copy_from_slice(&sig.to_bytes());
    sig_bytes[64] = recid.to_byte();
    tx.as_advanced_builder()
        .set_witnesses(
            std::iter::once(placeholder(sig_bytes).pack())
                .chain((1..input_sinces.len()).map(|_| Bytes::new().pack()))
                .collect(),
        )
        .build()
}

fn verify(context: &Context, tx: &ckb_testtool::ckb_types::core::TransactionView) -> Result<u64, Error> {
    context.verify_tx(tx, 100_000_000)
}

#[test]
fn test_owner_succeeds_with_no_since() {
    let (owner, recipient) = (key(1), key(2));
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, since(ABS_EPOCH, 100, 1, 4));
    let tx = build_signed_tx(&mut context, args, 0x00, &owner, 0);
    let cycles = verify(&context, &tx).expect("owner path should pass");
    println!("owner path cycles: {cycles}");
}

#[test]
fn test_owner_rejects_wrong_signer() {
    let (owner, recipient) = (key(1), key(2));
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, since(ABS_EPOCH, 100, 1, 4));
    let tx = build_signed_tx(&mut context, args, 0x00, &recipient, 0);
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_OWNER_SIG);
}

#[test]
fn test_recipient_succeeds_at_and_after_deadline() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    for input_since in [
        deadline,                       // exact boundary
        since(ABS_EPOCH, 100, 2, 8),    // equal-ratio, different denominator
        since(ABS_EPOCH, 100, 3, 4),    // later in same epoch
        since(ABS_EPOCH, 101, 0, 1),    // later epoch
    ] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, deadline);
        let tx = build_signed_tx(&mut context, args, 0x01, &recipient, input_since);
        let cycles = verify(&context, &tx)
            .unwrap_or_else(|e| panic!("since {input_since:#x} should pass: {e}"));
        println!("recipient path cycles: {cycles}");
    }
}

#[test]
fn test_recipient_rejects_before_deadline() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    for input_since in [
        0,                              // no since at all
        since(ABS_EPOCH, 100, 0, 4),    // just before, same epoch
        since(ABS_EPOCH, 99, 3, 4),     // earlier epoch
        since(ABS_EPOCH, 100, 0, 0),    // degenerate zero-length early-claim
        since(0x00, 999_999, 0, 0),     // absolute block-number metric
        since(0x40, 999_999, 0, 0),     // absolute timestamp metric
    ] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, deadline);
        let tx = build_signed_tx(&mut context, args, 0x01, &recipient, input_since);
        assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
    }
}

#[test]
fn test_recipient_rejects_relative_since() {
    let (owner, recipient) = (key(1), key(2));
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, since(ABS_EPOCH, 100, 1, 4));
    let tx = build_signed_tx(&mut context, args, 0x01, &recipient, since(REL_EPOCH, 999, 0, 1));
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_RELATIVE_SINCE);
}

#[test]
fn test_recipient_rejects_malformed_deadline() {
    // A deadline that isn't absolute epoch-with-fraction is never satisfiable.
    let (owner, recipient) = (key(1), key(2));
    for bad_deadline in [since(0x00, 1, 0, 0), since(REL_EPOCH, 1, 0, 1)] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, bad_deadline);
        let tx = build_signed_tx(&mut context, args, 0x01, &recipient, since(ABS_EPOCH, 999, 0, 1));
        assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
    }
}

#[test]
fn test_recipient_rejects_wrong_signer_even_after_deadline() {
    // Owner key signing in RECIPIENT mode must not pass, nor may a valid
    // since rescue a bad signature.
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let tx = build_signed_tx(&mut context, args, 0x01, &owner, since(ABS_EPOCH, 200, 0, 1));
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_RECIPIENT_SIG);
}

#[test]
fn test_reject_invalid_args_length() {
    // Too short (1 byte)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        Bytes::from(vec![42]),
        Some(make_valid_witness(0x00)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_ARGS_LEN);

    // 71 bytes (1 byte short)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        Bytes::from(vec![0u8; 71]),
        Some(make_valid_witness(0x00)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_ARGS_LEN);

    // 73 bytes (1 byte too long)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        Bytes::from(vec![0u8; 73]),
        Some(make_valid_witness(0x00)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_ARGS_LEN);
}

#[test]
fn test_reject_missing_or_empty_witness() {
    // Completely missing witness
    let mut context = Context::default();
    let tx = build_tx(&mut context, make_valid_args(), None);
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_LOAD_WITNESS);

    // WitnessArgs with no lock field
    let mut context = Context::default();
    let tx = build_tx(&mut context, make_valid_args(), Some(make_witness(None)));
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_LOAD_WITNESS);
}

#[test]
fn test_reject_invalid_witness_lock_length() {
    // 65 bytes (1 byte short)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_witness(Some(Bytes::from(vec![0u8; 65])))),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_WITNESS_LEN);

    // 67 bytes (1 byte too long)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_witness(Some(Bytes::from(vec![0u8; 67])))),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_WITNESS_LEN);
}

#[test]
fn test_reject_unknown_mode_byte() {
    // Mode 0x02
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_valid_witness(0x02)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_UNKNOWN_MODE);

    // Mode 0xFF
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_valid_witness(0xFF)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_UNKNOWN_MODE);
}

#[test]
fn test_recipient_checks_every_input_in_the_group() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 101, 0, 1);
    let early = since(ABS_EPOCH, 99, 0, 1);

    // Mature first input must not shield an unmatured second one, in either order.
    for sinces in [[mature, 0], [mature, early], [early, mature]] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, deadline);
        let tx = build_signed_tx_multi(&mut context, args, 0x01, &recipient, &sinces);
        assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
    }
    // A relative since on a later input is rejected too.
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let tx = build_signed_tx_multi(&mut context, args, 0x01, &recipient, &[mature, since(REL_EPOCH, 999, 0, 1)]);
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_RELATIVE_SINCE);

    // All inputs mature: succeeds.
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let tx = build_signed_tx_multi(&mut context, args, 0x01, &recipient, &[mature, deadline, mature]);
    verify(&context, &tx).expect("all-mature group should pass");
}

// ── Step 9: adversarial suite ────────────────────────────────────────────────

type Tx = ckb_testtool::ckb_types::core::TransactionView;

/// Replaces the first witness's 66-byte lock field, leaving the tx hash intact.
fn with_lock(tx: &Tx, lock: Vec<u8>) -> Tx {
    tx.as_advanced_builder()
        .set_witnesses(vec![make_witness(Some(Bytes::from(lock))).pack()])
        .build()
}

fn lock_of(tx: &Tx) -> Vec<u8> {
    let w = WitnessArgs::from_slice(&tx.witnesses().get(0).unwrap().raw_data()).unwrap();
    w.lock().to_opt().unwrap().raw_data().to_vec()
}

#[test]
fn adv_owner_succeeds_before_at_and_after_deadline_and_with_any_since() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    for input_since in [
        0,
        since(ABS_EPOCH, 50, 0, 1),  // well before
        deadline,                    // exactly at
        since(ABS_EPOCH, 500, 0, 1), // well after
        since(REL_EPOCH, 5, 0, 1),   // relative: irrelevant on owner path
        since(0x00, 7, 0, 0),        // block-number metric: irrelevant
    ] {
        let mut context = Context::default();
        let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), 0x00, &owner, input_since);
        verify(&context, &tx).unwrap_or_else(|e| panic!("owner since {input_since:#x}: {e}"));
    }
}

#[test]
fn adv_owner_succeeds_even_with_malformed_deadline() {
    // The owner path must be unconditional: a garbage deadline can never lock the owner out.
    let (owner, recipient) = (key(1), key(2));
    for bad in [0u64, u64::MAX, since(REL_EPOCH, 1, 0, 1), since(0x00, 1, 0, 0)] {
        let mut context = Context::default();
        let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, bad), 0x00, &owner, 0);
        verify(&context, &tx).unwrap_or_else(|e| panic!("deadline {bad:#x}: {e}"));
    }
}

#[test]
fn adv_boundary_fraction_edge_cases() {
    let (owner, recipient) = (key(1), key(2));
    // (deadline, input_since, should_pass)
    let cases = [
        // different denominators, equal ratio
        (since(ABS_EPOCH, 10, 1, 3), since(ABS_EPOCH, 10, 2, 6), true),
        // just below / just above with different denominators (1/3 vs 332/1000, 334/1000)
        (since(ABS_EPOCH, 10, 1, 3), since(ABS_EPOCH, 10, 332, 1000), false),
        (since(ABS_EPOCH, 10, 1, 3), since(ABS_EPOCH, 10, 334, 1000), true),
        // large denominators near the 16-bit limit
        (since(ABS_EPOCH, 10, 65534, 65535), since(ABS_EPOCH, 10, 65533, 65535), false),
        (since(ABS_EPOCH, 10, 65534, 65535), since(ABS_EPOCH, 10, 65534, 65535), true),
        // fraction ignored once the epoch is strictly later / earlier
        (since(ABS_EPOCH, 10, 3, 4), since(ABS_EPOCH, 11, 0, 1), true),
        (since(ABS_EPOCH, 10, 0, 1), since(ABS_EPOCH, 9, 4095, 4096), false),
        // start-of-epoch deadline: degenerate (0,0) spellings are equivalent to (0,1)
        (since(ABS_EPOCH, 10, 0, 0), since(ABS_EPOCH, 10, 0, 1), true),
        (since(ABS_EPOCH, 10, 0, 1), since(ABS_EPOCH, 10, 0, 0), true),
        (since(ABS_EPOCH, 10, 0, 0), since(ABS_EPOCH, 9, 0, 0), false),
        // epoch 0 and maximum 24-bit epoch
        (since(ABS_EPOCH, 0, 0, 1), since(ABS_EPOCH, 0, 0, 1), true),
        (since(ABS_EPOCH, 0xff_ffff, 0, 1), since(ABS_EPOCH, 0xff_fffe, 65535, 65535), false),
        (since(ABS_EPOCH, 0xff_ffff, 0, 1), since(ABS_EPOCH, 0xff_ffff, 0, 1), true),
    ];
    for (deadline, input_since, should_pass) in cases {
        let mut context = Context::default();
        let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), 0x01, &recipient, input_since);
        let r = verify(&context, &tx);
        if should_pass {
            r.unwrap_or_else(|e| panic!("deadline {deadline:#x} since {input_since:#x} should pass: {e}"));
        } else {
            assert_error_code(&r.unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
        }
    }
}

#[test]
fn adv_mode_byte_cannot_steal_the_other_paths_signature() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 500, 0, 1);

    // Recipient's signature, mode flipped to OWNER (the mode byte is not signed).
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), 0x01, &recipient, mature);
    let mut lock = lock_of(&tx);
    lock[0] = 0x00;
    assert_error_code(&verify(&context, &with_lock(&tx, lock)).unwrap_err(), ERR_OWNER_SIG);

    // Owner's signature, mode flipped to RECIPIENT — even with a mature since.
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), 0x00, &owner, mature);
    let mut lock = lock_of(&tx);
    lock[0] = 0x01;
    assert_error_code(&verify(&context, &with_lock(&tx, lock)).unwrap_err(), ERR_RECIPIENT_SIG);

    // Recipient cannot take the owner path by signing as themselves.
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), 0x00, &recipient, 0);
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_OWNER_SIG);

    // A stranger can do neither.
    let stranger = key(3);
    for mode in [0x00u8, 0x01] {
        let mut context = Context::default();
        let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), mode, &stranger, mature);
        let want = if mode == 0 { ERR_OWNER_SIG } else { ERR_RECIPIENT_SIG };
        assert_error_code(&verify(&context, &tx).unwrap_err(), want);
    }
}

#[test]
fn adv_owner_equals_recipient_still_gated_on_recipient_path() {
    // Same key in both roles: the owner path is unconditional, the recipient path still gated.
    let k = key(1);
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, args_for(&k, &k, deadline), 0x00, &k, 0);
    verify(&context, &tx).expect("owner mode passes");
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, args_for(&k, &k, deadline), 0x01, &k, 0);
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
}

#[test]
fn adv_tampered_or_malformed_signatures_fail_cleanly() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 500, 0, 1);
    for (mode, signer) in [(0x00u8, &owner), (0x01u8, &recipient)] {
        let mut context = Context::default();
        let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), mode, signer, mature);
        let good = lock_of(&tx);
        verify(&context, &tx).expect("untampered baseline passes");

        let mut cases: Vec<Vec<u8>> = Vec::new();
        for pos in [1usize, 33, 64] {
            let mut l = good.clone();
            l[pos] ^= 0x01; // flip a bit in r, s
            cases.push(l);
        }
        let mut l = good.clone();
        l[1..66].fill(0); // all-zero signature
        cases.push(l);
        let mut l = good.clone();
        l[65] = 4; // recovery id out of range
        cases.push(l);
        let mut l = good.clone();
        l[65] ^= 1; // flipped recovery id -> different/invalid pubkey
        cases.push(l);

        for l in cases {
            // Must fail (any non-zero error code), never succeed or panic.
            let err = verify(&context, &with_lock(&tx, l)).unwrap_err();
            assert!(err.to_string().contains("error code"), "unexpected failure kind: {err}");
        }
    }
}

#[test]
fn adv_signature_is_bound_to_the_transaction() {
    // Replaying a valid witness on a tx with a different output must fail.
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 500, 0, 1);
    for (mode, signer, want) in [(0x00u8, &owner, ERR_OWNER_SIG), (0x01u8, &recipient, ERR_RECIPIENT_SIG)] {
        let mut context = Context::default();
        let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), mode, signer, mature);
        let first_output = tx.outputs().get(0).unwrap();
        let redirected = tx
            .as_advanced_builder()
            .set_outputs(vec![first_output.as_builder().capacity(999u64).build()])
            .build();
        assert_error_code(&verify(&context, &redirected).unwrap_err(), want);
    }
}

#[test]
fn adv_extra_group_witnesses_are_signed_over() {
    // Altering a later group witness after signing invalidates the signature.
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 500, 0, 1);
    let mut context = Context::default();
    let tx = build_signed_tx_multi(&mut context, args_for(&owner, &recipient, deadline), 0x01, &recipient, &[mature, mature]);
    verify(&context, &tx).expect("baseline passes");
    let mut ws: Vec<_> = tx.witnesses().into_iter().collect();
    ws[1] = Bytes::from_static(b"tamper").pack();
    let tampered = tx.as_advanced_builder().set_witnesses(ws).build();
    assert_error_code(&verify(&context, &tampered).unwrap_err(), ERR_RECIPIENT_SIG);
}

#[test]
fn adv_malformed_witness_and_args_never_succeed() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 500, 0, 1);
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, args_for(&owner, &recipient, deadline), 0x01, &recipient, mature);
    // Truncated / garbage witness bytes (not even valid WitnessArgs molecule).
    for garbage in [vec![], vec![0xff; 3], vec![0u8; 100]] {
        let bad = tx
            .as_advanced_builder()
            .set_witnesses(vec![Bytes::from(garbage).pack()])
            .build();
        let err = verify(&context, &bad).unwrap_err();
        assert!(err.to_string().contains("error code"), "{err}");
    }
    // Empty args.
    let mut context = Context::default();
    let tx = build_signed_tx(&mut context, Bytes::new(), 0x00, &owner, 0);
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_ARGS_LEN);
}

// ── Typed-cell recipient refund rule (docs/spec.md §5) ───────────────────────
//
// On the recipient's claim, a plain CKB input is taken in full, but the
// capacity of every *typed* input in the group must be refunded to outputs
// locked to `owner_lock_hash`. These tests use an always-success type script
// to stand in for a UDT (the lock never inspects the type script itself, only
// whether the cell has one and how much capacity it holds). ckb-testtool runs
// the scripts but not consensus's capacity-conservation check, so output
// capacities can be set freely to isolate the refund rule.

use ckb_testtool::builtin::ALWAYS_SUCCESS;

const ERR_INSUFFICIENT_OWNER_REFUND: i8 = 16;

/// A Tranfr-locked input to a recipient claim. `typed` gives it an
/// always-success type script (a stand-in UDT); `capacity` is in shannons but
/// its absolute value is arbitrary here since balance isn't verified.
struct ClaimInput {
    since: u64,
    typed: bool,
    capacity: u64,
}

/// An output of a recipient claim, locked to `lock`. `typed` carries the same
/// always-success type script (the recipient's token cell).
struct ClaimOutput {
    lock: Script,
    typed: bool,
    capacity: u64,
    data: Bytes,
}

/// Builds and signs a RECIPIENT-mode claim with arbitrary typed/plain inputs
/// (all sharing the one Tranfr lock, so one script group) and arbitrary
/// outputs. Signs the real sighash_all message with `recipient`, exactly as
/// `build_signed_tx_multi` does, then lets `complete_tx` wire in the Tranfr
/// and always-success cell deps.
fn build_signed_claim(
    context: &mut Context,
    args: Bytes,
    recipient: &SigningKey,
    inputs: &[ClaimInput],
    outputs: &[ClaimOutput],
) -> ckb_testtool::ckb_types::core::TransactionView {
    let placeholder = |sig: [u8; 65]| {
        let mut lock = vec![0x01u8]; // RECIPIENT mode
        lock.extend_from_slice(&sig);
        make_witness(Some(Bytes::from(lock)))
    };
    let out_point = context.deploy_cell_by_name("tranfr-lock");
    let lock_script = context.build_script(&out_point, args).expect("script");
    let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let type_script = context
        .build_script(&always, Bytes::from_static(b"udt"))
        .expect("type script");

    let mut builder = TransactionBuilder::default();
    for inp in inputs {
        let mut co = CellOutput::new_builder()
            .capacity(inp.capacity)
            .lock(lock_script.clone());
        if inp.typed {
            co = co.type_(Some(type_script.clone()).pack());
        }
        let input_out_point = context.create_cell(co.build(), Bytes::new());
        builder = builder.input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .since(Pack::<Uint64>::pack(&inp.since))
                .build(),
        );
    }
    for out in outputs {
        let mut co = CellOutput::new_builder()
            .capacity(out.capacity)
            .lock(out.lock.clone());
        if out.typed {
            co = co.type_(Some(type_script.clone()).pack());
        }
        builder = builder
            .output(co.build())
            .output_data(out.data.pack());
    }
    let tx = builder
        .witness(placeholder([0u8; 65]).pack())
        .witnesses((1..inputs.len()).map(|_| Bytes::new().pack()))
        .build();
    let tx = context.complete_tx(tx);

    let zeroed = make_witness(Some(Bytes::from(vec![0u8; 66])));
    let mut hasher = new_blake2b();
    hasher.update(tx.hash().as_slice());
    hasher.update(&(zeroed.len() as u64).to_le_bytes());
    hasher.update(&zeroed);
    for _ in 1..inputs.len() {
        hasher.update(&0u64.to_le_bytes());
    }
    let mut message = [0u8; 32];
    hasher.finalize(&mut message);

    let (sig, recid) = recipient.sign_prehash_recoverable(&message);
    let mut sig_bytes = [0u8; 65];
    sig_bytes[0..64].copy_from_slice(&sig.to_bytes());
    sig_bytes[64] = recid.to_byte();
    tx.as_advanced_builder()
        .set_witnesses(
            std::iter::once(placeholder(sig_bytes).pack())
                .chain((1..inputs.len()).map(|_| Bytes::new().pack()))
                .collect(),
        )
        .build()
}

fn token(n: u8) -> Bytes {
    Bytes::from(vec![n; 16]) // 16-byte little-endian UDT amount, value irrelevant to the lock
}

#[test]
fn recipient_typed_claim_with_no_refund_fails() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 200, 0, 1);
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let recipient_lock = secp256k1_script_of(&recipient);
    // A typed input, but the whole cell (tokens and capacity) goes to the
    // recipient — nothing is refunded to the owner.
    let tx = build_signed_claim(
        &mut context,
        args,
        &recipient,
        &[ClaimInput { since: mature, typed: true, capacity: 300 }],
        &[ClaimOutput { lock: recipient_lock, typed: true, capacity: 300, data: token(1) }],
    );
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_INSUFFICIENT_OWNER_REFUND);
}

#[test]
fn recipient_typed_claim_with_underpaid_refund_fails() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 200, 0, 1);
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let owner_lock = secp256k1_script_of(&owner);
    let recipient_lock = secp256k1_script_of(&recipient);
    // Refunds only 299 of the 300 typed capacity to the owner.
    let tx = build_signed_claim(
        &mut context,
        args,
        &recipient,
        &[ClaimInput { since: mature, typed: true, capacity: 300 }],
        &[
            ClaimOutput { lock: owner_lock, typed: false, capacity: 299, data: Bytes::new() },
            ClaimOutput { lock: recipient_lock, typed: true, capacity: 142, data: token(1) },
        ],
    );
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_INSUFFICIENT_OWNER_REFUND);
}

#[test]
fn recipient_typed_claim_with_full_refund_passes() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 200, 0, 1);
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let owner_lock = secp256k1_script_of(&owner);
    let recipient_lock = secp256k1_script_of(&recipient);
    // The full 300 of typed capacity returns to the owner as plain CKB; the
    // recipient takes the tokens in a separately-funded token cell.
    let tx = build_signed_claim(
        &mut context,
        args,
        &recipient,
        &[ClaimInput { since: mature, typed: true, capacity: 300 }],
        &[
            ClaimOutput { lock: owner_lock, typed: false, capacity: 300, data: Bytes::new() },
            ClaimOutput { lock: recipient_lock, typed: true, capacity: 142, data: token(1) },
        ],
    );
    verify(&context, &tx).expect("full owner refund should pass");
}

#[test]
fn recipient_plain_claim_unaffected_by_refund_rule() {
    // A plain CKB cell (no type script) is still taken in full by the
    // recipient, with no owner refund — the pre-existing behaviour.
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 200, 0, 1);
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let recipient_lock = secp256k1_script_of(&recipient);
    let tx = build_signed_claim(
        &mut context,
        args,
        &recipient,
        &[ClaimInput { since: mature, typed: false, capacity: 300 }],
        &[ClaimOutput { lock: recipient_lock, typed: false, capacity: 300, data: Bytes::new() }],
    );
    verify(&context, &tx).expect("plain claim should pass with no owner refund");
}

#[test]
fn recipient_mixed_inputs_refund_only_the_typed_part() {
    // One typed input (300) and one plain input (500) in the group. Only the
    // typed 300 must go to the owner; the plain 500 is the recipient's.
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mature = since(ABS_EPOCH, 200, 0, 1);
    let args = args_for(&owner, &recipient, deadline);
    let owner_lock = secp256k1_script_of(&owner);
    let recipient_lock = secp256k1_script_of(&recipient);

    // Refunding exactly the typed part (300) to the owner passes, even though
    // the recipient keeps the plain 500.
    let mut context = Context::default();
    let tx = build_signed_claim(
        &mut context,
        args.clone(),
        &recipient,
        &[
            ClaimInput { since: mature, typed: true, capacity: 300 },
            ClaimInput { since: mature, typed: false, capacity: 500 },
        ],
        &[
            ClaimOutput { lock: owner_lock.clone(), typed: false, capacity: 300, data: Bytes::new() },
            ClaimOutput { lock: recipient_lock.clone(), typed: true, capacity: 142, data: token(1) },
            ClaimOutput { lock: recipient_lock.clone(), typed: false, capacity: 500, data: Bytes::new() },
        ],
    );
    verify(&context, &tx).expect("refunding just the typed part should pass");

    // Refunding less than the typed part (299) still fails, even though the
    // owner output is far smaller than total input capacity.
    let mut context = Context::default();
    let tx = build_signed_claim(
        &mut context,
        args,
        &recipient,
        &[
            ClaimInput { since: mature, typed: true, capacity: 300 },
            ClaimInput { since: mature, typed: false, capacity: 500 },
        ],
        &[
            ClaimOutput { lock: owner_lock, typed: false, capacity: 299, data: Bytes::new() },
            ClaimOutput { lock: recipient_lock, typed: false, capacity: 501, data: Bytes::new() },
        ],
    );
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_INSUFFICIENT_OWNER_REFUND);
}
