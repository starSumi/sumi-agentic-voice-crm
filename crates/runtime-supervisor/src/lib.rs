#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(not(target_os = "linux"))]
compile_error!("sumi-runtime-supervisor currently requires Linux process semantics");

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: &str = "sumi.runtime.supervisor.v1";
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const EXTENSION_READY_FRAME: &[u8] = b"sumi.runtime.extension.ready.v1";
const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 4096;
const MAX_ENVIRONMENT_KEYS: usize = 32;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8192;
const MAX_GRACE_MS: u64 = 30_000;

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
    fn request_id(&self) -> &str {
        match self {
            Self::Start { request_id, .. }
            | Self::Health { request_id, .. }
            | Self::Stop { request_id, .. } => request_id,
        }
    }

    fn protocol(&self) -> &str {
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
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
    protocol: &'static str,
    request_id: String,
    ok: bool,
    state: SupervisorState,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ProtocolError>,
}

impl Response {
    fn success(request_id: impl Into<String>, state: SupervisorState) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            state,
            ready: None,
            child_pid: None,
            forced: None,
            exit_code: None,
            signal: None,
            error: None,
        }
    }

    fn failure(
        request_id: impl Into<String>,
        state: SupervisorState,
        code: &str,
        message: impl Into<String>,
    ) -> Self {
        let message = message.into();
        Self {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: false,
            state,
            ready: Some(false),
            child_pid: None,
            forced: None,
            exit_code: None,
            signal: None,
            error: Some(ProtocolError {
                code: code.to_owned(),
                message: message.chars().take(512).collect(),
            }),
        }
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
    process_group: i32,
    shutdown_grace: Duration,
}

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
            process_group,
            shutdown_grace,
        })
    }

    fn id(&self) -> u32 {
        self.child.id()
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    fn stop(mut self) -> io::Result<(ExitDetail, bool)> {
        signal_group(self.process_group, libc::SIGTERM)?;
        let deadline = Instant::now() + self.shutdown_grace;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                return Ok((status.into(), false));
            }
            thread::sleep(Duration::from_millis(10));
        }
        signal_group(self.process_group, libc::SIGKILL)?;
        let status = self.child.wait()?;
        Ok((status.into(), true))
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
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = signal_group(self.process_group, libc::SIGKILL);
            let _ = self.child.wait();
        }
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
            Some(child) => child.try_wait()?,
            None => None,
        };
        if let Some(status) = status {
            self.last_exit = Some(status.into());
            self.child = None;
            self.state = SupervisorState::Stopped;
        }
        Ok(())
    }

    pub fn handle(&mut self, request: Request) -> (Response, bool) {
        let request_id = request.request_id().to_owned();
        if let Err(message) = validate_common(&request) {
            return (
                Response::failure(request_id, self.state, "INVALID_REQUEST", message),
                false,
            );
        }
        if let Err(error) = self.refresh() {
            self.state = SupervisorState::Failed;
            return (
                Response::failure(request_id, self.state, "SUPERVISOR_IO", error.to_string()),
                false,
            );
        }

        match request {
            Request::Start {
                extension_id,
                program,
                args,
                env,
                startup_timeout_ms,
                shutdown_grace_ms,
                ..
            } => {
                if self.state != SupervisorState::Created {
                    return (
                        Response::failure(
                            request_id,
                            self.state,
                            "INVALID_STATE",
                            "start is allowed exactly once",
                        ),
                        false,
                    );
                }
                match validate_start(
                    &extension_id,
                    &program,
                    &args,
                    &env,
                    startup_timeout_ms,
                    shutdown_grace_ms,
                )
                .and_then(|()| {
                    OwnedChild::spawn(
                        &program,
                        &args,
                        &env,
                        Duration::from_millis(startup_timeout_ms),
                        Duration::from_millis(shutdown_grace_ms),
                    )
                    .map_err(|error| error.to_string())
                }) {
                    Ok(child) => {
                        let child_pid = child.id();
                        self.child = Some(child);
                        self.state = SupervisorState::Running;
                        let mut response = Response::success(request_id, self.state);
                        response.ready = Some(true);
                        response.child_pid = Some(child_pid);
                        (response, false)
                    }
                    Err(message) => {
                        self.state = SupervisorState::Failed;
                        (
                            Response::failure(request_id, self.state, "START_FAILED", message),
                            false,
                        )
                    }
                }
            }
            Request::Health { .. } => {
                let mut response = Response::success(request_id, self.state);
                response.ready = Some(self.state == SupervisorState::Running);
                if let Some(child) = self.child.as_ref() {
                    response.child_pid = Some(child.id());
                }
                if let Some(exit) = self.last_exit.as_ref() {
                    response.exit_code = exit.code;
                    response.signal = exit.signal;
                }
                (response, false)
            }
            Request::Stop { .. } => {
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
                self.state = SupervisorState::Stopped;
                match result {
                    Ok((exit, forced)) => {
                        let mut response = Response::success(request_id, self.state);
                        response.ready = Some(false);
                        response.forced = Some(forced);
                        response.exit_code = exit.code;
                        response.signal = exit.signal;
                        (response, true)
                    }
                    Err(error) => (
                        Response::failure(
                            request_id,
                            SupervisorState::Failed,
                            "STOP_FAILED",
                            error.to_string(),
                        ),
                        true,
                    ),
                }
            }
        }
    }
}

fn validate_common(request: &Request) -> Result<(), String> {
    if request.protocol() != PROTOCOL_VERSION {
        return Err("unsupported supervisor protocol".to_owned());
    }
    validate_identifier(request.request_id(), false, "request_id")
}

fn validate_start(
    extension_id: &str,
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    startup_timeout_ms: u64,
    shutdown_grace_ms: u64,
) -> Result<(), String> {
    validate_identifier(extension_id, true, "extension_id")?;
    if program.len() > 4096 || !Path::new(program).is_absolute() {
        return Err("program must be a bounded absolute path".to_owned());
    }
    if args.len() > MAX_ARGUMENTS || args.iter().any(|arg| arg.len() > MAX_ARGUMENT_BYTES) {
        return Err("args exceed the supervisor bounds".to_owned());
    }
    if env.len() > MAX_ENVIRONMENT_KEYS
        || env.iter().any(|(key, value)| {
            !valid_environment_key(key) || value.len() > MAX_ENVIRONMENT_VALUE_BYTES
        })
    {
        return Err("env exceeds the supervisor bounds".to_owned());
    }
    if !(1..=MAX_GRACE_MS).contains(&startup_timeout_ms)
        || !(1..=MAX_GRACE_MS).contains(&shutdown_grace_ms)
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
        && value.len() <= 128
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
                Response::failure(
                    "invalid",
                    supervisor.state(),
                    "FRAME_TOO_LARGE",
                    "supervisor frame exceeds 65536 bytes",
                ),
                false,
            ),
            Frame::Line(line) if line.is_empty() => continue,
            Frame::Line(line) => match serde_json::from_slice::<Request>(&line) {
                Ok(request) => supervisor.handle(request),
                Err(_) => (
                    Response::failure(
                        "invalid",
                        supervisor.state(),
                        "INVALID_JSON",
                        "supervisor request is not valid protocol JSON",
                    ),
                    false,
                ),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request(line: &str) -> Request {
        serde_json::from_str(line).expect("valid request fixture")
    }

    #[test]
    fn protocol_rejects_unknown_fields_and_relative_programs() {
        assert!(serde_json::from_str::<Request>(
            r#"{"protocol":"sumi.runtime.supervisor.v1","request_id":"r1","op":"health","extra":true}"#,
        )
        .is_err());

        let mut supervisor = Supervisor::default();
        let (response, _) = supervisor.handle(request(
            r#"{"protocol":"sumi.runtime.supervisor.v1","request_id":"r1","op":"start","extension_id":"fixture.worker","program":"node","args":[],"env":{},"startup_timeout_ms":100,"shutdown_grace_ms":100}"#,
        ));
        assert!(!response.ok);
        assert_eq!(response.state, SupervisorState::Failed);
    }

    #[test]
    fn health_is_not_ready_before_start() {
        let mut supervisor = Supervisor::default();
        let (response, stop) = supervisor.handle(request(
            r#"{"protocol":"sumi.runtime.supervisor.v1","request_id":"r1","op":"health"}"#,
        ));
        assert!(!stop);
        assert!(response.ok);
        assert_eq!(response.ready, Some(false));
        assert_eq!(response.state, SupervisorState::Created);
    }

    #[test]
    fn oversized_frames_are_rejected_without_unbounded_allocation() {
        let input = format!(
            "{}\n{{\"protocol\":\"sumi.runtime.supervisor.v1\",\"request_id\":\"r2\",\"op\":\"health\"}}\n",
            "x".repeat(MAX_FRAME_BYTES + 1)
        );
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output).expect("serve protocol fixtures");
        let lines = String::from_utf8(output).expect("UTF-8 responses");
        assert!(lines.contains("FRAME_TOO_LARGE"));
        assert!(lines.contains("\"request_id\":\"r2\""));
    }
}
