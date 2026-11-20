use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use storage::crypto::chunks::{Decryptor, FileContext};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileKey {
    text: String,
    base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    file_key: FileKey,
    tenant_id: String,
    file_id: String,
    format_version: i16,
    chunk_size: usize,
    chunk_count: u32,
    plain_size: usize,
    encrypted_size: u64,
    nonce_prefix: String,
    checksum: String,
    expected_content: String,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/storage/fixtures")
}

fn load() -> (Fixture, Vec<u8>) {
    let json = std::fs::read_to_string(fixtures().join("compatibility-v1.json")).expect("fixture");
    let fixture: Fixture = serde_json::from_str(&json).expect("fixture json");
    let encrypted = std::fs::read(fixtures().join("compatibility-v1.bin")).expect("fixture bin");
    (fixture, encrypted)
}

#[test]
fn uses_the_fake_test_key_it_says_it_uses() {
    let (fixture, encrypted) = load();
    let key = STANDARD.decode(&fixture.file_key.base64).expect("base64");
    assert_eq!(key, fixture.file_key.text.as_bytes());
    assert!(fixture.file_key.text.starts_with("fake-test-"));
    assert_eq!(encrypted.len() as u64, fixture.encrypted_size);
    assert_eq!(fixture.format_version, 1);
}

#[test]
fn its_checksum_matches_the_encrypted_data() {
    let (fixture, encrypted) = load();
    assert_eq!(hex::encode(Sha256::digest(&encrypted)), fixture.checksum);
}

#[test]
fn decrypts_a_file_saved_by_format_version_1() {
    let (fixture, encrypted) = load();
    let key = STANDARD.decode(&fixture.file_key.base64).expect("base64");
    let nonce_prefix: [u8; 8] = hex::decode(&fixture.nonce_prefix)
        .expect("hex")
        .try_into()
        .expect("8 bytes");
    let context = FileContext {
        tenant_id: Uuid::parse_str(&fixture.tenant_id).expect("uuid"),
        file_id: Uuid::parse_str(&fixture.file_id).expect("uuid"),
        nonce_prefix,
        chunk_size: fixture.chunk_size,
    };
    let mut decryptor = Decryptor::new(&key, context, fixture.chunk_count, fixture.encrypted_size)
        .expect("decryptor");
    let mut plain = Vec::new();
    for part in encrypted.chunks(50) {
        plain.extend(decryptor.push(part).expect("chunk").iter());
    }
    decryptor.finish().expect("all chunks");
    assert_eq!(plain.len(), fixture.plain_size);
    assert_eq!(
        String::from_utf8(plain).expect("utf8"),
        fixture.expected_content
    );
}
