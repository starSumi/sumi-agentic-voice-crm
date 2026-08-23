#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(not(target_os = "linux"))]
compile_error!("sumi-runtime-supervisor currently requires Linux process semantics");

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

mod protocol;
pub use protocol::{
    EXTENSION_READY_FRAME, MAX_ARGUMENT_CHARS, MAX_ARGUMENTS, MAX_ENVIRONMENT_KEYS,
    MAX_ENVIRONMENT_VALUE_CHARS, MAX_FRAME_BYTES, MAX_GRACE_MS, MAX_PROGRAM_CHARS,
    MAX_REQUEST_ID_CHARS, MAX_SAFE_JSON_INTEGER, PROTOCOL_VERSION, Request, Response,
    SupervisorState,
};
use protocol::{
    INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, JsonRpcId, METHOD_NOT_FOUND, PARSE_ERROR,
    ResultPayload, StartParams, unicode_len,
};

pub fn generate_protocol_outputs(output_root: &Path) -> io::Result<()> {
    protocol::generate_outputs(output_root)
}

impl Response {
    fn success_result(id: JsonRpcId, result: ResultPayload) -> Self {
        Self::success(id, result)
    }

    fn failure_result(
        id: Option<JsonRpcId>,
        state: SupervisorState,
        code: i32,
        message: impl Into<String>,
    ) -> Self {
        Self::error(id, code, message, state)
    }
}

#[derive(Debug)]
struct ExitDetail {
    code: Option<i32>,
    signal: Option<i32>,
}

impl From<ExitStatus> for ExitDetail {
    fn from(status: ExitStatus) -> Self {
        Self {
            code: status.code(),
            signal: status.signal(),
        }
    }
}

struct OwnedChild {
    child: Child,
    process_group: Option<i32>,
    shutdown_grace: Duration,
}

const PROCESS_GROUP_POLL_INTERVAL: Duration = Duration::from_millis(10);
const PROCESS_GROUP_KILL_TIMEOUT: Duration = Duration::from_secs(1);

impl OwnedChild {
    fn spawn(
        program: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
        startup_timeout: Duration,
        shutdown_grace: Duration,
    ) -> io::Result<Self> {
        let supervisor_pid = std::process::id() as libc::pid_t;
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);

        // The child becomes its own process-group leader. PR_SET_PDEATHSIG
        // closes the supervisor-crash gap for the direct child; normal and hard
        // shutdown signal the whole child process group.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != supervisor_pid {
                    libc::_exit(125);
                }
                Ok(())
            });
        }

        let mut child = command.spawn()?;
        let process_group = child.id() as i32;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("extension stdout pipe is unavailable"))?;
        if let Err(error) = wait_for_ready(stdout, startup_timeout) {
            let _ = signal_group(process_group, libc::SIGKILL);
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self {
            child,
            process_group: Some(process_group),
            shutdown_grace,
        })
    }

    fn id(&self) -> u32 {
        self.child.id()
    }

    fn refresh(&mut self) -> io::Result<Option<ExitDetail>> {
        let Some(status) = self.child.try_wait()? else {
            return Ok(None);
        };
        let exit = status.into();
        self.kill_remaining_group()?;
        Ok(Some(exit))
    }

    fn stop(mut self) -> io::Result<(ExitDetail, bool)> {
        let process_group = self
            .process_group
            .ok_or_else(|| io::Error::other("extension process group is not owned"))?;
        signal_group(process_group, libc::SIGTERM)?;
        let deadline = Instant::now() + self.shutdown_grace;
        let mut leader_exit = None;
        while Instant::now() < deadline {
            if leader_exit.is_none() {
                leader_exit = self.child.try_wait()?.map(ExitDetail::from);
            }
            if !process_group_exists(process_group)? {
                let exit = match leader_exit {
                    Some(exit) => exit,
                    None => self.child.wait()?.into(),
                };
                self.process_group = None;
                return Ok((exit, false));
            }
            thread::sleep(PROCESS_GROUP_POLL_INTERVAL);
        }
        if leader_exit.is_none() {
            leader_exit = self.child.try_wait()?.map(ExitDetail::from);
        }
        let forced = process_group_exists(process_group)?;
        if forced {
            signal_group(process_group, libc::SIGKILL)?;
        }
        let exit = match leader_exit {
            Some(exit) => exit,
            None => self.child.wait()?.into(),
        };
        if forced
            && !wait_for_group_exit(process_group, Instant::now() + PROCESS_GROUP_KILL_TIMEOUT)?
        {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "extension process group survived SIGKILL",
            ));
        }
        self.process_group = None;
        Ok((exit, forced))
    }

    fn kill_remaining_group(&mut self) -> io::Result<()> {
        let Some(process_group) = self.process_group else {
            return Ok(());
        };
        if process_group_exists(process_group)? {
            signal_group(process_group, libc::SIGKILL)?;
            if !wait_for_group_exit(process_group, Instant::now() + PROCESS_GROUP_KILL_TIMEOUT)? {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "orphaned extension process group survived SIGKILL",
                ));
            }
        }
        self.process_group = None;
        Ok(())
    }
}

fn wait_for_ready(stdout: impl io::Read + Send + 'static, timeout: Duration) -> io::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let result = match read_frame(&mut reader) {
            Ok(Frame::Line(line)) if line == EXTENSION_READY_FRAME => Ok(()),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "extension omitted the lifecycle readiness frame",
            )),
            Err(error) => Err(error),
        };
        let _ = sender.send(result);
        let _ = io::copy(&mut reader, &mut io::sink());
    });
    receiver.recv_timeout(timeout).map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "extension lifecycle readiness timed out",
        )
    })?
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(process_group) = self.process_group {
            let _ = signal_group(process_group, libc::SIGKILL);
            let _ = self.child.wait();
            let _ = wait_for_group_exit(process_group, Instant::now() + PROCESS_GROUP_KILL_TIMEOUT);
            self.process_group = None;
        }
    }
}

fn process_group_exists(process_group: i32) -> io::Result<bool> {
    let result = unsafe { libc::kill(-process_group, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error),
    }
}

fn wait_for_group_exit(process_group: i32, deadline: Instant) -> io::Result<bool> {
    loop {
        if !process_group_exists(process_group)? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(PROCESS_GROUP_POLL_INTERVAL);
    }
}

fn signal_group(process_group: i32, signal: i32) -> io::Result<()> {
    // Negative pid targets exactly the process group created for the child.
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[derive(Default)]
pub struct Supervisor {
    state: SupervisorState,
    child: Option<OwnedChild>,
    last_exit: Option<ExitDetail>,
}

impl Supervisor {
    pub fn state(&self) -> SupervisorState {
        self.state
    }

    fn refresh(&mut self) -> io::Result<()> {
        let status = match self.child.as_mut() {
            Some(child) => child.refresh()?,
            None => None,
        };
        if let Some(status) = status {
            self.last_exit = Some(status);
            self.child = None;
            self.state = SupervisorState::Stopped;
        }
        Ok(())
    }

    pub fn handle(&mut self, request: Request) -> (Response, bool) {
        let request_id = request.id().clone();
        if let Err(message) = validate_common(&request) {
            return (
                Response::failure_result(None, self.state, INVALID_REQUEST, message),
                false,
            );
        }
        if let Err(error) = self.refresh() {
            self.state = SupervisorState::Failed;
            return (
                Response::failure_result(
                    Some(request_id),
                    self.state,
                    INTERNAL_ERROR,
                    error.to_string(),
                ),
                false,
            );
        }

        match request {
            Request::Start { id, params, .. } => {
                if self.state != SupervisorState::Created {
                    return (
                        Response::failure_result(
                            Some(id),
                            self.state,
                            protocol::APPLICATION_ERROR,
                            "start is allowed exactly once",
                        ),
                        false,
                    );
                }
                match validate_start(&params).and_then(|()| {
                    OwnedChild::spawn(
                        &params.program,
                        &params.args,
                        &params.env,
                        Duration::from_millis(params.startup_timeout_ms),
                        Duration::from_millis(params.shutdown_grace_ms),
                    )
                    .map_err(|error| error.to_string())
                }) {
                    Ok(child) => {
                        let child_pid = child.id();
                        self.child = Some(child);
                        self.state = SupervisorState::Running;
                        let result = ResultPayload {
                            state: self.state,
                            ready: Some(true),
                            child_pid: Some(child_pid),
                            forced: None,
                            exit_code: None,
                            signal: None,
                        };
                        (Response::success_result(id, result), false)
                    }
                    Err(message) => {
                        self.state = SupervisorState::Failed;
                        (
                            Response::failure_result(
                                Some(id),
                                self.state,
                                protocol::APPLICATION_ERROR,
                                message,
                            ),
                            false,
                        )
                    }
                }
            }
            Request::Health { id, .. } => {
                let result = ResultPayload {
                    state: self.state,
                    ready: Some(self.state == SupervisorState::Running),
                    child_pid: self.child.as_ref().map(OwnedChild::id),
                    forced: None,
                    exit_code: self.last_exit.as_ref().and_then(|exit| exit.code),
                    signal: self.last_exit.as_ref().and_then(|exit| exit.signal),
                };
                (Response::success_result(id, result), false)
            }
            Request::Stop { id, .. } => {
                let result = match self.child.take() {
                    Some(child) => child.stop(),
                    None => Ok((
                        self.last_exit.take().unwrap_or(ExitDetail {
                            code: Some(0),
                            signal: None,
                        }),
                        false,
                    )),
                };
                match result {
                    Ok((exit, forced)) => {
                        self.state = SupervisorState::Stopped;
                        let result = ResultPayload {
                            state: self.state,
                            ready: Some(false),
                            child_pid: None,
                            forced: Some(forced),
                            exit_code: exit.code,
                            signal: exit.signal,
                        };
                        (Response::success_result(id, result), true)
                    }
                    Err(error) => {
                        self.state = SupervisorState::Failed;
                        (
                            Response::failure_result(
                                Some(id),
                                self.state,
                                protocol::APPLICATION_ERROR,
                                error.to_string(),
                            ),
                            true,
                        )
                    }
                }
            }
        }
    }
}

fn validate_common(request: &Request) -> Result<(), String> {
    if !request.id().valid() {
        return Err("request id is invalid".to_owned());
    }
    Ok(())
}

fn validate_start(params: &StartParams) -> Result<(), String> {
    validate_identifier(&params.extension_id, true, "extension_id")?;
    if unicode_len(&params.program) > MAX_PROGRAM_CHARS || !Path::new(&params.program).is_absolute()
    {
        return Err("program must be a bounded absolute path".to_owned());
    }
    if params.args.len() > MAX_ARGUMENTS
        || params
            .args
            .iter()
            .any(|arg| unicode_len(arg) > MAX_ARGUMENT_CHARS)
    {
        return Err("args exceed the supervisor bounds".to_owned());
    }
    if params.env.len() > MAX_ENVIRONMENT_KEYS
        || params.env.iter().any(|(key, value)| {
            !valid_environment_key(key) || unicode_len(value) > MAX_ENVIRONMENT_VALUE_CHARS
        })
    {
        return Err("env exceeds the supervisor bounds".to_owned());
    }
    if !(1..=MAX_GRACE_MS).contains(&params.startup_timeout_ms)
        || !(1..=MAX_GRACE_MS).contains(&params.shutdown_grace_ms)
    {
        return Err(
            "startup_timeout_ms and shutdown_grace_ms must be between 1 and 30000".to_owned(),
        );
    }
    Ok(())
}

fn validate_identifier(value: &str, extension: bool, name: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let valid = !value.is_empty()
        && unicode_len(value)
            <= if extension {
                protocol::MAX_EXTENSION_ID_CHARS
            } else {
                MAX_REQUEST_ID_CHARS
            }
        && if extension {
            bytes[0].is_ascii_lowercase()
                && !matches!(bytes.last(), Some(b'.' | b'-'))
                && bytes.iter().enumerate().all(|(index, byte)| {
                    if matches!(byte, b'.' | b'-') {
                        index > 0 && !matches!(bytes[index - 1], b'.' | b'-')
                    } else {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit()
                    }
                })
        } else {
            bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        };
    if valid {
        Ok(())
    } else {
        Err(format!("{name} is invalid"))
    }
}

fn valid_environment_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'_'))
        && value.len() <= 64
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

enum Frame {
    Eof,
    Line(Vec<u8>),
    TooLarge,
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Frame> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() && !oversized {
                Ok(Frame::Eof)
            } else if oversized {
                Ok(Frame::TooLarge)
            } else {
                Ok(Frame::Line(line))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(available, |index| &available[..index]);
        if !oversized && line.len() + content.len() <= MAX_FRAME_BYTES {
            line.extend_from_slice(content);
        } else {
            oversized = true;
        }
        reader.consume(consumed);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return if oversized {
                Ok(Frame::TooLarge)
            } else {
                Ok(Frame::Line(line))
            };
        }
    }
}

pub fn serve(mut reader: impl BufRead, mut writer: impl Write) -> io::Result<()> {
    let mut supervisor = Supervisor::default();
    loop {
        let (response, stop) = match read_frame(&mut reader)? {
            Frame::Eof => break,
            Frame::TooLarge => (
                Response::failure_result(
                    None,
                    supervisor.state(),
                    INVALID_REQUEST,
                    "supervisor frame exceeds 65536 bytes",
                ),
                false,
            ),
            Frame::Line(line) if line.is_empty() => continue,
            Frame::Line(line) => match decode_request(&line, supervisor.state()) {
                Ok(request) => supervisor.handle(request),
                Err(response) => (response, false),
            },
        };
        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        if stop {
            break;
        }
    }
    Ok(())
}

fn decode_request(line: &[u8], state: SupervisorState) -> Result<Request, Response> {
    let value: serde_json::Value = serde_json::from_slice(line).map_err(|_| {
        Response::failure_result(
            None,
            state,
            PARSE_ERROR,
            "supervisor request is not valid JSON",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        Response::failure_result(
            None,
            state,
            INVALID_REQUEST,
            "JSON-RPC request must be an object",
        )
    })?;
    let Some(id) = parse_id(object.get("id")).filter(JsonRpcId::valid) else {
        return Err(Response::failure_result(
            None,
            state,
            INVALID_REQUEST,
            "JSON-RPC request id is required and must be a bounded string or integer",
        ));
    };
    if object.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0") {
        return Err(Response::failure_result(
            Some(id.clone()),
            state,
            INVALID_REQUEST,
            "JSON-RPC request must declare version 2.0",
        ));
    }
    let method = object
        .get("method")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            Response::failure_result(
                Some(id.clone()),
                state,
                INVALID_REQUEST,
                "JSON-RPC request method is missing",
            )
        })?;
    if !matches!(method, "runtime.start" | "runtime.health" | "runtime.stop") {
        return Err(Response::failure_result(
            Some(id.clone()),
            state,
            METHOD_NOT_FOUND,
            "runtime supervisor method was not found",
        ));
    }
    let allowed = ["jsonrpc", "id", "method", "params"];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Response::failure_result(
            Some(id.clone()),
            state,
            INVALID_REQUEST,
            "JSON-RPC request contains an unknown field",
        ));
    }
    let params = object.get("params").and_then(serde_json::Value::as_object);
    let params_valid = match (method, params) {
        ("runtime.start", Some(params)) => {
            let allowed = [
                "extension_id",
                "program",
                "args",
                "env",
                "startup_timeout_ms",
                "shutdown_grace_ms",
            ];
            allowed.iter().all(|key| params.contains_key(*key))
                && params.keys().all(|key| allowed.contains(&key.as_str()))
        }
        ("runtime.health" | "runtime.stop", Some(params)) => params.is_empty(),
        _ => false,
    };
    if !params_valid {
        return Err(Response::failure_result(
            Some(id.clone()),
            state,
            INVALID_PARAMS,
            "JSON-RPC request parameters are invalid",
        ));
    }
    serde_json::from_value(value.clone()).map_err(|_| {
        Response::failure_result(
            Some(id),
            state,
            INVALID_PARAMS,
            "JSON-RPC request parameters are invalid",
        )
    })
}

fn parse_id(value: Option<&serde_json::Value>) -> Option<JsonRpcId> {
    match value {
        Some(serde_json::Value::String(value)) => Some(JsonRpcId::String(value.clone())),
        Some(serde_json::Value::Number(value)) => value.as_i64().map(JsonRpcId::Number),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn response_values(input: impl Into<Vec<u8>>) -> Vec<serde_json::Value> {
        let mut output = Vec::new();
        serve(Cursor::new(input.into()), &mut output).expect("serve protocol fixtures");
        String::from_utf8(output)
            .expect("UTF-8 responses")
            .lines()
            .map(|line| serde_json::from_str(line).expect("JSON response"))
            .collect()
    }

    #[test]
    fn parse_error_uses_json_rpc_code() {
        let values = response_values(b"not-json\n".to_vec());
        assert_eq!(values[0]["error"]["code"], PARSE_ERROR);
        assert!(values[0]["id"].is_null());
    }

    #[test]
    fn invalid_request_and_unknown_method_are_distinct() {
        let values = response_values(
            b"[]\n{\"jsonrpc\":\"1.0\",\"id\":\"v1\",\"method\":\"runtime.health\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":\"u\",\"method\":\"runtime.health\",\"params\":{},\"extra\":true}\n{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"runtime.nope\",\"params\":{}}\n"
                .to_vec(),
        );
        assert_eq!(values[0]["error"]["code"], INVALID_REQUEST);
        assert_eq!(values[1]["error"]["code"], INVALID_REQUEST);
        assert_eq!(values[1]["id"], "v1");
        assert_eq!(values[2]["error"]["code"], INVALID_REQUEST);
        assert_eq!(values[2]["id"], "u");
        assert_eq!(values[3]["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(values[3]["id"], "x");
    }

    #[test]
    fn invalid_params_unknown_fields_and_ids_fail_closed() {
        let values = response_values(
            format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"runtime.health\",\"params\":{{\"x\":true}}}}\n{{\"jsonrpc\":\"2.0\",\"id\":\"\",\"method\":\"runtime.health\",\"params\":{{}}}}\n{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"method\":\"runtime.health\",\"params\":{{}}}}\n",
                "x".repeat(MAX_REQUEST_ID_CHARS + 1)
            )
            .into_bytes(),
        );
        assert_eq!(values[0]["error"]["code"], INVALID_PARAMS);
        assert_eq!(values[0]["id"], 7);
        assert_eq!(values[1]["error"]["code"], INVALID_REQUEST);
        assert!(values[1]["id"].is_null());
        assert_eq!(values[2]["error"]["code"], INVALID_REQUEST);
        assert!(values[2]["id"].is_null());
    }

    #[test]
    fn invalid_ids_are_never_echoed_from_early_error_branches() {
        let oversized_id = "x".repeat(MAX_REQUEST_ID_CHARS + 1);
        let inputs = [
            serde_json::json!({
                "jsonrpc": "1.0", "id": "", "method": "runtime.health", "params": {}
            }),
            serde_json::json!({"jsonrpc": "2.0", "id": oversized_id}),
            serde_json::json!({
                "jsonrpc": "2.0", "id": "", "method": "runtime.unknown", "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": "", "method": "runtime.health", "params": {},
                "unknown": true
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": "", "method": "runtime.health", "params": {"x": true}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": 1.5, "method": "runtime.health", "params": {}
            }),
        ];
        let input = inputs
            .into_iter()
            .map(|value| serde_json::to_string(&value).expect("serialize request"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let values = response_values(input.into_bytes());
        assert_eq!(values.len(), 6);
        for value in values {
            assert_eq!(value["error"]["code"], INVALID_REQUEST);
            assert!(value["id"].is_null());
        }
    }

    #[test]
    fn id_boundaries_match_unicode_and_javascript_number_semantics() {
        let exact_unicode = "界".repeat(MAX_REQUEST_ID_CHARS);
        let over_unicode = "界".repeat(MAX_REQUEST_ID_CHARS + 1);
        let input = [
            serde_json::json!({
                "jsonrpc": "2.0", "id": exact_unicode, "method": "runtime.health", "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": over_unicode, "method": "runtime.health", "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": MAX_SAFE_JSON_INTEGER, "method": "runtime.health", "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": -MAX_SAFE_JSON_INTEGER, "method": "runtime.health", "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": MAX_SAFE_JSON_INTEGER + 1, "method": "runtime.health", "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0", "id": -MAX_SAFE_JSON_INTEGER - 1, "method": "runtime.health", "params": {}
            }),
        ]
        .into_iter()
        .map(|value| serde_json::to_string(&value).expect("serialize bounded id request"))
        .collect::<Vec<_>>()
        .join("\n")
            + "\n";
        let values = response_values(input.into_bytes());
        assert_eq!(values[0]["id"], "界".repeat(MAX_REQUEST_ID_CHARS));
        assert!(values[1]["id"].is_null());
        assert_eq!(values[2]["id"], MAX_SAFE_JSON_INTEGER);
        assert_eq!(values[3]["id"], -MAX_SAFE_JSON_INTEGER);
        assert!(values[4]["id"].is_null());
        assert!(values[5]["id"].is_null());
    }

    #[test]
    fn start_string_bounds_use_unicode_code_points() {
        let mut env = BTreeMap::new();
        env.insert(
            "UNICODE".to_owned(),
            "界".repeat(MAX_ENVIRONMENT_VALUE_CHARS),
        );
        let exact = StartParams {
            extension_id: "fixture.unicode".to_owned(),
            program: format!("/{}", "界".repeat(MAX_PROGRAM_CHARS - 1)),
            args: vec!["界".repeat(MAX_ARGUMENT_CHARS)],
            env,
            startup_timeout_ms: 1_000,
            shutdown_grace_ms: 1_000,
        };
        assert_eq!(validate_start(&exact), Ok(()));

        let mut over_program = exact.clone();
        over_program.program = format!("/{}", "界".repeat(MAX_PROGRAM_CHARS));
        assert!(validate_start(&over_program).is_err());
        let mut over_argument = exact.clone();
        over_argument.args = vec!["界".repeat(MAX_ARGUMENT_CHARS + 1)];
        assert!(validate_start(&over_argument).is_err());
        let mut over_environment = exact;
        over_environment.env.insert(
            "UNICODE".to_owned(),
            "界".repeat(MAX_ENVIRONMENT_VALUE_CHARS + 1),
        );
        assert!(validate_start(&over_environment).is_err());
    }

    #[test]
    fn internal_error_is_a_json_rpc_error_with_a_required_null_id() {
        let response = Response::failure_result(
            None,
            SupervisorState::Failed,
            INTERNAL_ERROR,
            "supervisor state refresh failed",
        );
        let value = serde_json::to_value(response).expect("internal error response");
        assert_eq!(value["jsonrpc"], "2.0");
        assert!(value["id"].is_null());
        assert_eq!(value["error"]["code"], INTERNAL_ERROR);
        assert_eq!(value["error"]["data"]["state"], "failed");
    }

    #[test]
    fn oversized_frames_are_rejected_without_unbounded_allocation() {
        let input = format!(
            "{}\n{}\n{{\"jsonrpc\":\"2.0\",\"id\":\"r2\",\"method\":\"runtime.health\",\"params\":{{}}}}\n",
            "x".repeat(MAX_FRAME_BYTES),
            "x".repeat(MAX_FRAME_BYTES + 1)
        );
        let values = response_values(input.into_bytes());
        assert_eq!(values[0]["error"]["code"], PARSE_ERROR);
        assert_eq!(values[1]["error"]["code"], INVALID_REQUEST);
        assert_eq!(values[2]["id"], "r2");
        assert_eq!(values[2]["result"]["state"], "created");
    }

    #[test]
    fn health_response_is_json_rpc_result_with_created_state() {
        let values = response_values(
            b"{\"jsonrpc\":\"2.0\",\"id\":\"health-1\",\"method\":\"runtime.health\",\"params\":{}}\n"
                .to_vec(),
        );
        assert_eq!(values[0]["jsonrpc"], "2.0");
        assert_eq!(values[0]["id"], "health-1");
        assert_eq!(values[0]["result"]["state"], "created");
        assert_eq!(values[0]["result"]["ready"], false);
    }

    #[test]
    fn application_error_is_returned_for_invalid_start_program() {
        let request: Request = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":"start-1","method":"runtime.start","params":{"extension_id":"fixture.health","program":"node","args":[],"env":{},"startup_timeout_ms":1000,"shutdown_grace_ms":1000}}"#,
        )
        .expect("valid start request");
        let (response, stop) = Supervisor::default().handle(request);
        assert!(!stop);
        let value = serde_json::to_value(response).expect("JSON-RPC response");
        assert_eq!(value["error"]["code"], protocol::APPLICATION_ERROR);
        assert_eq!(value["id"], "start-1");
    }

    #[test]
    fn lifecycle_start_health_stop_is_bounded_and_cooperative() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "jsonrpc": "2.0",
            "id": "start-1",
            "method": "runtime.start",
            "params": {
                "extension_id": "fixture.health",
                "program": "/bin/sh",
                "args": ["-c", "printf 'sumi.runtime.extension.ready.v1\\n'; trap 'exit 0' TERM; sleep 5"],
                "env": {},
                "startup_timeout_ms": 1_000,
                "shutdown_grace_ms": 1_000
            }
        }))
        .expect("valid lifecycle start request");
        let mut supervisor = Supervisor::default();
        let (started, stop) = supervisor.handle(request);
        assert!(!stop);
        let started_value = serde_json::to_value(started).expect("start response");
        assert_eq!(started_value["result"]["state"], "running");

        let health: Request = serde_json::from_value(serde_json::json!({
            "jsonrpc": "2.0", "id": "health-1", "method": "runtime.health", "params": {}
        }))
        .expect("valid health request");
        let (healthy, stop) = supervisor.handle(health);
        assert!(!stop);
        assert_eq!(
            serde_json::to_value(healthy).expect("health response")["result"]["ready"],
            true
        );

        let stop_request: Request = serde_json::from_value(serde_json::json!({
            "jsonrpc": "2.0", "id": "stop-1", "method": "runtime.stop", "params": {}
        }))
        .expect("valid stop request");
        let (stopped, stop) = supervisor.handle(stop_request);
        assert!(stop);
        assert_eq!(
            serde_json::to_value(stopped).expect("stop response")["result"]["state"],
            "stopped"
        );
    }

    #[test]
    fn stop_kills_a_term_ignoring_descendant_after_the_leader_exits() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let marker = std::env::temp_dir().join(format!(
            "sumi-runtime-supervisor-{}-{nonce}.pid",
            std::process::id()
        ));
        let descendant_ready = marker.with_extension("descendant-ready");
        let leader_terminated = marker.with_extension("leader-terminated");
        let mut env = BTreeMap::new();
        env.insert(
            "DESCENDANT_PID_FILE".to_owned(),
            marker.to_string_lossy().into_owned(),
        );
        env.insert(
            "DESCENDANT_READY_FILE".to_owned(),
            descendant_ready.to_string_lossy().into_owned(),
        );
        env.insert(
            "LEADER_TERMINATED_FILE".to_owned(),
            leader_terminated.to_string_lossy().into_owned(),
        );
        let script = concat!(
            "trap 'printf terminated > \"$LEADER_TERMINATED_FILE\"; exit 0' TERM; ",
            "(trap '' TERM; printf ready > \"$DESCENDANT_READY_FILE\"; ",
            "while :; do sleep 1; done) & ",
            "descendant=$!; printf '%s' \"$descendant\" > \"$DESCENDANT_PID_FILE\"; ",
            "while [ ! -s \"$DESCENDANT_READY_FILE\" ]; do :; done; ",
            "printf 'sumi.runtime.extension.ready.v1\\n'; ",
            "while :; do sleep 1; done"
        );
        let child = OwnedChild::spawn(
            "/bin/sh",
            &["-c".to_owned(), script.to_owned()],
            &env,
            Duration::from_secs(1),
            Duration::from_millis(50),
        )
        .expect("spawn extension with descendant");
        let process_group = child.process_group.expect("owned process group");
        let descendant_pid: i32 = fs::read_to_string(&marker)
            .expect("descendant pid marker")
            .parse()
            .expect("numeric descendant pid");
        assert_ne!(descendant_pid, process_group);
        assert_eq!(unsafe { libc::getpgid(descendant_pid) }, process_group);
        assert!(process_group_exists(process_group).expect("live process group"));

        let (_, forced) = child.stop().expect("bounded group stop");
        assert!(forced);
        assert_eq!(
            fs::read_to_string(&leader_terminated).expect("leader TERM handler marker"),
            "terminated"
        );
        assert!(!process_group_exists(process_group).expect("reaped process group"));
        fs::remove_file(marker).expect("remove descendant pid marker");
        fs::remove_file(descendant_ready).expect("remove descendant ready marker");
        fs::remove_file(leader_terminated).expect("remove leader terminated marker");
    }
}
