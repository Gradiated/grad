//! Small internal helpers.

use std::time::{Duration, SystemTime};

/// `n` random bytes as lowercase hex, from the OS CSPRNG.
pub fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    // getrandom only fails when the OS has no entropy source at all.
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    hex::encode(buf)
}

/// A random UUIDv4 for the `Idempotency-Key` header (one per logical call).
pub fn new_idempotency_key() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("OS random number generator unavailable");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
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

/// An IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`, RFC 9110), the form
/// `Retry-After` dates take.
pub fn parse_http_date(v: &str) -> Option<SystemTime> {
    let (_, rest) = v.split_once(", ")?;
    let parts: Vec<&str> = rest.split(' ').collect();
    let [day, month, year, time, "GMT"] = parts.as_slice() else {
        return None;
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let m = MONTHS.iter().position(|x| x == month)? as i64 + 1;
    let (d, y): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
    let hms: Vec<i64> = time
        .split(':')
        .map(|x| x.parse().ok())
        .collect::<Option<_>>()?;
    let [hh, mm, ss] = hms.as_slice() else {
        return None;
    };
    if !(1..=31).contains(&d) || *hh > 23 || *mm > 59 || *ss > 60 {
        return None;
    }
    // Days since 1970-01-01 from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(u64::try_from(secs).ok()?))
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
