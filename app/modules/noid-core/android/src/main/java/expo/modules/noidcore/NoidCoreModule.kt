package expo.modules.noidcore

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JNI entry point into the Rust wallet core (core/src/android.rs). */
object NoidCoreNative {
  init {
    System.loadLibrary("noid_mobile_core")
  }

  @JvmStatic
  external fun nativeCall(method: String, argsJson: String): String
}

class NoidCoreModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NoidCore")

    // Runs off the JS thread, so proving (1-3 s) never freezes the UI.
    // Returns the core's JSON envelope: {"ok": ...} or {"error": {...}}.
    AsyncFunction("call") { method: String, argsJson: String ->
      return@AsyncFunction NoidCoreNative.nativeCall(method, argsJson)
    }
  }
}
