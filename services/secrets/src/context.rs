use std::net::IpAddr;

use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: String,
    pub tenant_id: Uuid,
    pub actor_id: Option<Uuid>,
    pub actor_type: &'static str,
    pub client_ip: Option<IpAddr>,
}

pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

pub fn is_secret_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    let allowed = |byte: &u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-');
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(allowed)
}

pub fn is_base64_of_length(text: &str, characters_before_padding: usize) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == characters_before_padding + 1
        && bytes[characters_before_padding] == b'='
        && bytes[..characters_before_padding]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}
