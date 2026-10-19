//! NOID mobile wallet core.
//!
//! Everything secret happens here, on the phone: key generation, Photo Key,
//! address derivation, and forging the Parano1d authorization proof. The app
//! talks to this crate through one JSON entry point, [`call`], which the
//! Android layer (android.rs) exposes over JNI.

pub mod api;
pub mod fees;
pub mod keys;
pub mod tx;

#[cfg(target_os = "android")]
mod android;

pub use api::call;

/// User-facing error. `code` lets the app react (e.g. re-plan on "stale").
#[derive(Debug, Clone)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Self { code: "error", message: message.into() }
    }
    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub const MICRONOID_PER_NOID: u64 = 1_000_000;

/// 1234567 -> "1.234567", 5000000 -> "5"
pub fn fmt_noid(micronoid: u64) -> String {
    let whole = micronoid / MICRONOID_PER_NOID;
    let frac = micronoid % MICRONOID_PER_NOID;
    if frac == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{}", format!("{frac:06}").trim_end_matches('0'))
    }
}
