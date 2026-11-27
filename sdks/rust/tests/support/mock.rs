//! A tiny in-process HTTP/1.1 mock server for SDK and CLI tests.
//!
//! Every connection serves one request and closes. The handler sees each
//! recorded request and returns a [`Reply`]; requests are also kept for
//! assertions. Supports Content-Length and chunked request bodies, streamed
//! (delayed, truncated) responses and dropped connections.

#![allow(dead_code)]

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    /// Path including the query string.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    pub fn query(&self) -> &str {
        self.target.split_once('?').map(|(_, q)| q).unwrap_or("")
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let n = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == n)
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

pub enum Reply {
    Full {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Send headers, then chunks after the given delays (no Content-Length; close ends the body).
    Stream {
        status: u16,
        headers: Vec<(String, String)>,
        chunks: Vec<(Duration, Vec<u8>)>,
    },
    /// Declare `declared` bytes but send only `body`, then close.
    Truncated {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        declared: usize,
    },
    /// Close the connection without answering.
    Drop,
}

impl Reply {
    pub fn json(status: u16, v: Value) -> Reply {
        Reply::Full {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&v).unwrap(),
        }
    }

    pub fn problem(status: u16, code: &str, detail: &str) -> Reply {
        Reply::Full {
            status,
            headers: vec![
                ("content-type".into(), "application/problem+json".into()),
                ("x-request-id".into(), "req_mock".into()),
            ],
            body: serde_json::to_vec(&serde_json::json!({
                "type": format!("https://gradiated.com/problems/{}", code),
                "title": "Mock problem",
                "status": status,
                "code": code,
                "detail": detail,
                "request_id": "req_mock",
            }))
            .unwrap(),
        }
    }

    pub fn bytes(status: u16, headers: Vec<(&str, String)>, body: Vec<u8>) -> Reply {
        Reply::Full {
            status,
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            body,
        }
    }

    pub fn with_header(self, k: &str, v: &str) -> Reply {
        match self {
            Reply::Full {
                status,
                mut headers,
                body,
            } => {
                headers.push((k.into(), v.into()));
                Reply::Full {
                    status,
                    headers,
                    body,
                }
            }
            other => other,
        }
    }
}

type Handler = dyn Fn(&Recorded) -> Reply + Send + Sync;

pub struct MockServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
    port: u16,
}

impl MockServer {
    pub fn start(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<Handler> = Arc::new(handler);
        let reqs = requests.clone();
        let stop2 = stop.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let handler = handler.clone();
                let reqs = reqs.clone();
                thread::spawn(move || {
                    let _ = serve(conn, &*handler, &reqs);
                });
            }
        });
        MockServer {
            url: format!("http://127.0.0.1:{}", port),
            requests,
            stop,
            port,
        }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    pub fn count(&self, method: &str, path: &str) -> usize {
        self.requests()
            .iter()
            .filter(|r| r.method == method && r.path() == path)
            .count()
    }

    pub fn last(&self, method: &str, path: &str) -> Option<Recorded> {
        self.requests()
            .into_iter()
            .rev()
            .find(|r| r.method == method && r.path() == path)
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn read_request(stream: &TcpStream) -> std::io::Result<Option<Recorded>> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let get = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let mut body = Vec::new();
    if get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size)?;
            let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16)
                .unwrap_or(0);
            if n == 0 {
                let mut crlf = String::new();
                let _ = reader.read_line(&mut crlf);
                break;
            }
            let mut chunk = vec![0u8; n];
            reader.read_exact(&mut chunk)?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf)?;
        }
    } else if let Some(len) = get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        body = vec![0u8; len];
        reader.read_exact(&mut body)?;
    }
    Ok(Some(Recorded {
        method,
        target,
        headers,
        body,
    }))
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        307 => "Temporary Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn head(status: u16, headers: &[(String, String)], len: Option<usize>) -> String {
    let mut s = format!(
        "HTTP/1.1 {} {}\r\nconnection: close\r\n",
        status,
        reason(status)
    );
    for (k, v) in headers {
        s.push_str(&format!("{}: {}\r\n", k, v));
    }
    if let Some(n) = len {
        s.push_str(&format!("content-length: {}\r\n", n));
    }
    s.push_str("\r\n");
    s
}

fn serve(
    mut stream: TcpStream,
    handler: &Handler,
    reqs: &Mutex<Vec<Recorded>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let Some(req) = read_request(&stream)? else {
        return Ok(());
    };
    reqs.lock().unwrap().push(req.clone());
    match handler(&req) {
        Reply::Full {
            status,
            headers,
            body,
        } => {
            stream.write_all(head(status, &headers, Some(body.len())).as_bytes())?;
            stream.write_all(&body)?;
        }
        Reply::Stream {
            status,
            headers,
            chunks,
        } => {
            stream.write_all(head(status, &headers, None).as_bytes())?;
            stream.flush()?;
            for (delay, bytes) in chunks {
                thread::sleep(delay);
                stream.write_all(&bytes)?;
                stream.flush()?;
            }
        }
        Reply::Truncated {
            status,
            headers,
            body,
            declared,
        } => {
            stream.write_all(head(status, &headers, Some(declared)).as_bytes())?;
            stream.write_all(&body)?;
        }
        Reply::Drop => {}
    }
    stream.flush()?;
    let _ = stream.shutdown(std::net::Shutdown::Both);
    Ok(())
}

/// Build a `.grad.tar.gz` bundle in memory with a valid manifest.
pub fn bundle(files: &[(&str, &[u8])]) -> Vec<u8> {
    bundle_with(files, None, |_| {})
}

/// Build a bundle; `tweak` may edit the manifest; `report` adds eval_report.json.
pub fn bundle_with(
    files: &[(&str, &[u8])],
    report: Option<&[u8]>,
    tweak: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut checks = serde_json::Map::new();
    for (name, data) in files {
        checks.insert(
            name.to_string(),
            Value::String(hex::encode(Sha256::digest(data))),
        );
    }
    let mut manifest = serde_json::Map::new();
    manifest.insert("schema".into(), Value::String("grad.artifact/1".into()));
    manifest.insert("format".into(), Value::String("peft_lora".into()));
    manifest.insert("files".into(), Value::Object(checks));
    if let Some(r) = report {
        manifest.insert(
            "eval_report_sha256".into(),
            Value::String(hex::encode(Sha256::digest(r))),
        );
    }
    tweak(&mut manifest);
    let manifest_bytes = serde_json::to_vec(&Value::Object(manifest)).unwrap();
    let mut entries: Vec<(String, Vec<u8>)> = vec![("manifest.json".into(), manifest_bytes)];
    if let Some(r) = report {
        entries.push(("eval_report.json".into(), r.to_vec()));
    }
    for (n, d) in files {
        entries.push((n.to_string(), d.to_vec()));
    }
    raw_tar_gz(&entries)
}

/// A gzip'd tar of regular files with arbitrary (even unsafe) names.
pub fn raw_tar_gz(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (name, data) in entries {
        tar.extend_from_slice(&tar_header(name, data.len(), b'0', ""));
        tar.extend_from_slice(data);
        let pad = (512 - data.len() % 512) % 512;
        tar.extend(std::iter::repeat_n(0u8, pad));
    }
    tar.extend(std::iter::repeat_n(0u8, 1024));
    gzip(&tar)
}

/// A tar.gz with one symlink entry.
pub fn symlink_tar_gz(name: &str, target: &str) -> Vec<u8> {
    let mut tar = Vec::new();
    tar.extend_from_slice(&tar_header(name, 0, b'2', target));
    tar.extend(std::iter::repeat_n(0u8, 1024));
    gzip(&tar)
}

fn gzip(data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    let mut enc = GzEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

fn tar_header(name: &str, size: usize, kind: u8, link: &str) -> [u8; 512] {
    let mut h = [0u8; 512];
    let nb = name.as_bytes();
    h[..nb.len().min(100)].copy_from_slice(&nb[..nb.len().min(100)]);
    h[100..108].copy_from_slice(b"0000644\0");
    h[108..116].copy_from_slice(b"0000000\0");
    h[116..124].copy_from_slice(b"0000000\0");
    let sz = format!("{:011o}\0", size);
    h[124..136].copy_from_slice(sz.as_bytes());
    h[136..148].copy_from_slice(b"00000000000\0");
    h[156] = kind;
    let lb = link.as_bytes();
    h[157..157 + lb.len().min(100)].copy_from_slice(&lb[..lb.len().min(100)]);
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].copy_from_slice(b"        ");
    let sum: u32 = h.iter().map(|b| *b as u32).sum();
    let cs = format!("{:06o}\0 ", sum);
    h[148..156].copy_from_slice(cs.as_bytes());
    h
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}
