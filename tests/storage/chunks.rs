use storage::crypto::chunks::{
    ChunkError, Decryptor, Encryptor, FileContext, TAG_BYTES, encrypted_size_of,
};
use uuid::Uuid;

const KEY: [u8; 32] = [7u8; 32];

fn context(chunk_size: usize) -> FileContext {
    FileContext {
        tenant_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").expect("uuid"),
        file_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("uuid"),
        nonce_prefix: [1, 2, 3, 4, 5, 6, 7, 8],
        chunk_size,
    }
}

fn encrypt(plain: &[u8], context: FileContext, piece: usize) -> (Vec<u8>, u32) {
    let mut encryptor = Encryptor::new(&KEY, context).expect("encryptor");
    let mut sealed = Vec::new();
    for part in plain.chunks(piece.max(1)) {
        sealed.extend(encryptor.push(part).expect("push"));
    }
    sealed.extend(encryptor.finish().expect("finish"));
    (sealed, encryptor.chunk_count())
}

fn decrypt(
    sealed: &[u8],
    context: FileContext,
    chunk_count: u32,
    piece: usize,
) -> Result<Vec<u8>, ChunkError> {
    let mut decryptor = Decryptor::new(&KEY, context, chunk_count, sealed.len() as u64)?;
    let mut plain = Vec::new();
    for part in sealed.chunks(piece.max(1)) {
        plain.extend(decryptor.push(part)?.iter());
    }
    decryptor.finish()?;
    Ok(plain)
}

#[test]
fn round_trips_every_size_around_the_chunk_boundaries() {
    for size in [0usize, 1, 63, 64, 65, 127, 128, 129, 1000] {
        let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        for piece in [1usize, 7, 64, 500] {
            let (sealed, count) = encrypt(&plain, context(64), piece);
            assert_eq!(sealed.len() as u64, encrypted_size_of(size as u64, 64));
            assert_eq!(
                count as u64,
                (size as u64).div_ceil(64).max(1),
                "size {size}"
            );
            for read in [1usize, 13, 80, 4096] {
                assert_eq!(
                    decrypt(&sealed, context(64), count, read).expect("decrypt"),
                    plain
                );
            }
        }
    }
}

#[test]
fn an_empty_file_is_one_final_chunk_of_only_a_tag() {
    let (sealed, count) = encrypt(&[], context(64), 64);
    assert_eq!(count, 1);
    assert_eq!(sealed.len(), TAG_BYTES);
}

#[test]
fn the_same_content_encrypts_differently_with_another_nonce_prefix() {
    let plain = b"same content";
    let mut other = context(64);
    other.nonce_prefix = [9; 8];
    assert_ne!(
        encrypt(plain, context(64), 64).0,
        encrypt(plain, other, 64).0
    );
}

#[test]
fn refuses_any_changed_byte() {
    let plain = vec![42u8; 200];
    let (sealed, count) = encrypt(&plain, context(64), 64);
    for position in [0, 70, sealed.len() - 1] {
        let mut changed = sealed.clone();
        changed[position] ^= 1;
        assert!(decrypt(&changed, context(64), count, 4096).is_err());
    }
}

#[test]
fn refuses_reordered_chunks() {
    let plain: Vec<u8> = (0..200u32).map(|i| i as u8).collect();
    let (sealed, count) = encrypt(&plain, context(64), 64);
    let full = 64 + TAG_BYTES;
    let mut swapped = sealed[full..2 * full].to_vec();
    swapped.extend_from_slice(&sealed[..full]);
    swapped.extend_from_slice(&sealed[2 * full..]);
    assert!(decrypt(&swapped, context(64), count, 4096).is_err());
}

#[test]
fn refuses_a_file_cut_at_a_chunk_boundary() {
    let plain = vec![5u8; 200];
    let (sealed, _) = encrypt(&plain, context(64), 64);
    let full = 64 + TAG_BYTES;
    let cut = &sealed[..2 * full];
    assert!(decrypt(cut, context(64), 2, 4096).is_err());
}

#[test]
fn refuses_another_tenant_or_file_context() {
    let plain = b"bound to its tenant and file";
    let (sealed, count) = encrypt(plain, context(64), 64);
    let mut other_tenant = context(64);
    other_tenant.tenant_id = Uuid::new_v4();
    let mut other_file = context(64);
    other_file.file_id = Uuid::new_v4();
    assert!(decrypt(&sealed, other_tenant, count, 4096).is_err());
    assert!(decrypt(&sealed, other_file, count, 4096).is_err());
}

#[test]
fn refuses_sizes_that_do_not_match_the_chunk_count() {
    assert!(Decryptor::new(&KEY, context(64), 0, 16).is_err());
    assert!(Decryptor::new(&KEY, context(64), 1, 15).is_err());
    assert!(Decryptor::new(&KEY, context(64), 1, 64 + 17).is_err());
    assert!(Decryptor::new(&KEY, context(64), 2, 80).is_err());
}

#[test]
fn refuses_extra_data_after_the_last_chunk() {
    let (mut sealed, count) = encrypt(b"short", context(64), 64);
    let size = sealed.len() as u64;
    sealed.extend_from_slice(b"extra");
    let mut decryptor = Decryptor::new(&KEY, context(64), count, size).expect("decryptor");
    assert!(decryptor.push(&sealed).is_err());
}

#[test]
fn refuses_a_key_of_the_wrong_length() {
    assert!(Encryptor::new(&[1u8; 16], context(64)).is_err());
}
