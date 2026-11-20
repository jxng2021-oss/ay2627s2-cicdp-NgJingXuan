use std::collections::HashMap;
use std::time::Duration;

use storage::config::Config;

const TOKEN: &str = "a-token-that-is-at-least-32-characters-long";

fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = [
        ("DATABASE_URL", "postgres://storage@db/storage"),
        ("INTERNAL_SERVICE_TOKEN", TOKEN),
        ("AUDIT_TOKEN", TOKEN),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    for (key, value) in pairs {
        map.insert(key.to_string(), value.to_string());
    }
    map
}

fn load(pairs: &[(&str, &str)]) -> Result<Config, String> {
    let map = vars(pairs);
    Config::from_vars(|name| map.get(name).cloned())
}

#[test]
fn uses_safe_defaults() {
    let config = load(&[]).expect("config");
    assert_eq!(config.port, 3001);
    assert_eq!(config.max_upload_bytes, 1024 * 1024 * 1024);
    assert_eq!(config.quota_bytes, 5 * 1024 * 1024 * 1024);
    assert_eq!(config.secrets_url, "http://localhost:3002");
    assert_eq!(config.audit_timeout, Duration::from_millis(2000));
    assert_eq!(config.version, "dev");
}

#[test]
fn reads_settings_from_the_environment() {
    let config = load(&[
        ("STORAGE_PORT", "4001"),
        ("MAX_UPLOAD_BYTES", "10"),
        ("DATA_DIR", "/data"),
    ])
    .expect("config");
    assert_eq!(config.port, 4001);
    assert_eq!(config.max_upload_bytes, 10);
    assert_eq!(config.data_dir.to_string_lossy(), "/data");
}

#[test]
fn requires_the_database_and_both_tokens() {
    for name in ["DATABASE_URL", "INTERNAL_SERVICE_TOKEN", "AUDIT_TOKEN"] {
        let error = load(&[(name, "")]).expect_err("must fail");
        assert!(error.contains(name), "{error}");
    }
}

#[test]
fn refuses_short_tokens() {
    let error = load(&[("INTERNAL_SERVICE_TOKEN", "short")]).expect_err("must fail");
    assert!(error.contains("at least 32 characters"));
}

#[test]
fn refuses_numbers_that_are_not_positive() {
    for value in ["0", "-5", "ten"] {
        assert!(load(&[("MAX_UPLOAD_BYTES", value)]).is_err(), "{value}");
    }
    assert!(load(&[("STORAGE_PORT", "70000")]).is_err());
}
