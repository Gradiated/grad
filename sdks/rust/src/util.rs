//! Small internal helpers.

use std::time::Duration;

/// `n` random bytes as lowercase hex, from the OS CSPRNG.
pub fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    // getrandom only fails when the OS has no entropy source at all.
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    hex::encode(buf)
}

/// Lowercase SHA-256 hex digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// A uniform value in `[0, 1)` from the OS CSPRNG (for jitter).
pub fn unit_random() -> f64 {
    let mut buf = [0u8; 8];
    if getrandom::getrandom(&mut buf).is_err() {
        return 0.5;
    }
    (u64::from_le_bytes(buf) >> 11) as f64 / (1u64 << 53) as f64
}

/// Exponential backoff with +/-25% jitter: `base * 2^attempt`, capped.
pub fn backoff(attempt: u32, base: Duration, cap: Duration) -> Duration {
    let exp = base.as_secs_f64() * 2f64.powi(attempt.min(16) as i32);
    let capped = exp.min(cap.as_secs_f64());
    let jitter = 0.75 + unit_random() * 0.5;
    Duration::from_secs_f64((capped * jitter).min(cap.as_secs_f64()))
}

/// Whether `s` is a 64-character hex SHA-256 digest.
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reject path parameters that would be normalized away (`.`, `..`, empty).
pub fn check_path_param(what: &str, value: &str) -> crate::Result<()> {
    if value.is_empty() || value == "." || value == ".." {
        return Err(crate::Error::InvalidInput(format!(
            "{} must not be empty, '.' or '..' (got '{}')",
            what, value
        )));
    }
    Ok(())
}

/// Percent-encode one URL path segment (RFC 3986 unreserved characters stay).
pub fn encode_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        let base = Duration::from_millis(500);
        let cap = Duration::from_secs(5);
        let first = backoff(0, base, cap);
        assert!(first >= Duration::from_millis(375) && first <= Duration::from_millis(625));
        assert!(backoff(10, base, cap) <= cap);
        assert!(backoff(10, base, cap) >= Duration::from_millis(3750));
    }

    #[test]
    fn segments_and_digests() {
        assert_eq!(encode_segment("a b/c@latest"), "a%20b%2Fc%40latest");
        assert!(check_path_param("id", "..").is_err());
        assert!(check_path_param("id", "").is_err());
        assert!(check_path_param("id", "run_1").is_ok());
        assert!(is_sha256_hex(&sha256_hex(b"x")));
        assert!(!is_sha256_hex("zz"));
        assert_eq!(random_hex(4).len(), 8);
        let u = unit_random();
        assert!((0.0..1.0).contains(&u));
    }
}
