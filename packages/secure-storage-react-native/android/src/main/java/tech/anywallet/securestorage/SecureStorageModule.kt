package tech.anywallet.securestorage

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Secrets encrypted with AES-256-GCM under one Android Keystore key per entry:
 *
 * - the key lives in StrongBox when the device has one, otherwise the TEE; a key
 *   that ends up outside secure hardware is deleted and the write refused;
 * - every use needs the user (`setUserAuthenticationParameters(0, …)`): the
 *   cipher is unlocked by a BiometricPrompt bound to it (CryptoObject), never by
 *   a time window;
 * - `biometricsOrPasscode` = strong biometrics or the device credential, the key
 *   survives new enrolments; `biometricsOnly` = strong biometrics only and the
 *   key is invalidated when biometrics change → ERR_FW_BIOMETRY_CHANGED;
 * - `setUnlockedDeviceRequired` (Android 9+): nothing decrypts while locked;
 * - ciphertext + IV + public metadata in `noBackupFilesDir`, so they never reach
 *   Auto Backup or device-to-device transfer (the key could not follow anyway).
 *
 * Android 11 (API 30) or newer: a CryptoObject with the device credential needs it.
 */
class SecureStorageModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("AnyWalletKitSecureStorage")

    AsyncFunction("setItem") Coroutine { namespace: String, key: String, value: String, protection: String, prompt: Map<String, String> ->
      setItem(namespace, key, value, protection, prompt)
    }

    AsyncFunction("getItem") Coroutine { namespace: String, key: String, prompt: Map<String, String> ->
      return@Coroutine getItem(namespace, key, prompt)
    }

    AsyncFunction("deleteItem") { namespace: String, key: String ->
      deleteItem(namespace, key)
    }

    AsyncFunction("listItems") { namespace: String ->
      listItems(namespace)
    }

    AsyncFunction("capabilities") {
      capabilities()
    }
  }

  // region operations

  private suspend fun setItem(namespace: String, key: String, value: String, protection: String, prompt: Map<String, String>) {
    requireApi()
    val strict = when (protection) {
      "biometricsOrPasscode" -> false
      "biometricsOnly" -> true
      else -> throw StorageException("Unknown protection $protection")
    }
    if (!keyguard().isDeviceSecure) throw NoPasscodeException()
    val authenticators = if (strict) BIOMETRIC_STRONG else BIOMETRIC_STRONG or DEVICE_CREDENTIAL
    if (BiometricManager.from(context).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
      throw NotAvailableException(if (strict) "Strict mode needs a strong biometric (fingerprint / face) enrolled." else "No usable biometrics or screen lock.")
    }

    val alias = alias(namespace, key)
    val secretKey = generateKey(alias, strict)
    try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, secretKey)
      val unlocked = authenticate(cipher, strict, prompt)
      val ciphertext = unlocked.doFinal(value.toByteArray(Charsets.UTF_8))
      val record = JSONObject()
        .put("v", 1)
        .put("p", protection)
        .put("t", System.currentTimeMillis())
        .put("iv", b64(unlocked.iv))
        .put("ct", b64(ciphertext))
      writeAtomically(file(namespace, key), record.toString())
    } catch (e: Throwable) {
      keyStore().deleteEntry(alias)
      throw e
    }
  }

  private suspend fun getItem(namespace: String, key: String, prompt: Map<String, String>): String? {
    requireApi()
    val f = file(namespace, key)
    if (!f.exists()) return null
    val record = JSONObject(f.readText())
    val strict = record.optString("p") == "biometricsOnly"
    val secretKey = keyStore().getKey(alias(namespace, key), null) as? SecretKey
      ?: throw if (strict) BiometryChangedException() else StorageException("The key for this secret is gone (device reset or restored).")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    try {
      cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, unb64(record.getString("iv"))))
    } catch (e: KeyPermanentlyInvalidatedException) {
      throw BiometryChangedException()
    }
    val unlocked = authenticate(cipher, strict, prompt)
    return String(unlocked.doFinal(unb64(record.getString("ct"))), Charsets.UTF_8)
  }

  private fun deleteItem(namespace: String, key: String) {
    keyStore().deleteEntry(alias(namespace, key))
    file(namespace, key).delete()
  }

  private fun listItems(namespace: String): List<Map<String, String>> {
    val dir = dir(namespace)
    val files = dir.listFiles { f -> f.name.endsWith(".json") } ?: return emptyList()
    return files.mapNotNull { f ->
      val key = try {
        String(Base64.decode(f.name.removeSuffix(".json"), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), Charsets.UTF_8)
      } catch (e: IllegalArgumentException) {
        return@mapNotNull null
      }
      val record = try { JSONObject(f.readText()) } catch (e: Exception) { return@mapNotNull null }
      val meta = JSONObject().put("p", record.optString("p")).put("t", record.optLong("t"))
      mapOf("key" to key, "meta" to meta.toString())
    }
  }

  private fun capabilities(): Map<String, Any?> {
    val bm = BiometricManager.from(context)
    val biometry = if (bm.canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS) "biometric" else null
    val hasStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      context.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
    return mapOf(
      "platform" to "android",
      "passcodeSet" to keyguard().isDeviceSecure,
      "biometry" to biometry,
      "hardware" to if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) null else if (hasStrongBox) "strongBox" else "tee",
    )
  }

  // endregion

  // region keys

  private fun generateKey(alias: String, strict: Boolean): SecretKey {
    keyStore().deleteEntry(alias)
    val key = try {
      buildKey(alias, strict, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    } catch (e: StrongBoxUnavailableException) {
      buildKey(alias, strict, strongBox = false)
    }
    if (!insideSecureHardware(key)) {
      keyStore().deleteEntry(alias)
      throw NotAvailableException("This device cannot keep the key in secure hardware.")
    }
    return key
  }

  private fun buildKey(alias: String, strict: Boolean, strongBox: Boolean): SecretKey {
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setRandomizedEncryptionRequired(true)
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(
        0,
        if (strict) KeyProperties.AUTH_BIOMETRIC_STRONG else KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
      )
      .setInvalidatedByBiometricEnrollment(strict)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      spec.setUnlockedDeviceRequired(true)
      if (strongBox) spec.setIsStrongBoxBacked(true)
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(spec.build())
    return generator.generateKey()
  }

  @Suppress("DEPRECATION")
  private fun insideSecureHardware(key: SecretKey): Boolean {
    val info = SecretKeyFactory.getInstance(key.algorithm, KEYSTORE).getKeySpec(key, KeyInfo::class.java) as KeyInfo
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ||
        info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    } else {
      info.isInsideSecureHardware
    }
  }

  // endregion

  // region prompt

  private suspend fun authenticate(cipher: Cipher, strict: Boolean, prompt: Map<String, String>): Cipher {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: throw LockedException("The app is not in the foreground.")
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle(prompt["title"] ?: "Unlock")
      .apply { prompt["subtitle"]?.let { setSubtitle(it) } }
      .setConfirmationRequired(false)
      .apply {
        if (strict) {
          setAllowedAuthenticators(BIOMETRIC_STRONG)
          setNegativeButtonText(prompt["cancel"] ?: "Cancel")
        } else {
          setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        }
      }
      .build()

    return withContext(Dispatchers.Main) {
      suspendCancellableCoroutine { cont ->
        val biometricPrompt = BiometricPrompt(
          activity,
          ContextCompat.getMainExecutor(activity),
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              val c = result.cryptoObject?.cipher
              if (c == null) cont.resumeWithException(AuthFailedException("No cipher in the authentication result."))
              else cont.resume(c)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
              cont.resumeWithException(mapPromptError(errorCode, errString.toString()))
            }
            // onAuthenticationFailed = one wrong finger / face; the sheet stays up and retries.
          },
        )
        cont.invokeOnCancellation { biometricPrompt.cancelAuthentication() }
        biometricPrompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
      }
    }
  }

  private fun mapPromptError(code: Int, message: String): CodedException = when (code) {
    BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED -> CancelledException()
    BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> LockoutException(message)
    BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> NoPasscodeException()
    BiometricPrompt.ERROR_NO_BIOMETRICS, BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE ->
      NotAvailableException(message)
    else -> AuthFailedException(message)
  }

  // endregion

  // region files

  private fun dir(namespace: String): File = File(context.noBackupFilesDir, "anywalletkit-secure-storage/$namespace")

  private fun file(namespace: String, key: String): File {
    val name = Base64.encodeToString(key.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    return File(dir(namespace), "$name.json")
  }

  private fun writeAtomically(target: File, text: String) {
    target.parentFile?.mkdirs()
    val tmp = File(target.parentFile, "${target.name}.tmp")
    tmp.writeText(text)
    if (!tmp.renameTo(target)) {
      tmp.delete()
      throw StorageException("Could not write ${target.name}")
    }
  }

  // endregion

  private fun keyguard() = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private fun alias(namespace: String, key: String) = "tech.anywallet.secure-storage/$namespace/$key"

  private fun requireApi() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw NotAvailableException("Android 11 or newer is required.")
  }

  private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

  private fun unb64(text: String) = Base64.decode(text, Base64.NO_WRAP)

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}

// Codes mapped in src/errors.ts.
internal class CancelledException : CodedException("ERR_FW_CANCELLED", "The user cancelled the authentication.", null)
internal class BiometryChangedException :
  CodedException("ERR_FW_BIOMETRY_CHANGED", "Biometrics changed since this secret was stored in strict mode; it can no longer be read.", null)
internal class LockoutException(message: String) : CodedException("ERR_FW_LOCKOUT", message, null)
internal class NoPasscodeException : CodedException("ERR_FW_NO_PASSCODE", "Set a screen lock to store wallet secrets.", null)
internal class NotAvailableException(message: String) : CodedException("ERR_FW_NOT_AVAILABLE", message, null)
internal class LockedException(message: String) : CodedException("ERR_FW_LOCKED", message, null)
internal class AuthFailedException(message: String) : CodedException("ERR_FW_AUTH_FAILED", message, null)
internal class StorageException(message: String) : CodedException("ERR_FW_STORAGE", message, null)
