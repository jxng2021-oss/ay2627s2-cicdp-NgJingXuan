use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use secrets::keys::{KeyProvider, MasterKeyError, SealState};
use secrets::seal::seal_manager::{
    Clock, SealAudit, SealError, SealManager, SealReason, SealSettings, no_audit, system_clock,
};
use sqlx::PgPool;

fn settings() -> SealSettings {
    SealSettings {
        unseal_timeout: Duration::from_secs(60),
        max_failed_attempts: 5,
        lockout: Duration::from_secs(60),
        drain_timeout: Duration::from_secs(1),
    }
}

async fn manager_with(
    db: &PgPool,
    settings: SealSettings,
    now: Clock,
    audit: SealAudit,
) -> SealManager {
    let manager = SealManager::new(db.clone(), settings, now, audit);
    manager.load().await.expect("load");
    manager
}

async fn manager(db: &PgPool) -> SealManager {
    manager_with(db, settings(), system_clock(), no_audit()).await
}

async fn initialise(db: &PgPool) -> Vec<String> {
    manager(db)
        .await
        .initialise()
        .await
        .expect("initialise")
        .shares
        .iter()
        .map(|share| share.to_string())
        .collect()
}

async fn unseal_with(manager: &SealManager, shares: &[&str]) -> Result<(), SealError> {
    for share in shares {
        manager.submit_share(share).await?;
    }
    Ok(())
}

fn stranger_share(number: u8) -> String {
    let mut bytes = [0u8; 33];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    bytes[32] = number;
    STANDARD.encode(bytes)
}

fn share_number(share: &str) -> u8 {
    STANDARD.decode(share).expect("base64")[32]
}

struct RecordedAudit {
    actions: Mutex<Vec<&'static str>>,
    failing: AtomicBool,
}

impl RecordedAudit {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            actions: Mutex::new(Vec::new()),
            failing: AtomicBool::new(false),
        })
    }

    fn hook(self: &Arc<Self>) -> SealAudit {
        let audit = self.clone();
        Arc::new(move |action| {
            let audit = audit.clone();
            Box::pin(async move {
                if audit.failing.load(Ordering::SeqCst) {
                    return Err(());
                }
                audit.actions.lock().expect("lock").push(action);
                Ok(())
            })
        })
    }

    fn actions(&self) -> Vec<&'static str> {
        self.actions.lock().expect("lock").clone()
    }
}

async fn seal_rows(db: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM seal_config")
        .fetch_one(db)
        .await
        .expect("count")
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn starts_uninitialised_and_refuses_everything(db: PgPool) {
    let manager = manager(&db).await;

    assert_eq!(manager.state(), SealState::Uninitialised);
    let status = manager.status();
    assert!(!status.initialised && status.sealed);
    assert_eq!(
        (status.shares, status.threshold, status.progress),
        (5, 3, 0)
    );
    assert_eq!(manager.master_key(1).err(), Some(MasterKeyError::Sealed));
    assert!(!manager.begin_request());
    assert!(matches!(
        manager.submit_share(&stranger_share(1)).await,
        Err(SealError::NotInitialised)
    ));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn initialising_makes_5_shares_and_stays_sealed(db: PgPool) {
    let manager = manager(&db).await;

    let initialised = manager.initialise().await.expect("initialise");

    assert_eq!(initialised.threshold, 3);
    assert_eq!(initialised.shares.len(), 5);
    assert!(initialised.shares.iter().all(|share| share.len() == 44));
    assert_eq!(manager.state(), SealState::Sealed);
    assert!(manager.status().initialised);
    assert_eq!(seal_rows(&db).await, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn any_3_of_the_5_shares_unseal_it(db: PgPool) {
    let shares = initialise(&db).await;

    for first in 0..5 {
        for second in first + 1..5 {
            for third in second + 1..5 {
                let manager = manager(&db).await;
                unseal_with(&manager, &[&shares[first], &shares[second], &shares[third]])
                    .await
                    .expect("unseal");
                assert_eq!(manager.state(), SealState::Unsealed);
                assert!(manager.master_key(1).is_ok());
            }
        }
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn initialising_only_works_once(db: PgPool) {
    let manager = manager(&db).await;
    manager.initialise().await.expect("initialise");

    assert!(matches!(
        manager.initialise().await,
        Err(SealError::AlreadyInitialised)
    ));
    assert!(matches!(
        self::manager(&db).await.initialise().await,
        Err(SealError::AlreadyInitialised)
    ));
    assert_eq!(seal_rows(&db).await, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn only_one_of_several_simultaneous_attempts_succeeds(db: PgPool) {
    let same = Arc::new(manager(&db).await);
    let other = Arc::new(manager(&db).await);
    let attempts = [same.clone(), same.clone(), other.clone(), other];

    let results = futures_join(attempts.iter().map(|manager| {
        let manager = manager.clone();
        tokio::spawn(async move { manager.initialise().await.is_ok() })
    }))
    .await;

    assert_eq!(results.iter().filter(|ok| **ok).count(), 1);
    assert_eq!(seal_rows(&db).await, 1);
}

async fn futures_join<T: Send + 'static>(
    tasks: impl Iterator<Item = tokio::task::JoinHandle<T>>,
) -> Vec<T> {
    let mut results = Vec::new();
    for task in tasks.collect::<Vec<_>>() {
        results.push(task.await.expect("task"));
    }
    results
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_refused_initialisation_stores_nothing_and_can_be_tried_again(db: PgPool) {
    let audit = RecordedAudit::new();
    audit.failing.store(true, Ordering::SeqCst);
    let manager = manager_with(&db, settings(), system_clock(), audit.hook()).await;

    assert!(matches!(
        manager.initialise().await,
        Err(SealError::AuditUnavailable)
    ));
    assert_eq!(seal_rows(&db).await, 0);
    assert_eq!(manager.state(), SealState::Uninitialised);

    audit.failing.store(false, Ordering::SeqCst);
    assert_eq!(manager.initialise().await.expect("initialise").threshold, 3);
    assert_eq!(audit.actions(), ["secrets.initialised"]);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_to_initialise_over_keys_from_an_earlier_setup(db: PgPool) {
    sqlx::query(
        "INSERT INTO tenant_keys (tenant_id, key_version, master_key_version, format_version, \
         nonce, ciphertext, auth_tag) VALUES (gen_random_uuid(), 1, 1, 1, $1, $2, $3)",
    )
    .bind(vec![1u8; 12])
    .bind(vec![2u8; 32])
    .bind(vec![3u8; 16])
    .execute(&db)
    .await
    .expect("insert");

    assert!(matches!(
        manager(&db).await.initialise().await,
        Err(SealError::LeftoverData)
    ));
    assert_eq!(seal_rows(&db).await, 0);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn shows_progress_and_2_shares_are_not_enough(db: PgPool) {
    let shares = initialise(&db).await;
    let manager = manager(&db).await;

    let first = manager.submit_share(&shares[0]).await.expect("share");
    let second = manager.submit_share(&shares[1]).await.expect("share");

    assert_eq!((first.status.progress, second.status.progress), (1, 2));
    assert!(second.status.sealed);
    assert_eq!(manager.state(), SealState::Sealed);
    let third = manager.submit_share(&shares[2]).await.expect("share");
    assert!(!third.status.sealed);
    assert_eq!(third.status.progress, 0);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn ignores_a_share_submitted_twice(db: PgPool) {
    let shares = initialise(&db).await;
    let manager = manager(&db).await;
    manager.submit_share(&shares[0]).await.expect("share");

    let again = manager
        .submit_share(&format!("  {}\n", shares[0]))
        .await
        .expect("share");

    assert!(again.duplicate);
    assert_eq!(again.status.progress, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_wrong_share_fails_clears_progress_and_stays_sealed(db: PgPool) {
    let shares = initialise(&db).await;
    let manager = manager(&db).await;
    manager.submit_share(&shares[0]).await.expect("share");
    manager.submit_share(&shares[1]).await.expect("share");
    let used = [share_number(&shares[0]), share_number(&shares[1])];
    let stranger = (1..=255)
        .find(|n| !used.contains(n))
        .expect("a free number");

    let error = manager
        .submit_share(&stranger_share(stranger))
        .await
        .expect_err("refused");

    assert!(matches!(error, SealError::UnsealFailed));
    assert_eq!(
        error.to_string(),
        "Unsealing failed. Progress was cleared; start again."
    );
    assert_eq!(manager.status().progress, 0);
    assert_eq!(manager.state(), SealState::Sealed);
    unseal_with(&manager, &[&shares[0], &shares[1], &shares[2]])
        .await
        .expect("unseal");
    assert_eq!(manager.state(), SealState::Unsealed);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn shares_from_another_initialisation_fail(db: PgPool) {
    let first = initialise(&db).await;
    sqlx::query("TRUNCATE seal_config")
        .execute(&db)
        .await
        .expect("truncate");
    let second = initialise(&db).await;
    let manager = manager(&db).await;

    assert!(matches!(
        unseal_with(&manager, &[&first[0], &first[1], &first[2]]).await,
        Err(SealError::UnsealFailed)
    ));
    let used = [share_number(&second[0]), share_number(&second[1])];
    let foreign = first
        .iter()
        .find(|share| !used.contains(&share_number(share)))
        .expect("a share");
    assert!(matches!(
        unseal_with(&manager, &[&second[0], &second[1], foreign]).await,
        Err(SealError::UnsealFailed)
    ));
    unseal_with(&manager, &[&second[2], &second[3], &second[4]])
        .await
        .expect("unseal");
    assert_eq!(manager.state(), SealState::Unsealed);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn rejects_a_malformed_share_without_revealing_it(db: PgPool) {
    initialise(&db).await;
    let cases = [
        "this is not a share!".to_string(),
        STANDARD.encode([1u8; 20]),
        STANDARD.encode([1u8; 40]),
        String::new(),
        STANDARD.encode([0u8; 33]),
        format!("{}=", STANDARD.encode([1u8; 33])),
    ];

    for text in cases {
        let fresh = manager(&db).await;
        let error = fresh.submit_share(&text).await.expect_err("refused");
        assert!(matches!(error, SealError::InvalidShare));
        if !text.is_empty() {
            assert!(!error.to_string().contains(&text));
        }
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn rejects_a_different_share_with_a_number_already_submitted(db: PgPool) {
    let shares = initialise(&db).await;
    let manager = manager(&db).await;
    manager.submit_share(&shares[0]).await.expect("share");

    let result = manager
        .submit_share(&stranger_share(share_number(&shares[0])))
        .await;

    assert!(matches!(result, Err(SealError::InvalidShare)));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn forgets_partial_progress_after_the_timeout(db: PgPool) {
    let shares = initialise(&db).await;
    let short = SealSettings {
        unseal_timeout: Duration::from_millis(50),
        ..settings()
    };
    let manager = manager_with(&db, short, system_clock(), no_audit()).await;
    manager.submit_share(&shares[0]).await.expect("share");
    manager.submit_share(&shares[1]).await.expect("share");

    tokio::time::sleep(Duration::from_millis(150)).await;

    assert_eq!(manager.status().progress, 0);
    let next = manager.submit_share(&shares[2]).await.expect("share");
    assert_eq!(next.status.progress, 1);
    assert!(next.status.sealed);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn limits_failed_attempts_with_a_lockout_then_works_again(db: PgPool) {
    let shares = initialise(&db).await;
    let now = Arc::new(AtomicU64::new(1_000_000));
    let clock_now = now.clone();
    let clock: Clock = Arc::new(move || Duration::from_millis(clock_now.load(Ordering::SeqCst)));
    let strict = SealSettings {
        max_failed_attempts: 3,
        lockout: Duration::from_secs(60),
        ..settings()
    };
    let manager = manager_with(&db, strict, clock, no_audit()).await;

    for _ in 0..3 {
        assert!(matches!(
            manager.submit_share("bad").await,
            Err(SealError::InvalidShare)
        ));
    }
    let locked = manager.submit_share(&shares[0]).await;
    assert!(matches!(
        locked,
        Err(SealError::TooManyAttempts {
            retry_after_seconds: 60
        })
    ));

    now.fetch_add(60_001, Ordering::SeqCst);
    unseal_with(&manager, &[&shares[0], &shares[1], &shares[2]])
        .await
        .expect("unseal");
    assert_eq!(manager.state(), SealState::Unsealed);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn failed_unseals_count_towards_the_limit(db: PgPool) {
    initialise(&db).await;
    let strict = SealSettings {
        max_failed_attempts: 2,
        ..settings()
    };
    let manager = manager_with(&db, strict, system_clock(), no_audit()).await;

    for _ in 0..2 {
        let result = unseal_with(
            &manager,
            &[&stranger_share(1), &stranger_share(2), &stranger_share(3)],
        )
        .await;
        assert!(matches!(result, Err(SealError::UnsealFailed)));
    }

    assert!(matches!(
        manager.submit_share(&stranger_share(4)).await,
        Err(SealError::TooManyAttempts { .. })
    ));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn sealing_refuses_new_requests_at_once_waits_for_running_ones_then_wipes_the_key(
    db: PgPool,
) {
    let shares = initialise(&db).await;
    let manager = Arc::new(manager(&db).await);
    unseal_with(&manager, &[&shares[0], &shares[1], &shares[2]])
        .await
        .expect("unseal");
    assert!(manager.begin_request());

    let sealing = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.seal(SealReason::Operator).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(!manager.begin_request());
    assert_eq!(manager.state(), SealState::Sealed);
    assert!(manager.master_key(1).is_ok());
    assert!(!sealing.is_finished());

    manager.end_request();
    sealing.await.expect("task").expect("seal");
    assert_eq!(manager.master_key(1).err(), Some(MasterKeyError::Sealed));
    assert_eq!(manager.state(), SealState::Sealed);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn sealing_gives_up_waiting_after_the_drain_timeout(db: PgPool) {
    let shares = initialise(&db).await;
    let quick = SealSettings {
        drain_timeout: Duration::from_millis(100),
        ..settings()
    };
    let manager = manager_with(&db, quick, system_clock(), no_audit()).await;
    unseal_with(&manager, &[&shares[0], &shares[1], &shares[2]])
        .await
        .expect("unseal");
    assert!(manager.begin_request());

    tokio::time::timeout(Duration::from_secs(2), manager.seal(SealReason::Operator))
        .await
        .expect("finishes after the drain timeout")
        .expect("seal");

    assert_eq!(manager.master_key(1).err(), Some(MasterKeyError::Sealed));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn seal_changes_are_audited_first_and_refused_if_they_cant_be(db: PgPool) {
    let audit = RecordedAudit::new();
    let shares = initialise(&db).await;
    let manager = manager_with(&db, settings(), system_clock(), audit.hook()).await;

    audit.failing.store(true, Ordering::SeqCst);
    assert!(matches!(
        unseal_with(&manager, &[&shares[0], &shares[1], &shares[2]]).await,
        Err(SealError::AuditUnavailable)
    ));
    assert_eq!(manager.state(), SealState::Sealed);

    audit.failing.store(false, Ordering::SeqCst);
    unseal_with(&manager, &[&shares[0], &shares[1], &shares[2]])
        .await
        .expect("unseal");
    audit.failing.store(true, Ordering::SeqCst);
    assert!(matches!(
        manager.seal(SealReason::Operator).await,
        Err(SealError::AuditUnavailable)
    ));
    assert_eq!(manager.state(), SealState::Unsealed);

    audit.failing.store(false, Ordering::SeqCst);
    manager.seal(SealReason::Operator).await.expect("seal");
    unseal_with(&manager, &[&shares[2], &shares[3], &shares[4]])
        .await
        .expect("unseal");
    manager.seal(SealReason::Shutdown).await.expect("seal");
    assert_eq!(
        audit.actions(),
        ["secrets.unsealed", "secrets.sealed", "secrets.unsealed"]
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn the_database_alone_cant_decrypt_anything(db: PgPool) {
    let shares = initialise(&db).await;
    let unsealed = manager(&db).await;
    unseal_with(&unsealed, &[&shares[0], &shares[1], &shares[2]])
        .await
        .expect("unseal");
    let master_key = unsealed.master_key(1).expect("key");

    let restarted = manager(&db).await;
    assert_eq!(restarted.state(), SealState::Sealed);
    assert_eq!(restarted.master_key(1).err(), Some(MasterKeyError::Sealed));

    let stored: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT nonce || ciphertext || auth_tag || convert_to(seal_id::text, 'UTF8') FROM seal_config",
    )
    .fetch_all(&db)
    .await
    .expect("stored");
    let bytes = stored.concat();
    assert!(
        !bytes
            .windows(32)
            .any(|window| window == master_key.as_ref())
    );
    for share in &shares {
        let share = STANDARD.decode(share).expect("base64");
        assert!(!bytes.windows(32).any(|window| window == &share[..32]));
    }
    assert_eq!(
        unsealed.master_key(2).err(),
        Some(MasterKeyError::UnknownVersion)
    );
}
