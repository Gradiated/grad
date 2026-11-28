//! A small spec-compliant Server-Sent Events parser (used by the run events stream).

/// One parsed SSE event.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<u64>,
}

/// Incremental SSE parser (feed bytes, pull events).
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
    has_fields: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes; returns the events completed by them.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
            // A lone trailing '\r' may be the first half of "\r\n": wait for more bytes.
            if self.buf[pos] == b'\r' && pos + 1 == self.buf.len() {
                break;
            }
            let line: Vec<u8> = self.buf[..pos].to_vec();
            let skip = if self.buf[pos] == b'\r' && self.buf.get(pos + 1) == Some(&b'\n') {
                2
            } else {
                1
            };
            self.buf.drain(..pos + skip);
            let line = String::from_utf8_lossy(&line).into_owned();
            if let Some(ev) = self.line(&line) {
                out.push(ev);
            }
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            if !self.has_fields {
                return None;
            }
            let ev = SseEvent {
                event: if self.event.is_empty() {
                    "message".into()
                } else {
                    std::mem::take(&mut self.event)
                },
                data: std::mem::take(&mut self.data).join("\n"),
                id: self.id.clone(),
                retry: self.retry.take(),
            };
            self.has_fields = false;
            return Some(ev);
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line, ""),
        };
        match field {
            "event" => {
                self.event = value.to_string();
                self.has_fields = true;
            }
            "data" => {
                self.data.push(value.to_string());
                self.has_fields = true;
            }
            "id" => {
                if !value.contains('\0') {
                    self.id = Some(value.to_string());
                }
            }
            "retry" => {
                if let Ok(ms) = value.parse() {
                    self.retry = Some(ms);
                }
            }
            _ => {}
        }
        None
    }
}
