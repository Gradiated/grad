//! Client configuration: explicit arguments, then the environment
//! (`GRADIATED_API_KEY`, `GRADIATED_BASE_URL`), then the `grad login` config
//! file (`$XDG_CONFIG_HOME/gradiated/config.json`, default
//! `~/.config/gradiated/config.json`).
//!
//! The config file holds named profiles:
//! `{"profiles": {"default": {"base_url": "...", "api_key": "..."}}}`.
//! Selecting a profile explicitly (`with_profile`, `--profile` or
//! `GRADIATED_PROFILE`) makes that profile win over the two environment
//! variables, because the caller asked for it by name.
//!
//! A key read from a profile is only ever sent to that profile's own base URL,
//! so overriding the URL never leaks a saved key to another server.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Default API endpoint (Gradiated Cloud).
pub const DEFAULT_BASE_URL: &str = "https://api.gradiated.com";
/// Environment variable holding the API key.
pub const ENV_API_KEY: &str = "GRADIATED_API_KEY";
/// Environment variable holding the base URL.
pub const ENV_BASE_URL: &str = "GRADIATED_BASE_URL";
/// Environment variable selecting a config-file profile.
pub const ENV_PROFILE: &str = "GRADIATED_PROFILE";
/// Name of the profile used when none is selected.
pub const DEFAULT_PROFILE: &str = "default";

/// One saved profile.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Fields written by other tools (for example `grad local up`'s trainer key).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl std::fmt::Debug for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Profile")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("extra_keys", &self.extra.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// The parsed config file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ConfigFile {
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ConfigFile {
    /// Default location of the config file.
    pub fn default_path() -> Option<PathBuf> {
        config_path_from(
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
            home_dir(),
        )
    }

    /// Read a config file; a missing file is an empty config.
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read_to_string(path) {
            Ok(raw) => {
                if raw.trim().is_empty() {
                    return Ok(ConfigFile::default());
                }
                serde_json::from_str(&raw).map_err(|e| {
                    Error::Config(format!(
                        "config file {} is not valid JSON ({}); fix it or run `grad login` again",
                        path.display(),
                        e
                    ))
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConfigFile::default()),
            Err(e) => Err(Error::io(path, e)),
        }
    }

    /// Atomically write the config file with mode 0600 (directory 0700).
    pub fn save(&self, path: &Path) -> Result<()> {
        let dir = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        create_private_dir(dir)?;
        let body = serde_json::to_vec_pretty(self)
            .map_err(|e| Error::Config(format!("could not encode config: {}", e)))?;
        let tmp = dir.join(format!(
            ".config.json.{}.{}.tmp",
            std::process::id(),
            crate::util::random_hex(6)
        ));
        let write = (|| -> std::io::Result<()> {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(&body)?;
            f.write_all(b"\n")?;
            f.sync_all()?;
            Ok(())
        })();
        if let Err(e) = write {
            let _ = fs::remove_file(&tmp);
            return Err(Error::io(&tmp, e));
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(Error::io(path, e));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| Error::io(path, e))?;
        }
        Ok(())
    }
}

fn create_private_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| Error::io(dir, e))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn config_path_from(xdg: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    match xdg.filter(|p| p.is_absolute()) {
        Some(x) => Some(x.join("gradiated").join("config.json")),
        None => home.map(|h| h.join(".config").join("gradiated").join("config.json")),
    }
}

/// Where a resolved value came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// Passed explicitly (builder method or CLI flag).
    Argument,
    /// `GRADIATED_API_KEY` / `GRADIATED_BASE_URL`.
    Environment,
    /// A config-file profile.
    Profile(String),
    /// Built-in default.
    Default,
    /// Not set.
    Unset,
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Source::Argument => f.write_str("argument"),
            Source::Environment => f.write_str("environment"),
            Source::Profile(p) => write!(f, "profile '{}'", p),
            Source::Default => f.write_str("default"),
            Source::Unset => f.write_str("unset"),
        }
    }
}

/// Inputs to configuration resolution.
#[derive(Debug, Clone, Default)]
pub struct ConfigInputs {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// Explicitly selected profile.
    pub profile: Option<String>,
    /// Config file path override (defaults to [`ConfigFile::default_path`]).
    pub config_path: Option<PathBuf>,
    /// Ignore the environment (used by tests).
    pub ignore_env: bool,
    /// Ignore the config file.
    pub ignore_file: bool,
}

/// Fully resolved configuration.
#[derive(Clone, PartialEq)]
pub struct ResolvedConfig {
    pub base_url: String,
    pub base_url_source: Source,
    pub api_key: Option<String>,
    pub api_key_source: Source,
    pub profile: String,
    pub config_path: Option<PathBuf>,
    /// Why a saved key was not used, if one was skipped.
    pub note: Option<String>,
}

impl std::fmt::Debug for ResolvedConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedConfig")
            .field("base_url", &self.base_url)
            .field("base_url_source", &self.base_url_source)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("api_key_source", &self.api_key_source)
            .field("profile", &self.profile)
            .field("config_path", &self.config_path)
            .finish()
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Normalize a base URL for comparisons and requests (`http://h:1/x/` -> `http://h:1/x`).
pub fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Validate a base URL: absolute `http`/`https` with a host.
pub fn validate_base_url(url: &str) -> Result<reqwest::Url> {
    let trimmed = url.trim();
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| {
        let hint = if !trimmed.contains("://") {
            format!(" (did you mean http://{}?)", trimmed)
        } else {
            String::new()
        };
        Error::Config(format!("invalid base URL '{}': {}{}", trimmed, e, hint))
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(Error::Config(format!(
            "invalid base URL '{}': use an http:// or https:// URL with a host (for example http://127.0.0.1:8787)",
            trimmed
        )));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(Error::Config(format!(
            "invalid base URL '{}': it must not contain a query or fragment",
            trimmed
        )));
    }
    Ok(parsed)
}

/// Resolve the configuration from arguments, environment and config file.
pub fn resolve(inputs: &ConfigInputs) -> Result<ResolvedConfig> {
    let env = |name: &str| -> Option<String> {
        if inputs.ignore_env {
            None
        } else {
            non_empty(std::env::var(name).ok())
        }
    };
    let explicit_profile = non_empty(inputs.profile.clone()).or_else(|| env(ENV_PROFILE));
    let profile_name = explicit_profile
        .clone()
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string());
    let config_path = if inputs.ignore_file {
        None
    } else {
        inputs.config_path.clone().or_else(ConfigFile::default_path)
    };
    let file = match &config_path {
        Some(p) => ConfigFile::load(p)?,
        None => ConfigFile::default(),
    };
    let profile = file.profiles.get(&profile_name).cloned();
    if explicit_profile.is_some() && profile.is_none() {
        let path = config_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<none>".into());
        return Err(Error::Config(format!(
            "profile '{}' not found in {}; create it with `grad login --profile {}`",
            profile_name, path, profile_name
        )));
    }
    let profile_url = profile.as_ref().and_then(|p| non_empty(p.base_url.clone()));
    let profile_key = profile.as_ref().and_then(|p| non_empty(p.api_key.clone()));
    let psrc = Source::Profile(profile_name.clone());

    // Base URL: argument > explicit profile > env > default profile > default.
    let (base_url, base_url_source) = if let Some(u) = non_empty(inputs.base_url.clone()) {
        (u, Source::Argument)
    } else if let (true, Some(u)) = (explicit_profile.is_some(), profile_url.clone()) {
        (u, psrc.clone())
    } else if let Some(u) = env(ENV_BASE_URL) {
        (u, Source::Environment)
    } else if let Some(u) = profile_url.clone() {
        (u, psrc.clone())
    } else {
        (DEFAULT_BASE_URL.to_string(), Source::Default)
    };
    let base_url = normalize_base_url(&base_url);

    // API key: argument > explicit profile > env > default profile.
    let mut note = None;
    let profile_key_usable = |key: &Option<String>| -> Option<String> {
        let key = key.clone()?;
        let owner = normalize_base_url(profile_url.as_deref().unwrap_or(DEFAULT_BASE_URL));
        if owner == base_url {
            Some(key)
        } else {
            None
        }
    };
    let (api_key, api_key_source) = if let Some(k) = non_empty(inputs.api_key.clone()) {
        (Some(k), Source::Argument)
    } else if let (true, Some(k)) = (explicit_profile.is_some(), profile_key_usable(&profile_key)) {
        (Some(k), psrc.clone())
    } else if let Some(k) = env(ENV_API_KEY) {
        (Some(k), Source::Environment)
    } else if let Some(k) = profile_key_usable(&profile_key) {
        (Some(k), psrc.clone())
    } else {
        if profile_key.is_some() {
            note = Some(format!(
                "the key saved in profile '{}' belongs to {}, not {}, so it was not sent",
                profile_name,
                profile_url.as_deref().unwrap_or(DEFAULT_BASE_URL),
                base_url
            ));
        }
        (None, Source::Unset)
    };

    Ok(ResolvedConfig {
        base_url,
        base_url_source,
        api_key,
        api_key_source,
        profile: profile_name,
        config_path,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_path_precedence() {
        assert_eq!(
            config_path_from(Some("/x".into()), Some("/home/u".into())),
            Some(PathBuf::from("/x/gradiated/config.json"))
        );
        assert_eq!(
            config_path_from(Some("relative".into()), Some("/home/u".into())),
            Some(PathBuf::from("/home/u/.config/gradiated/config.json"))
        );
        assert_eq!(config_path_from(None, None), None);
    }

    #[test]
    fn base_url_validation_names_the_problem() {
        let err = validate_base_url("localhost:8787").unwrap_err().to_string();
        assert!(
            err.contains("http") && err.contains("localhost:8787"),
            "{}",
            err
        );
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("http://x?y=1").is_err());
        assert!(validate_base_url("https://api.gradiated.com").is_ok());
        assert_eq!(normalize_base_url("http://a:1/b/ "), "http://a:1/b");
    }
}
