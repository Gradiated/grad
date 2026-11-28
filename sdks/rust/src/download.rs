//! Artifact downloads: stream the `.grad.tar.gz` bundle to disk while hashing
//! it, verify `X-Artifact-Sha256` and the size, then either keep the archive or
//! extract it safely into a directory that vLLM / SGLang / PEFT can load
//! (`adapter_config.json` + `adapter_model.safetensors`, plus `manifest.json`).
//!
//! Extraction never trusts the archive: only regular files with safe relative
//! paths are accepted (no absolute paths, `..`, backslashes, links or devices),
//! duplicates are rejected, the entry count and total size are capped, and
//! every payload file must match the SHA-256 recorded in `manifest.json`
//! (schema `grad.artifact/1`). Files are written into a fresh temporary
//! directory that is renamed into place only after everything verified.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};
use crate::util;

/// Manifest schema the extractor understands.
pub const MANIFEST_SCHEMA: &str = "grad.artifact/1";
const RESERVED: [&str; 2] = ["manifest.json", "eval_report.json"];

/// Limits applied while extracting a bundle.
#[derive(Debug, Clone, Copy)]
pub struct ExtractLimits {
    pub max_entries: usize,
    pub max_total_bytes: u64,
}

impl Default for ExtractLimits {
    fn default() -> Self {
        ExtractLimits {
            max_entries: 1024,
            max_total_bytes: 512 * 1024 * 1024 * 1024,
        }
    }
}

/// Where to put a downloaded artifact.
#[derive(Debug, Clone)]
pub struct DownloadOptions {
    /// Extract into this directory (must not exist or be empty, unless `overwrite`).
    pub extract_to: Option<PathBuf>,
    /// Keep the verified `.grad.tar.gz` at this path.
    pub archive_to: Option<PathBuf>,
    /// Replace an existing non-empty output directory or archive.
    pub overwrite: bool,
    pub limits: ExtractLimits,
}

impl DownloadOptions {
    /// Extract into `dir` (the documented `--output DIR` behaviour).
    pub fn extract(dir: impl Into<PathBuf>) -> Self {
        DownloadOptions {
            extract_to: Some(dir.into()),
            archive_to: None,
            overwrite: false,
            limits: ExtractLimits::default(),
        }
    }

    /// Keep only the verified archive at `path`.
    pub fn archive(path: impl Into<PathBuf>) -> Self {
        DownloadOptions {
            extract_to: None,
            archive_to: Some(path.into()),
            overwrite: false,
            limits: ExtractLimits::default(),
        }
    }
}

/// Result of a verified download.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadedArtifact {
    /// Artifact reference that was requested.
    pub reference: String,
    /// SHA-256 of the bundle (verified).
    pub sha256: String,
    pub size_bytes: u64,
    /// Extracted directory, when extracted.
    pub directory: Option<PathBuf>,
    /// Kept archive, when requested.
    pub archive: Option<PathBuf>,
    /// Payload files (relative paths) with their verified SHA-256.
    pub files: BTreeMap<String, String>,
    /// The bundle's `manifest.json` (empty when only the archive was kept).
    pub manifest: Map<String, Value>,
}

/// A temporary file in `dir`, created with O_EXCL and removed on drop unless persisted.
pub(crate) struct TempFile {
    pub path: PathBuf,
    pub file: Option<fs::File>,
    keep: bool,
}

impl TempFile {
    pub fn new_in(dir: &Path, prefix: &str) -> Result<Self> {
        fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        for _ in 0..8 {
            let path = dir.join(format!(".{}-{}.part", prefix, util::random_hex(8)));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(TempFile {
                        path,
                        file: Some(file),
                        keep: false,
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(Error::io(&path, e)),
            }
        }
        Err(Error::InvalidInput(format!(
            "could not create a temporary file in {}",
            dir.display()
        )))
    }

    pub fn persist(mut self, to: &Path, overwrite: bool) -> Result<()> {
        if let Some(f) = self.file.take() {
            f.sync_all().map_err(|e| Error::io(&self.path, e))?;
        }
        refuse_symlink(to)?;
        if to.exists() && !overwrite {
            return Err(Error::InvalidInput(format!(
                "{} already exists; pass --force to replace it",
                to.display()
            )));
        }
        if to.is_dir() {
            return Err(Error::InvalidInput(format!(
                "{} is a directory; pass a file path for the archive",
                to.display()
            )));
        }
        set_mode(&self.path, 0o644);
        fs::rename(&self.path, to).map_err(|e| Error::io(to, e))?;
        sync_parent(to);
        self.keep = true;
        Ok(())
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn set_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

fn sync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        let dir = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn refuse_symlink(path: &Path) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(Error::InvalidInput(format!(
                "{} is a symbolic link; refusing to write through it",
                path.display()
            )));
        }
    }
    Ok(())
}

/// Parent directory for temporary files next to `target`.
pub(crate) fn parent_dir(target: &Path) -> PathBuf {
    match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Validate one archive member path; returns the normalized relative path.
pub fn safe_member_path(name: &str) -> Result<PathBuf> {
    let bad = || Error::UnsafeArchive(format!("unsafe entry path {:?}", name));
    if name.is_empty() || name.starts_with('/') || name.contains('\\') || name.contains('\0') {
        return Err(bad());
    }
    if name
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(bad());
    }
    let path = PathBuf::from(name);
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(bad());
    }
    Ok(path)
}

/// Extract and verify a bundle into `dest` (which must not exist yet).
pub fn extract_bundle(
    archive: &Path,
    dest: &Path,
    limits: ExtractLimits,
) -> Result<(Map<String, Value>, BTreeMap<String, String>)> {
    let file = fs::File::open(archive).map_err(|e| Error::io(archive, e))?;
    let gz = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut tar = tar::Archive::new(gz);
    let mut seen: HashSet<String> = HashSet::new();
    let mut digests: BTreeMap<String, String> = BTreeMap::new();
    let mut manifest_raw: Option<Vec<u8>> = None;
    let mut total: u64 = 0;
    let mut count = 0usize;
    let entries = tar
        .entries()
        .map_err(|e| Error::UnsafeArchive(format!("not a valid tar.gz bundle: {}", e)))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| Error::UnsafeArchive(format!("corrupt bundle: {}", e)))?;
        count += 1;
        if count > limits.max_entries {
            return Err(Error::UnsafeArchive(format!(
                "bundle has more than {} entries",
                limits.max_entries
            )));
        }
        let name = {
            let raw = entry.path_bytes();
            String::from_utf8(raw.into_owned())
                .map_err(|_| Error::UnsafeArchive("entry path is not UTF-8".into()))?
        };
        let kind = entry.header().entry_type();
        if !(kind.is_file()) {
            return Err(Error::UnsafeArchive(format!(
                "entry {:?} is not a regular file ({:?})",
                name, kind
            )));
        }
        let rel = safe_member_path(&name)?;
        if !seen.insert(name.clone()) {
            return Err(Error::UnsafeArchive(format!("duplicate entry {:?}", name)));
        }
        let declared = entry.header().size().unwrap_or(0);
        if total.saturating_add(declared) > limits.max_total_bytes {
            return Err(Error::UnsafeArchive(format!(
                "bundle exceeds the {} byte extraction limit",
                limits.max_total_bytes
            )));
        }
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&out_path)
            .map_err(|e| Error::io(&out_path, e))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut written: u64 = 0;
        let keep_bytes = name == "manifest.json";
        let mut kept = Vec::new();
        loop {
            let n = entry
                .read(&mut buf)
                .map_err(|e| Error::UnsafeArchive(format!("corrupt entry {:?}: {}", name, e)))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > declared || total + written > limits.max_total_bytes {
                return Err(Error::UnsafeArchive(format!(
                    "entry {:?} is larger than declared",
                    name
                )));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])
                .map_err(|e| Error::io(&out_path, e))?;
            if keep_bytes {
                if kept.len() + n > 16 * 1024 * 1024 {
                    return Err(Error::UnsafeArchive("manifest.json is too large".into()));
                }
                kept.extend_from_slice(&buf[..n]);
            }
        }
        out.sync_all().map_err(|e| Error::io(&out_path, e))?;
        total += written;
        digests.insert(name.clone(), hex::encode(hasher.finalize()));
        if keep_bytes {
            manifest_raw = Some(kept);
        }
    }
    let manifest = verify_manifest(manifest_raw.as_deref(), &digests)?;
    let payload: BTreeMap<String, String> = digests
        .into_iter()
        .filter(|(k, _)| !RESERVED.contains(&k.as_str()))
        .collect();
    Ok((manifest, payload))
}

/// Check `manifest.json` against the digests of the extracted files.
pub fn verify_manifest(
    raw: Option<&[u8]>,
    digests: &BTreeMap<String, String>,
) -> Result<Map<String, Value>> {
    let raw = raw.ok_or_else(|| Error::UnsafeArchive("bundle has no manifest.json".into()))?;
    let manifest: Value = serde_json::from_slice(raw)
        .map_err(|e| Error::UnsafeArchive(format!("manifest.json is not valid JSON: {}", e)))?;
    let Value::Object(manifest) = manifest else {
        return Err(Error::UnsafeArchive(
            "manifest.json must be a JSON object".into(),
        ));
    };
    let schema = manifest.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != MANIFEST_SCHEMA {
        return Err(Error::UnsafeArchive(format!(
            "unsupported manifest schema {:?} (expected {}); upgrade grad",
            schema, MANIFEST_SCHEMA
        )));
    }
    let declared = manifest
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::UnsafeArchive("manifest has no 'files' checksum map".into()))?;
    for name in digests.keys() {
        if !RESERVED.contains(&name.as_str()) && !declared.contains_key(name) {
            return Err(Error::UnsafeArchive(format!(
                "bundle contains undeclared file {:?}",
                name
            )));
        }
    }
    for (name, expected) in declared {
        let expected = expected.as_str().unwrap_or("").to_ascii_lowercase();
        match digests.get(name) {
            None => {
                return Err(Error::UnsafeArchive(format!(
                    "bundle is missing declared file {:?}",
                    name
                )))
            }
            Some(actual) if *actual != expected => {
                return Err(Error::Checksum {
                    what: format!("artifact file {}", name),
                    expected,
                    actual: actual.clone(),
                })
            }
            _ => {}
        }
    }
    let report_sha = manifest.get("eval_report_sha256").and_then(Value::as_str);
    match (report_sha, digests.get("eval_report.json")) {
        (Some(exp), Some(act)) if exp.to_ascii_lowercase() != *act => {
            return Err(Error::Checksum {
                what: "eval_report.json".into(),
                expected: exp.to_string(),
                actual: act.clone(),
            })
        }
        (None, Some(_)) => {
            return Err(Error::UnsafeArchive(
                "eval_report.json is not covered by the manifest".into(),
            ))
        }
        (Some(_), None) => {
            return Err(Error::UnsafeArchive(
                "bundle is missing eval_report.json".into(),
            ))
        }
        _ => {}
    }
    Ok(manifest)
}

/// Refuses an extraction directory that holds `cwd` (`.`, `..`, `~` from inside it):
/// replacing it, even with `overwrite`, would delete the caller's working tree.
pub(crate) fn refuse_holding_cwd(dest: &Path, cwd: &Path) -> Result<()> {
    let (Ok(dest_real), Ok(cwd_real)) = (fs::canonicalize(dest), fs::canonicalize(cwd)) else {
        return Ok(()); // a directory that doesn't exist holds nothing
    };
    if cwd_real.starts_with(&dest_real) {
        return Err(Error::InvalidInput(format!(
            "refusing to extract into {}: it holds the current directory; choose a new --output directory",
            dest.display()
        )));
    }
    Ok(())
}

/// Move a verified extraction directory into place.
pub(crate) fn install_dir(tmp: &Path, dest: &Path, overwrite: bool) -> Result<()> {
    refuse_symlink(dest)?;
    if dest.exists() {
        if !dest.is_dir() {
            return Err(Error::InvalidInput(format!(
                "{} exists and is not a directory",
                dest.display()
            )));
        }
        let empty = fs::read_dir(dest)
            .map_err(|e| Error::io(dest, e))?
            .next()
            .is_none();
        if !empty {
            if !overwrite {
                return Err(Error::InvalidInput(format!(
                    "{} is not empty; choose a new --output directory or pass --force to replace it",
                    dest.display()
                )));
            }
            fs::remove_dir_all(dest).map_err(|e| Error::io(dest, e))?;
        } else {
            fs::remove_dir(dest).map_err(|e| Error::io(dest, e))?;
        }
    }
    fs::rename(tmp, dest).map_err(|e| Error::io(dest, e))?;
    sync_parent(dest);
    Ok(())
}

/// A temporary directory removed on drop unless disarmed.
pub(crate) struct TempDir {
    pub path: PathBuf,
    keep: bool,
}

impl TempDir {
    pub fn new_in(dir: &Path, prefix: &str) -> Result<Self> {
        fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        let path = dir.join(format!(".{}-{}.part", prefix, util::random_hex(8)));
        fs::create_dir(&path).map_err(|e| Error::io(&path, e))?;
        Ok(TempDir { path, keep: false })
    }

    pub fn disarm(&mut self) {
        self.keep = true;
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_extraction_never_replaces_the_working_directory_or_its_parents() {
        let root = std::env::temp_dir().join(format!("grad-cwd-{}", util::random_hex(6)));
        let work = root.join("project").join("src");
        fs::create_dir_all(&work).unwrap();
        for dest in [work.clone(), work.join(".."), root.clone(), work.join(".")] {
            let e = refuse_holding_cwd(&dest, &work).unwrap_err();
            assert!(e.to_string().contains("holds the current directory"), "{e}");
        }
        refuse_holding_cwd(&work.join("adapter"), &work).unwrap();
        refuse_holding_cwd(&root.join("other"), &work).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        refuse_holding_cwd(&root.join("other"), &work).unwrap();
        let _ = fs::remove_dir_all(&root);
    }
}
