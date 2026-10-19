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
    let method: String = env.get_string(&method).map(Into::into).unwrap_or_default();
    // Arguments can carry the master secret: keep the Rust copy zeroized.
    let args: zeroize::Zeroizing<String> =
        zeroize::Zeroizing::new(env.get_string(&args_json).map(Into::into).unwrap_or_default());
    let out = crate::call(&method, &args);
    env.new_string(out).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}
