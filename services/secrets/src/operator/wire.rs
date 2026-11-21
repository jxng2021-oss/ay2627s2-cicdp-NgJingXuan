use serde_json::Value;

use crate::operator::cli::Reply;

pub fn parse_response(raw: &[u8]) -> Result<Reply, String> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("the operator socket sent an incomplete answer")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|status_line| status_line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("the operator socket sent an unreadable answer")?;
    let chunked = lines.any(|header| {
        let header = header.to_ascii_lowercase();
        header.starts_with("transfer-encoding:") && header.contains("chunked")
    });
    let rest = &raw[split + 4..];
    let body = if chunked {
        dechunk(rest)?
    } else {
        rest.to_vec()
    };
    Ok(Reply {
        status,
        body: serde_json::from_slice(&body).unwrap_or(Value::Object(serde_json::Map::new())),
    })
}

fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let end = rest
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("bad chunked answer")?;
        let size_text = String::from_utf8_lossy(&rest[..end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "bad chunked answer")?;
        rest = &rest[end + 2..];
        if size == 0 {
            return Ok(body);
        }
        if rest.len() < size + 2 {
            return Err("bad chunked answer".to_string());
        }
        body.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}
