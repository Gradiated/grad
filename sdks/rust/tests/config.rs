//! Configuration precedence: args > explicit profile > env > default profile > default.
//! One test function, because it mutates process-wide environment variables.

use grad_sdk::config::{self, ConfigFile, ConfigInputs, Profile, Source};
use grad_sdk::{Client, Error};
use std::path::PathBuf;

fn write_config(path: &std::path::Path, profiles: &[(&str, &str, &str)]) {
    let mut cfg = ConfigFile::default();
    for (name, url, key) in profiles {
        cfg.profiles.insert(
            name.to_string(),
            Profile {
                base_url: Some(url.to_string()),
                api_key: Some(key.to_string()),
                ..Default::default()
            },
        );
    }
    cfg.save(path).unwrap();
}

#[test]
fn precedence_and_file_handling() {
    let base = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("grad-sdk-config-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let path = base.join("nested").join("gradiated").join("config.json");
    write_config(
        &path,
        &[
            ("default", "https://api.gradiated.com", "grad_file_default"),
            ("local", "http://127.0.0.1:8787/", "grad_file_local"),
        ],
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "config file is private");
        let dmode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dmode, 0o700);
    }
    let inputs = |base_url: Option<&str>, key: Option<&str>, profile: Option<&str>| ConfigInputs {
        base_url: base_url.map(str::to_string),
        api_key: key.map(str::to_string),
        profile: profile.map(str::to_string),
        config_path: Some(path.clone()),
        ignore_env: false,
        ignore_file: false,
    };
    for v in [
        "GRADIATED_API_KEY",
        "GRADIATED_BASE_URL",
        "GRADIATED_PROFILE",
    ] {
        std::env::remove_var(v);
    }

    // File default profile.
    let r = config::resolve(&inputs(None, None, None)).unwrap();
    assert_eq!(r.base_url, "https://api.gradiated.com");
    assert_eq!(r.api_key.as_deref(), Some("grad_file_default"));
    assert_eq!(r.api_key_source, Source::Profile("default".into()));

    // Env beats the default profile.
    std::env::set_var("GRADIATED_API_KEY", "grad_env");
    std::env::set_var("GRADIATED_BASE_URL", "http://env.example:1");
    let r = config::resolve(&inputs(None, None, None)).unwrap();
    assert_eq!(r.base_url, "http://env.example:1");
    assert_eq!(r.base_url_source, Source::Environment);
    assert_eq!(r.api_key.as_deref(), Some("grad_env"));

    // Arguments beat env.
    let r = config::resolve(&inputs(Some("http://arg:2"), Some("grad_arg"), None)).unwrap();
    assert_eq!(
        (r.base_url.as_str(), r.api_key.as_deref()),
        ("http://arg:2", Some("grad_arg"))
    );
    assert_eq!(r.api_key_source, Source::Argument);

    // An explicitly selected profile beats env (flag or GRADIATED_PROFILE).
    let r = config::resolve(&inputs(None, None, Some("local"))).unwrap();
    assert_eq!(r.base_url, "http://127.0.0.1:8787");
    assert_eq!(r.api_key.as_deref(), Some("grad_file_local"));
    std::env::set_var("GRADIATED_PROFILE", "local");
    let r = config::resolve(&inputs(None, None, None)).unwrap();
    assert_eq!(r.profile, "local");
    assert_eq!(r.api_key.as_deref(), Some("grad_file_local"));
    std::env::remove_var("GRADIATED_PROFILE");

    // A saved key is never sent to a different server.
    std::env::remove_var("GRADIATED_API_KEY");
    let r = config::resolve(&inputs(Some("http://elsewhere:9"), None, None)).unwrap();
    assert_eq!(r.api_key, None);
    assert!(r.note.as_deref().unwrap().contains("belongs to"));
    let r = config::resolve(&inputs(Some("http://127.0.0.1:8787"), None, Some("local"))).unwrap();
    assert_eq!(
        r.api_key.as_deref(),
        Some("grad_file_local"),
        "same server, trailing slash ignored"
    );
    std::env::remove_var("GRADIATED_BASE_URL");

    // Unknown explicit profile is an error that says how to create it.
    let e = config::resolve(&inputs(None, None, Some("staging"))).unwrap_err();
    assert!(
        e.to_string().contains("grad login --profile staging"),
        "{}",
        e
    );

    // Client::new() reads the env; Client::with_* override it.
    std::env::set_var("GRADIATED_API_KEY", "grad_env2");
    std::env::set_var("GRADIATED_BASE_URL", "http://127.0.0.1:65000");
    std::env::set_var("XDG_CONFIG_HOME", base.join("empty-xdg"));
    let c = Client::new();
    assert_eq!(c.base_url(), "http://127.0.0.1:65000");
    assert!(c.has_api_key());
    let c = Client::new().with_api_key("grad_explicit");
    assert_eq!(c.resolved_config().api_key_source, Source::Argument);

    // Without anything: Cloud default, no key.
    for v in ["GRADIATED_API_KEY", "GRADIATED_BASE_URL"] {
        std::env::remove_var(v);
    }
    let c = Client::new();
    assert_eq!(c.base_url(), "https://api.gradiated.com");
    assert!(!c.has_api_key());

    // The default path follows XDG_CONFIG_HOME.
    std::env::set_var("XDG_CONFIG_HOME", &base);
    assert_eq!(
        ConfigFile::default_path().unwrap(),
        base.join("gradiated").join("config.json")
    );

    // Malformed file: a config error naming the file, deferred by Client::new().
    std::fs::create_dir_all(base.join("gradiated")).unwrap();
    std::fs::write(base.join("gradiated").join("config.json"), "{not json").unwrap();
    let e = Client::builder().build().unwrap_err();
    assert!(matches!(e, Error::Config(_)));
    assert!(e.to_string().contains("config.json"), "{}", e);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let e = rt.block_on(Client::new().models().list()).unwrap_err();
    assert!(matches!(e, Error::Config(_)));
    // An empty file is an empty config.
    std::fs::write(base.join("gradiated").join("config.json"), "").unwrap();
    assert!(Client::builder().build().is_ok());

    // Round trip keeps unknown fields.
    std::fs::write(
        base.join("gradiated").join("config.json"),
        r#"{"profiles": {"local": {"base_url": "http://x:1", "api_key": "k", "trainer_key": "t"}}, "version": 1}"#,
    )
    .unwrap();
    let cfg = ConfigFile::load(&base.join("gradiated").join("config.json")).unwrap();
    assert_eq!(cfg.profiles["local"].extra["trainer_key"], "t");
    assert!(!format!("{:?}", cfg).contains("\"k\""));
    cfg.save(&base.join("gradiated").join("config.json"))
        .unwrap();
    let raw = std::fs::read_to_string(base.join("gradiated").join("config.json")).unwrap();
    assert!(raw.contains("trainer_key") && raw.contains("\"version\": 1"));
    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = std::fs::remove_dir_all(&base);
}
