use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

pub const SHARE_BYTES: usize = 33;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidShareError;

impl std::fmt::Display for InvalidShareError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("That isn't a valid unseal key share")
    }
}

impl std::error::Error for InvalidShareError {}

pub fn encode_share(share: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(STANDARD.encode(share))
}

fn looks_like_base64(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    let padding = text.len() - body.len();
    !body.is_empty()
        && padding <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

pub fn decode_share(text: &str) -> Result<Zeroizing<Vec<u8>>, InvalidShareError> {
    let trimmed = text.trim();
    if !looks_like_base64(trimmed) {
        return Err(InvalidShareError);
    }
    let bytes = Zeroizing::new(STANDARD.decode(trimmed).map_err(|_| InvalidShareError)?);
    let canonical = Zeroizing::new(STANDARD.encode(bytes.as_slice()));
    if bytes.len() != SHARE_BYTES || canonical.as_str() != trimmed || bytes[SHARE_BYTES - 1] == 0 {
        return Err(InvalidShareError);
    }
    Ok(bytes)
}

pub fn share_number(share: &[u8]) -> u8 {
    share.last().copied().unwrap_or(0)
}
