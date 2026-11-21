mod common;

use std::collections::HashSet;

use common::{StaticKeyProvider, TENANT_A, TENANT_B};
use secrets::crypto::aes_gcm::{AUTH_TAG_BYTES, NONCE_BYTES, Sealed, open, seal};
use secrets::crypto::envelope::{
    EncryptedData, EnvelopeError, decode_wrapped_key, decrypt_value, encode_wrapped_key,
    encrypt_value, unwrap_file_key, unwrap_signing_key, unwrap_tenant_key, wrap_file_key,
    wrap_signing_key, wrap_tenant_key,
};
use secrets::keys::{Key, KeyProvider, SealState, random_key};

const AAD: &[u8] = b"context";
const FILE_ID: &str = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";
const POOL_ID: &str = "8b9e3c1a-2d4f-4a6b-9c8d-1e2f3a4b5c6d";

fn random_bytes(size: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; size];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    bytes
}

fn flip(bytes: &[u8]) -> Vec<u8> {
    let mut copy = bytes.to_vec();
    copy[0] ^= 0x01;
    copy
}

fn new_tenant_key(keys: &dyn KeyProvider, tenant_id: &str) -> Key {
    let wrapped = wrap_tenant_key(keys, tenant_id, 1, &random_key()).expect("wrap");
    unwrap_tenant_key(keys, tenant_id, 1, &wrapped).expect("unwrap")
}

#[test]
fn encrypts_and_decrypts_values_of_every_size() {
    for size in [0, 1, 15, 16, 17, 1000, 64 * 1024, 1024 * 1024] {
        let key = random_key();
        let plaintext = random_bytes(size);

        let sealed = seal(&key, &plaintext, AAD);

        assert_eq!(sealed.nonce.len(), NONCE_BYTES);
        assert_eq!(sealed.auth_tag.len(), AUTH_TAG_BYTES);
        assert_eq!(sealed.ciphertext.len(), size);
        assert_eq!(
            open(&key, &sealed, AAD).expect("open").as_slice(),
            plaintext.as_slice()
        );
    }
}

#[test]
fn produces_different_output_every_time_for_the_same_value() {
    let key = random_key();
    let outputs: Vec<Sealed> = (0..50).map(|_| seal(&key, b"same value", AAD)).collect();

    let nonces: HashSet<_> = outputs.iter().map(|o| o.nonce.clone()).collect();
    let ciphertexts: HashSet<_> = outputs.iter().map(|o| o.ciphertext.clone()).collect();
    assert_eq!(nonces.len(), 50);
    assert_eq!(ciphertexts.len(), 50);
}

#[test]
fn never_contains_the_plaintext() {
    let plaintext = "a very recognisable secret value ".repeat(10);
    let sealed = seal(&random_key(), plaintext.as_bytes(), AAD);

    assert!(
        !sealed
            .ciphertext
            .windows(12)
            .any(|window| window == b"recognisable")
    );
}

#[test]
fn rejects_a_changed_ciphertext_nonce_or_auth_tag() {
    let key = random_key();
    let sealed = seal(&key, b"value", AAD);
    let changed = [
        Sealed {
            ciphertext: flip(&sealed.ciphertext),
            ..sealed.clone()
        },
        Sealed {
            nonce: flip(&sealed.nonce),
            ..sealed.clone()
        },
        Sealed {
            auth_tag: flip(&sealed.auth_tag),
            ..sealed.clone()
        },
    ];

    for sealed in changed {
        assert!(open(&key, &sealed, AAD).is_err());
    }
}

#[test]
fn rejects_a_shortened_auth_tag_or_nonce() {
    let key = random_key();
    let sealed = seal(&key, b"value", AAD);
    let short_tag = Sealed {
        auth_tag: sealed.auth_tag[..12].to_vec(),
        ..sealed.clone()
    };
    let short_nonce = Sealed {
        nonce: sealed.nonce[..8].to_vec(),
        ..sealed.clone()
    };

    assert!(open(&key, &short_tag, AAD).is_err());
    assert!(open(&key, &short_nonce, AAD).is_err());
}

#[test]
fn rejects_a_different_context_or_key() {
    let key = random_key();
    let sealed = seal(&key, b"value", AAD);

    assert!(open(&key, &sealed, b"other context").is_err());
    assert!(open(&random_key(), &sealed, AAD).is_err());
}

#[test]
fn round_trips_secret_values() {
    let keys = StaticKeyProvider::random();
    let tenant_key = new_tenant_key(&keys, TENANT_A);
    let long = "x".repeat(65536);
    let values = [
        "",
        "x",
        "p@ssw0rd!",
        "multi\nline\tvalue",
        "ünïcödé \u{1F511} 秘密",
        &long,
    ];

    for value in values {
        let data = encrypt_value(&tenant_key, 1, TENANT_A, "db-password", 3, value);

        assert_eq!(data.format_version, 1);
        assert_eq!(data.key_version, 1);
        let decrypted =
            decrypt_value(&tenant_key, TENANT_A, "db-password", 3, &data).expect("decrypt");
        assert_eq!(decrypted.as_str(), value);
    }
}

#[test]
fn binds_a_tenant_key_to_its_tenant_and_key_version() {
    let keys = StaticKeyProvider::random();
    let wrapped = wrap_tenant_key(&keys, TENANT_A, 1, &random_key()).expect("wrap");

    assert!(unwrap_tenant_key(&keys, TENANT_B, 1, &wrapped).is_err());
    assert!(unwrap_tenant_key(&keys, TENANT_A, 2, &wrapped).is_err());
}

#[test]
fn refuses_a_tenant_key_wrapped_by_a_different_master_key() {
    let wrapped =
        wrap_tenant_key(&StaticKeyProvider::random(), TENANT_A, 1, &random_key()).expect("wrap");

    assert!(unwrap_tenant_key(&StaticKeyProvider::random(), TENANT_A, 1, &wrapped).is_err());
}

#[test]
fn refuses_an_unknown_master_key_version() {
    let keys = StaticKeyProvider::random();
    let wrapped = wrap_tenant_key(&keys, TENANT_A, 1, &random_key()).expect("wrap");
    let other_version = EncryptedData {
        key_version: 2,
        ..wrapped
    };

    let error = unwrap_tenant_key(&keys, TENANT_A, 1, &other_version).expect_err("refused");
    assert!(error_text(&error).contains("master key version not available"));
}

#[test]
fn refuses_to_use_the_master_key_while_sealed() {
    let keys = StaticKeyProvider::random();
    let wrapped = wrap_tenant_key(&keys, TENANT_A, 1, &random_key()).expect("wrap");
    keys.set_state(SealState::Sealed);

    assert_eq!(
        unwrap_tenant_key(&keys, TENANT_A, 1, &wrapped).err(),
        Some(EnvelopeError::Sealed)
    );
    assert_eq!(
        wrap_tenant_key(&keys, TENANT_A, 1, &random_key()).err(),
        Some(EnvelopeError::Sealed)
    );
}

#[test]
fn rejects_a_value_copied_to_another_context_while_the_original_still_decrypts() {
    let tenant_key = random_key();
    let data = encrypt_value(&tenant_key, 1, TENANT_A, "api-token", 2, "value");

    for (tenant_id, name, version) in [
        (TENANT_B, "api-token", 2),
        (TENANT_A, "other-token", 2),
        (TENANT_A, "api-token", 1),
    ] {
        assert!(decrypt_value(&tenant_key, tenant_id, name, version, &data).is_err());
    }
    let original = decrypt_value(&tenant_key, TENANT_A, "api-token", 2, &data).expect("decrypt");
    assert_eq!(original.as_str(), "value");
}

#[test]
fn rejects_changed_format_or_key_version_headers() {
    let tenant_key = random_key();
    let data = encrypt_value(&tenant_key, 1, TENANT_A, "n", 1, "v");

    let new_format = EncryptedData {
        format_version: 2,
        ..data.clone()
    };
    let error = decrypt_value(&tenant_key, TENANT_A, "n", 1, &new_format).expect_err("refused");
    assert!(error.to_string().contains("unsupported format version"));

    let other_key_version = EncryptedData {
        key_version: 2,
        ..data
    };
    assert!(decrypt_value(&tenant_key, TENANT_A, "n", 1, &other_key_version).is_err());
}

#[test]
fn binds_a_file_key_to_its_tenant_and_file() {
    let tenant_key = random_key();
    let file_key = random_key();
    let wrapped = wrap_file_key(&tenant_key, 1, TENANT_A, FILE_ID, &file_key);

    let unwrapped = unwrap_file_key(&tenant_key, TENANT_A, FILE_ID, &wrapped).expect("unwrap");
    assert_eq!(unwrapped.as_ref(), file_key.as_ref());
    assert!(unwrap_file_key(&tenant_key, TENANT_B, FILE_ID, &wrapped).is_err());
    assert!(unwrap_file_key(&tenant_key, TENANT_A, POOL_ID, &wrapped).is_err());
    assert!(unwrap_signing_key(&tenant_key, TENANT_A, FILE_ID, &wrapped).is_err());
}

#[test]
fn binds_a_signing_key_to_its_tenant_and_pool() {
    let tenant_key = random_key();
    let data_key = random_key();
    let wrapped = wrap_signing_key(&tenant_key, 1, TENANT_A, POOL_ID, &data_key);

    let unwrapped = unwrap_signing_key(&tenant_key, TENANT_A, POOL_ID, &wrapped).expect("unwrap");
    assert_eq!(unwrapped.as_ref(), data_key.as_ref());
    assert!(unwrap_signing_key(&tenant_key, TENANT_B, POOL_ID, &wrapped).is_err());
    assert!(unwrap_file_key(&tenant_key, TENANT_A, POOL_ID, &wrapped).is_err());
}

#[test]
fn encodes_a_wrapped_key_in_65_bytes_and_decodes_it_back() {
    let wrapped = wrap_file_key(&random_key(), 7, TENANT_A, FILE_ID, &random_key());

    let blob = encode_wrapped_key(&wrapped);

    assert_eq!(blob.len(), 65);
    assert_eq!(blob[0], 1);
    assert_eq!(&blob[1..5], &7u32.to_be_bytes());
    assert_eq!(decode_wrapped_key(&blob).expect("decode"), wrapped);
    assert!(decode_wrapped_key(&blob[..64]).is_err());
    assert!(decode_wrapped_key(&[blob.clone(), vec![0]].concat()).is_err());
}

fn error_text(error: &EnvelopeError) -> String {
    match error {
        EnvelopeError::Sealed => "sealed".to_string(),
        EnvelopeError::Decryption(error) => error.to_string(),
    }
}
