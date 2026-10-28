package expo.modules.noidcore

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
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

    // Copy something worth money (a gift link) marked as sensitive, so Android 13+
    // hides it in the "copied" preview and keyboards leave it out of their history.
    Function("copySensitive") { text: String ->
      val context = appContext.reactContext ?: return@Function false
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return@Function false
      val clip = ClipData.newPlainText("NOID", text)
      clip.description.extras = PersistableBundle().apply {
        // ClipDescription.EXTRA_IS_SENSITIVE (API 33); older versions ignore it.
        putBoolean("android.content.extra.IS_SENSITIVE", true)
      }
      clipboard.setPrimaryClip(clip)
      return@Function true
    }
  }
}
