use std::path::PathBuf;
use std::sync::OnceLock;

use axum::http::Method;
use serde_json::{Value, json};

use super::http::Answer;

pub fn spec(file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .join(file);
    serde_json::from_str(&std::fs::read_to_string(path).expect("spec")).expect("spec json")
}

fn secrets_spec() -> &'static Value {
    static SPEC: OnceLock<Value> = OnceLock::new();
    SPEC.get_or_init(|| spec("api/internal/secrets.openapi.json"))
}

fn to_json_schema(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, inner) in map {
                if key == "nullable" || key == "example" {
                    continue;
                }
                out.insert(key.clone(), to_json_schema(inner));
            }
            if map.get("nullable") == Some(&Value::Bool(true))
                && let Some(Value::String(kind)) = map.get("type")
            {
                out.insert("type".into(), json!([kind, "null"]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(to_json_schema).collect()),
        other => other.clone(),
    }
}

pub fn check(method: &Method, route: &str, answer: &Answer) {
    let spec = secrets_spec();
    let path = route.replace(":name", "{name}");
    let method = method.as_str().to_ascii_lowercase();
    let status = answer.status.to_string();
    let operation = &spec["paths"][&path][&method];
    assert!(
        operation.is_object(),
        "{method} {path} is not in the contract"
    );
    let response = &operation["responses"][&status];
    assert!(
        response.is_object(),
        "{method} {path} answered {status}, which the contract doesn't list: {}",
        answer.text()
    );

    if let Some(headers) = response["headers"].as_object() {
        for (name, header) in headers {
            if header["required"] == Value::Bool(true) {
                let value = answer.header(&name.to_ascii_lowercase());
                assert!(
                    value.is_some(),
                    "{method} {path} {status} is missing the {name} header"
                );
                if let (Some(allowed), Some(value)) = (header["schema"]["enum"].as_array(), value) {
                    assert!(
                        allowed.contains(&Value::String(value.clone())),
                        "{name}: {value}"
                    );
                }
            }
        }
    }

    let Some(schema) = response["content"]["application/json"]["schema"].as_object() else {
        assert!(
            answer.body.is_empty(),
            "{method} {path} {status} should have no body"
        );
        return;
    };
    let mut document = to_json_schema(&Value::Object(schema.clone()));
    if let Value::Object(map) = &mut document {
        map.insert("components".into(), to_json_schema(&spec["components"]));
    }
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&document)
        .expect("schema");
    let body = answer.json();
    let errors: Vec<String> = validator
        .iter_errors(&body)
        .map(|error| error.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "{method} {path} {status}: {errors:?} in {body}"
    );
}
