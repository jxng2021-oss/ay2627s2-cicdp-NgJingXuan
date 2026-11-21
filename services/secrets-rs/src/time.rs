use chrono::{DateTime, SecondsFormat, Utc};

pub fn iso(time: &DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}
