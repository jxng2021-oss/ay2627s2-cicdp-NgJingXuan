use std::collections::HashSet;

use secrets::seal::shamir::{ShamirError, combine, split};
use serde_json::Value;

fn fixture() -> Value {
    let path = format!(
        "{}/../../tests/secrets/fixtures/shamir-v1.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("readable")).expect("JSON")
}

fn subsets(count: usize, size: usize) -> Vec<Vec<usize>> {
    if size == 0 {
        return vec![Vec::new()];
    }
    (0..count)
        .flat_map(|first| {
            subsets(count - first - 1, size - 1)
                .into_iter()
                .map(move |rest| {
                    let mut group = vec![first];
                    group.extend(rest.into_iter().map(|index| index + first + 1));
                    group
                })
        })
        .collect()
}

fn pick<'a>(shares: &'a [Vec<u8>], indices: &[usize]) -> Vec<&'a [u8]> {
    indices
        .iter()
        .map(|index| shares[*index].as_slice())
        .collect()
}

fn random_secret(size: usize) -> Vec<u8> {
    let mut secret = vec![0u8; size];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut secret);
    secret
}

fn owned(shares: Vec<zeroize::Zeroizing<Vec<u8>>>) -> Vec<Vec<u8>> {
    shares.into_iter().map(|share| share.to_vec()).collect()
}

#[test]
fn combines_shares_made_by_the_audited_typescript_library() {
    let fixture = fixture();
    assert_eq!(fixture["library"], "shamir-secret-sharing 0.0.4");
    for case in fixture["cases"].as_array().expect("cases") {
        let secret = case["secretText"].as_str().expect("text").as_bytes();
        let threshold =
            usize::try_from(case["threshold"].as_u64().expect("threshold")).expect("fits");
        let shares: Vec<Vec<u8>> = case["shares"]
            .as_array()
            .expect("shares")
            .iter()
            .map(|share| hex::decode(share.as_str().expect("hex")).expect("hex"))
            .collect();
        let count = shares.len();

        let all: Vec<&[u8]> = shares.iter().map(Vec::as_slice).collect();
        assert_eq!(combine(&all).expect("combine").as_slice(), secret);

        let groups = if count <= 10 {
            subsets(count, threshold)
        } else {
            vec![
                (0..threshold).collect(),
                (count - threshold..count).collect(),
            ]
        };
        for group in groups {
            assert_eq!(
                combine(&pick(&shares, &group)).expect("combine").as_slice(),
                secret
            );
        }
    }
}

#[test]
fn any_threshold_of_the_shares_rebuilds_the_secret() {
    for (count, threshold) in [(2, 2), (5, 3), (7, 4), (10, 10)] {
        for size in [1, 2, 32, 100] {
            let secret = random_secret(size);
            let shares = owned(split(&secret, count, threshold).expect("split"));

            for group in subsets(count, threshold) {
                assert_eq!(
                    combine(&pick(&shares, &group)).expect("combine").as_slice(),
                    secret.as_slice()
                );
            }
        }
    }
    let secret = random_secret(32);
    let shares = owned(split(&secret, 255, 255).expect("split"));
    assert_eq!(
        combine(&pick(&shares, &(0..255).collect::<Vec<_>>()))
            .expect("combine")
            .as_slice(),
        secret.as_slice()
    );
}

#[test]
fn fewer_shares_than_the_threshold_do_not_rebuild_it() {
    let secret = random_secret(32);
    let shares = owned(split(&secret, 5, 3).expect("split"));

    for group in subsets(5, 2) {
        assert_ne!(
            combine(&pick(&shares, &group)).expect("combine").as_slice(),
            secret.as_slice()
        );
    }
}

#[test]
fn each_share_is_the_secret_length_plus_a_unique_non_zero_number() {
    let secret = random_secret(32);
    let shares = owned(split(&secret, 255, 3).expect("split"));

    assert!(shares.iter().all(|share| share.len() == 33));
    let numbers: HashSet<u8> = shares.iter().map(|share| share[32]).collect();
    assert_eq!(numbers.len(), 255);
    assert!(!numbers.contains(&0));
}

#[test]
fn splitting_the_same_secret_twice_gives_different_shares() {
    let secret = random_secret(32);
    let first = owned(split(&secret, 5, 3).expect("split"));
    let second = owned(split(&secret, 5, 3).expect("split"));

    assert_ne!(first, second);
    assert!(first.iter().all(|share| share[..32] != secret[..]));
}

#[test]
fn refuses_bad_split_arguments_like_the_typescript_library() {
    let cases: [(&[u8], usize, usize, &str); 6] = [
        (b"", 5, 3, "secret cannot be empty"),
        (b"x", 1, 1, "shares must be at least 2 and at most 255"),
        (b"x", 256, 3, "shares must be at least 2 and at most 255"),
        (b"x", 5, 1, "threshold must be at least 2 and at most 255"),
        (b"x", 5, 256, "threshold must be at least 2 and at most 255"),
        (b"x", 3, 5, "shares cannot be less than threshold"),
    ];
    for (secret, shares, threshold, message) in cases {
        assert_eq!(
            split(secret, shares, threshold).err(),
            Some(ShamirError(message))
        );
    }
}

#[test]
fn refuses_bad_combine_arguments_like_the_typescript_library() {
    let shares = owned(split(&random_secret(32), 5, 3).expect("split"));
    let duplicate = [
        shares[0].as_slice(),
        shares[1].as_slice(),
        shares[0].as_slice(),
    ];
    let short = [shares[0].as_slice(), &shares[1][..20]];
    let tiny = [&shares[0][..1], &shares[1][..1]];

    assert_eq!(
        combine(&[shares[0].as_slice()]).err(),
        Some(ShamirError(
            "shares must have at least 2 and at most 255 elements"
        ))
    );
    assert_eq!(
        combine(&duplicate).err(),
        Some(ShamirError(
            "shares must contain unique values but a duplicate was found"
        ))
    );
    assert_eq!(
        combine(&short).err(),
        Some(ShamirError("all shares must have the same byte length"))
    );
    assert_eq!(
        combine(&tiny).err(),
        Some(ShamirError("each share must be at least 2 bytes"))
    );
}
