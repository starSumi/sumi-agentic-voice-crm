//! Rust-owned wire contract for the runtime supervisor.
//!
//! This module is the only semantic source for the supervisor protocol. The
//! schema and TypeScript projections are generated from these types by the
//! `generate-runtime-supervisor-protocol` binary.

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema, schema_for};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use ts_rs::TS;

pub const PROTOCOL_VERSION: &str = "sumi.runtime.supervisor.v2";
pub const EXTENSION_READY_FRAME: &[u8] = b"sumi.runtime.extension.ready.v1";
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_EXTENSION_ID_BYTES: usize = 128;
pub const MAX_PROGRAM_BYTES: usize = 4096;
pub const MAX_ARGUMENTS: usize = 64;
pub const MAX_ARGUMENT_BYTES: usize = 4096;
pub const MAX_ENVIRONMENT_KEYS: usize = 32;
pub const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8192;
pub const MAX_GRACE_MS: u64 = 30_000;
pub const MAX_ERROR_MESSAGE_BYTES: usize = 512;

pub const PARSE_ERROR: i32 = -32_700;
pub const INVALID_REQUEST: i32 = -32_600;
pub const METHOD_NOT_FOUND: i32 = -32_601;
pub const INVALID_PARAMS: i32 = -32_602;
pub const INTERNAL_ERROR: i32 = -32_603;
pub const APPLICATION_ERROR: i32 = -32_000;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[ts(type = "\"2.0\"")]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Clone, Debug, Eq, JsonSchema, PartialEq, TS)]
#[schemars(schema_with = "json_rpc_id_schema")]
#[ts(type = "string | number")]
pub enum JsonRpcId {
    String(String),
    Number(i64),
}

fn json_rpc_id_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "anyOf": [
            { "type": "string" },
            { "type": "integer", "format": "int64" }
        ]
    })
}

impl Serialize for JsonRpcId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::String(value) => serializer.serialize_str(value),
            Self::Number(value) => serializer.serialize_i64(*value),
        }
    }
}

impl<'de> Deserialize<'de> for JsonRpcId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct IdVisitor;
        impl<'de> Visitor<'de> for IdVisitor {
            type Value = JsonRpcId;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON-RPC string or integer id")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(JsonRpcId::String(value.to_owned()))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(JsonRpcId::String(value))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(JsonRpcId::Number(value))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                i64::try_from(value)
                    .map(JsonRpcId::Number)
                    .map_err(|_| E::custom("JSON-RPC id exceeds signed integer range"))
            }
        }
        deserializer.deserialize_any(IdVisitor)
    }
}

impl JsonRpcId {
    pub fn as_string(&self) -> String {
        match self {
            Self::String(value) => value.clone(),
            Self::Number(value) => value.to_string(),
        }
    }

    pub fn valid(&self) -> bool {
        match self {
            Self::String(value) => !value.is_empty() && value.len() <= MAX_REQUEST_ID_BYTES,
            Self::Number(_) => true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorState {
    #[default]
    Created,
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct StartParams {
    #[schemars(
        length(min = 1, max = 128),
        pattern(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
    )]
    pub extension_id: String,
    #[schemars(length(min = 1, max = 4096), pattern(r"^/"))]
    pub program: String,
    #[schemars(length(max = 64), inner(length(max = 4096)))]
    pub args: Vec<String>,
    #[schemars(length(max = 32), inner(length(max = 8192)))]
    pub env: BTreeMap<String, String>,
    #[ts(type = "number")]
    #[schemars(range(min = 1, max = 30000))]
    pub startup_timeout_ms: u64,
    #[ts(type = "number")]
    #[schemars(range(min = 1, max = 30000))]
    pub shutdown_grace_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[ts(type = "Record<string, never>")]
pub struct EmptyParams {}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "method")]
#[schemars(deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "runtime.start")]
    Start {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcId,
        params: StartParams,
    },
    #[serde(rename = "runtime.health")]
    Health {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcId,
        params: EmptyParams,
    },
    #[serde(rename = "runtime.stop")]
    Stop {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcId,
        params: EmptyParams,
    },
}

impl Request {
    pub fn id(&self) -> &JsonRpcId {
        match self {
            Self::Start { id, .. } | Self::Health { id, .. } | Self::Stop { id, .. } => id,
        }
    }

    pub fn method(&self) -> &'static str {
        match self {
            Self::Start { .. } => "runtime.start",
            Self::Health { .. } => "runtime.health",
            Self::Stop { .. } => "runtime.stop",
        }
    }

    pub fn params(&self) -> RequestParams<'_> {
        match self {
            Self::Start { params, .. } => RequestParams::Start(params),
            Self::Health { params, .. } => RequestParams::Empty(params),
            Self::Stop { params, .. } => RequestParams::Empty(params),
        }
    }
}

pub enum RequestParams<'a> {
    Start(&'a StartParams),
    Empty(&'a EmptyParams),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct ResultPayload {
    pub state: SupervisorState,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub child_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub forced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signal: Option<i32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct ErrorData {
    pub state: SupervisorState,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<ErrorData>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(untagged)]
#[schemars(deny_unknown_fields)]
pub enum Response {
    Result {
        jsonrpc: JsonRpcVersion,
        id: Option<JsonRpcId>,
        result: ResultPayload,
    },
    Error {
        jsonrpc: JsonRpcVersion,
        id: Option<JsonRpcId>,
        error: ErrorObject,
    },
}

impl Response {
    pub fn success(id: JsonRpcId, result: ResultPayload) -> Self {
        Self::Result {
            jsonrpc: JsonRpcVersion::V2,
            id: Some(id),
            result,
        }
    }

    pub fn error(
        id: Option<JsonRpcId>,
        code: i32,
        message: impl Into<String>,
        state: SupervisorState,
    ) -> Self {
        let message = message.into();
        Self::Error {
            jsonrpc: JsonRpcVersion::V2,
            id,
            error: ErrorObject {
                code,
                message: message.chars().take(MAX_ERROR_MESSAGE_BYTES).collect(),
                data: Some(ErrorData {
                    state,
                    detail: None,
                }),
            },
        }
    }

    pub fn id(&self) -> Option<&JsonRpcId> {
        match self {
            Self::Result { id, .. } | Self::Error { id, .. } => id.as_ref(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(untagged)]
pub enum WireMessage {
    Request(Request),
    Response(Response),
}

/// Generate the schema and TypeScript projections from this module.
pub fn generate_outputs(output_root: &Path) -> io::Result<()> {
    let mut schema = serde_json::to_value(schema_for!(WireMessage)).map_err(io::Error::other)?;
    if let Some(root) = schema.as_object_mut() {
        root.insert(
            "$schema".to_owned(),
            serde_json::Value::String("https://json-schema.org/draft/2020-12/schema".to_owned()),
        );
        root.insert(
            "$id".to_owned(),
            serde_json::Value::String(
                "https://schemas.sumi.dev/runtime/supervisor-v2.json".to_owned(),
            ),
        );
        root.insert(
            "title".to_owned(),
            serde_json::Value::String("Sumi Runtime Supervisor JSON-RPC 2.0 Protocol".to_owned()),
        );
        root.insert(
            "description".to_owned(),
            serde_json::Value::String("Rust-owned NDJSON/stream message contract. The extension readiness frame is a separate lifecycle line.".to_owned()),
        );
    }
    let schema_path = output_root.join("contracts/runtime-supervisor.schema.json");
    write_json(&schema_path, &schema)?;

    let config = ts_rs::Config::default();
    let declarations = [
        JsonRpcVersion::decl(&config),
        JsonRpcId::decl(&config),
        SupervisorState::decl(&config),
        StartParams::decl(&config),
        EmptyParams::decl(&config),
        Request::decl(&config),
        ResultPayload::decl(&config),
        ErrorData::decl(&config),
        ErrorObject::decl(&config),
        Response::decl(&config),
        WireMessage::decl(&config),
    ]
    .join("\n\n")
    .lines()
    .map(|line| {
        if line.starts_with("type ") {
            format!("export {line}")
        } else {
            line.to_owned()
        }
    })
    .collect::<Vec<_>>()
    .join("\n");
    let ts = format!(
        "// Generated by Rust schemars + ts-rs from crates/runtime-supervisor/src/protocol.rs. Do not edit.\n\nexport const RUST_SUPERVISOR_PROTOCOL_VERSION = {PROTOCOL_VERSION:?} as const;\nexport const JSONRPC_VERSION = \"2.0\" as const;\nexport const EXTENSION_READY_FRAME = \"sumi.runtime.extension.ready.v1\" as const;\nexport const RUST_SUPERVISOR_LIMITS = Object.freeze({{\n  maxFrameBytes: {MAX_FRAME_BYTES},\n  requestIdMax: {MAX_REQUEST_ID_BYTES},\n  extensionIdMax: {MAX_EXTENSION_ID_BYTES},\n  programMax: {MAX_PROGRAM_BYTES},\n  argsMax: {MAX_ARGUMENTS},\n  argumentMax: {MAX_ARGUMENT_BYTES},\n  environmentKeysMax: {MAX_ENVIRONMENT_KEYS},\n  environmentValueMax: {MAX_ENVIRONMENT_VALUE_BYTES},\n  timeoutMax: {MAX_GRACE_MS},\n  errorMessageMax: {MAX_ERROR_MESSAGE_BYTES},\n}});\n\n{declarations}\nexport type SupervisorRequest = Request;\nexport type SupervisorResponse = Response;\nexport type SupervisorStartParams = StartParams;\n"
    );
    let ts_path = output_root.join("src/extensions/generated/runtime-supervisor-protocol.ts");
    write_text(&ts_path, &ts)
}

fn write_json(path: &Path, value: &serde_json::Value) -> io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    write_text(path, &format!("{text}\n"))
}

fn write_text(path: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_request() -> Request {
        serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":"start-1","method":"runtime.start","params":{"extension_id":"fixture.health","program":"/usr/bin/node","args":[],"env":{},"startup_timeout_ms":1000,"shutdown_grace_ms":1000}}"#,
        )
        .expect("valid start request")
    }

    #[test]
    fn ids_round_trip_as_string_and_number() {
        assert_eq!(start_request().id().as_string(), "start-1");
        let numeric: Request = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":7,"method":"runtime.health","params":{}}"#,
        )
        .expect("valid numeric id");
        assert_eq!(numeric.id().as_string(), "7");
    }

    #[test]
    fn request_methods_are_explicit() {
        assert_eq!(start_request().method(), "runtime.start");
    }

    #[test]
    fn generated_projections_are_deterministic() {
        let first =
            std::env::temp_dir().join(format!("sumi-protocol-first-{}", std::process::id()));
        let second =
            std::env::temp_dir().join(format!("sumi-protocol-second-{}", std::process::id()));
        generate_outputs(&first).expect("first projection");
        generate_outputs(&second).expect("second projection");
        let schema_a = std::fs::read(first.join("contracts/runtime-supervisor.schema.json"))
            .expect("first schema");
        let schema_b = std::fs::read(second.join("contracts/runtime-supervisor.schema.json"))
            .expect("second schema");
        let ts_a =
            std::fs::read(first.join("src/extensions/generated/runtime-supervisor-protocol.ts"))
                .expect("first TypeScript projection");
        let ts_b =
            std::fs::read(second.join("src/extensions/generated/runtime-supervisor-protocol.ts"))
                .expect("second TypeScript projection");
        assert_eq!(schema_a, schema_b);
        assert_eq!(ts_a, ts_b);
        let _ = std::fs::remove_dir_all(first);
        let _ = std::fs::remove_dir_all(second);
    }
}
