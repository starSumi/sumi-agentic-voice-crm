// Generated from contracts/runtime-supervisor.schema.json. Do not edit.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: &str = "sumi.runtime.supervisor.v1";
pub const EXTENSION_READY_FRAME: &[u8] = "sumi.runtime.extension.ready.v1".as_bytes();
pub const MAX_FRAME_BYTES: usize = 65536;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_EXTENSION_ID_BYTES: usize = 128;
pub const MAX_PROGRAM_BYTES: usize = 4096;
pub const MAX_ARGUMENTS: usize = 64;
pub const MAX_ARGUMENT_BYTES: usize = 4096;
pub const MAX_ENVIRONMENT_KEYS: usize = 32;
pub const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8192;
pub const MAX_GRACE_MS: u64 = 30000;
pub const MAX_ERROR_MESSAGE_BYTES: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Start {
        protocol: String,
        request_id: String,
        extension_id: String,
        program: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        startup_timeout_ms: u64,
        shutdown_grace_ms: u64,
    },
    Health {
        protocol: String,
        request_id: String,
    },
    Stop {
        protocol: String,
        request_id: String,
    },
}

impl Request {
    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::Start { request_id, .. }
            | Self::Health { request_id, .. }
            | Self::Stop { request_id, .. } => request_id,
        }
    }

    pub(crate) fn protocol(&self) -> &str {
        match self {
            Self::Start { protocol, .. }
            | Self::Health { protocol, .. }
            | Self::Stop { protocol, .. } => protocol,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorState {
    #[default]
    Created,
    Running,
    Stopped,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ProtocolError {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub(crate) protocol: &'static str,
    pub(crate) request_id: String,
    pub(crate) ok: bool,
    pub(crate) state: SupervisorState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) child_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) forced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) signal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ProtocolError>,
}
