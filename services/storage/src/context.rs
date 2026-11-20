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
