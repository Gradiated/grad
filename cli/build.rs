//! Bakes the default image tag for `grad local up` into the binary.
//!
//! `GRAD_IMAGE_TAG` at build time wins (release.yml sets it to the version). Otherwise a build
//! inside a git checkout pulls `main`, and a build from a published crate (`cargo install
//! grad-cli`, no checkout around it) pulls the images tagged with its own version.

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-env-changed=GRAD_IMAGE_TAG");
    let tag = std::env::var("GRAD_IMAGE_TAG")
        .ok()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| {
            let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
            if Path::new(&manifest).join("../.git").exists() {
                "main".into()
            } else {
                std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "main".into())
            }
        });
    println!("cargo:rustc-env=GRAD_DEFAULT_IMAGE_TAG={tag}");
}
