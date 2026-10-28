//! JNI bridge for the Expo native module `NoidCore` (app/modules/noid-core).
//! Kotlin: `object NoidCoreNative { @JvmStatic external fun nativeCall(method: String, argsJson: String): String }`

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

#[no_mangle]
pub extern "system" fn Java_expo_modules_noidcore_NoidCoreNative_nativeCall<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    method: JString<'a>,
    args_json: JString<'a>,
) -> jstring {
    // A failed conversion leaves a Java exception pending: clear it before the
    // next JNI call, and answer with an error instead of guessing the input.
    let method: Option<String> = env.get_string(&method).map(Into::into).ok();
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
    }
    // Arguments can carry the master secret: keep the Rust copy zeroized.
    let args: Option<zeroize::Zeroizing<String>> = env.get_string(&args_json).map(|s| zeroize::Zeroizing::new(s.into())).ok();
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
    }
    let out = match (method, args) {
        (Some(m), Some(a)) => crate::call(&m, &a),
        _ => r#"{"error":{"code":"bridge","message":"The wallet core could not read this request."}}"#.to_string(),
    };
    match env.new_string(out) {
        Ok(s) => s.into_raw(),
        Err(_) => {
            let _ = env.exception_clear();
            // Never hand null to Kotlin's non-null String.
            env.new_string(r#"{"error":{"code":"bridge","message":"The wallet core could not answer."}}"#)
                .map(|s| s.into_raw())
                .unwrap_or(std::ptr::null_mut())
        }
    }
}
