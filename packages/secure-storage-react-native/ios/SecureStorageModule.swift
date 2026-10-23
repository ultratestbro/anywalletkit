import ExpoModulesCore
import LocalAuthentication
import Security

/**
 * Secrets as iOS Keychain generic-password items, one per key:
 *
 * - `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — never in iCloud Keychain,
 *   never restored from a backup onto another device, readable only while unlocked;
 * - a `SecAccessControl` evaluated by the Secure Enclave on every read:
 *   `.userPresence` (Face ID / Touch ID, passcode fallback) or
 *   `.biometryCurrentSet` (the biometrics enrolled now; re-enrolling kills the item);
 * - the data protection keychain (`kSecUseDataProtectionKeychain`).
 *
 * iOS asks for Face ID even to read the *attributes* of an access-controlled
 * item, so the public metadata (protection, created-at, biometry state hash)
 * lives in a second, plain item per key under `<service>.meta`. Listing, `has`
 * and the strict-mode check read only those — the one Face ID sheet per read is
 * the secret itself.
 *
 * A strict item is checked against the current biometry state hash before the
 * read: a changed hash means `ERR_FW_BIOMETRY_CHANGED`, never a Face ID sheet
 * that cannot succeed.
 */
public class SecureStorageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ForgewalletSecureStorage")

    AsyncFunction("setItem") { (namespace: String, key: String, value: String, protection: String, prompt: [String: String]) in
      try Self.set(service: Self.service(namespace), key: key, value: value, protection: protection)
    }

    AsyncFunction("getItem") { (namespace: String, key: String, prompt: [String: String]) -> String? in
      try Self.get(service: Self.service(namespace), key: key, reason: prompt["reason"] ?? "Unlock")
    }

    AsyncFunction("deleteItem") { (namespace: String, key: String) in
      try Self.delete(service: Self.service(namespace), key: key)
    }

    AsyncFunction("listItems") { (namespace: String) -> [[String: String]] in
      try Self.list(service: Self.service(namespace))
    }

    AsyncFunction("capabilities") { () -> [String: Any?] in
      Self.capabilities()
    }
  }

  private static func service(_ namespace: String) -> String {
    "tech.anywallet.secure-storage.\(namespace)"
  }

  private static func metaService(_ service: String) -> String {
    "\(service).meta"
  }

  /** Marker in the meta service: secrets written before the meta items existed were indexed once. */
  private static let indexedMarker = "#indexed-v1"

  // MARK: - Operations

  private static func set(service: String, key: String, value: String, protection: String) throws {
    let flags: SecAccessControlCreateFlags
    var meta: [String: Any] = ["v": 1, "p": protection, "t": Int64(Date().timeIntervalSince1970 * 1000)]
    switch protection {
    case "biometricsOrPasscode":
      guard passcodeSet() else { throw NoPasscodeException() }
      flags = .userPresence
    case "biometricsOnly":
      guard passcodeSet() else { throw NoPasscodeException() }
      guard let hash = biometryStateHash() else { throw NotAvailableException("Strict mode needs Face ID or Touch ID enrolled on this device.") }
      flags = .biometryCurrentSet
      meta["b"] = hash.base64EncodedString()
    default:
      throw StorageException("Unknown protection \(protection)")
    }

    var acError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &acError) else {
      throw StorageException("SecAccessControl: \(acError?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    let metaData = try JSONSerialization.data(withJSONObject: meta)

    // Access control cannot be changed on an existing item: replace it.
    SecItemDelete(itemQuery(service: service, key: key) as CFDictionary)
    var add = itemQuery(service: service, key: key)
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessControl as String] = access
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw mapStatus(status) }

    do {
      try writeMeta(service: service, key: key, data: metaData)
    } catch {
      SecItemDelete(itemQuery(service: service, key: key) as CFDictionary)
      throw error
    }
  }

  private static func get(service: String, key: String, reason: String) throws -> String? {
    try ensureIndexed(service: service)
    guard let meta = try readMeta(service: service, key: key) else { return nil }
    if meta["p"] as? String == "biometricsOnly" {
      // Re-enrolled or removed biometrics make a .biometryCurrentSet item unreadable for good.
      let stored = (meta["b"] as? String).flatMap { Data(base64Encoded: $0) }
      guard let current = biometryStateHash(), let stored, stored == current else {
        throw BiometryChangedException()
      }
    }

    let context = LAContext()
    context.localizedReason = reason
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var query = itemQuery(service: service, key: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationContext as String] = context

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw mapStatus(status) }
    guard let text = String(data: data, encoding: .utf8) else { throw StorageException("Stored value is not UTF-8") }
    return text
  }

  private static func delete(service: String, key: String) throws {
    let status = SecItemDelete(itemQuery(service: service, key: key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw mapStatus(status) }
    let metaStatus = SecItemDelete(itemQuery(service: metaService(service), key: key) as CFDictionary)
    guard metaStatus == errSecSuccess || metaStatus == errSecItemNotFound else { throw mapStatus(metaStatus) }
  }

  /** Every key of the namespace with its metadata — plain items only, never a prompt (after the one-time index). */
  private static func list(service: String) throws -> [[String: String]] {
    try ensureIndexed(service: service)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: metaService(service),
      kSecUseDataProtectionKeychain as String: true,
      kSecReturnAttributes as String: true,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else { throw mapStatus(status) }
    return items.compactMap { item in
      guard let key = item[kSecAttrAccount as String] as? String, key != indexedMarker else { return nil }
      let meta = (item[kSecValueData as String] as? Data).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
      return ["key": key, "meta": meta]
    }
  }

  private static func capabilities() -> [String: Any?] {
    let context = LAContext()
    var error: NSError?
    let hasBiometry = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    var biometry: String? = nil
    if hasBiometry {
      switch context.biometryType {
      case .faceID: biometry = "faceId"
      case .touchID: biometry = "touchId"
      default:
        if #available(iOS 17.0, *), context.biometryType == .opticID { biometry = "opticId" } else { biometry = "biometric" }
      }
    }
    #if targetEnvironment(simulator)
    let hardware: String? = nil
    #else
    let hardware: String? = "secureEnclave"
    #endif
    return ["platform": "ios", "passcodeSet": passcodeSet(), "biometry": biometry, "hardware": hardware]
  }

  // MARK: - Meta items

  private static func writeMeta(service: String, key: String, data: Data) throws {
    let query = itemQuery(service: metaService(service), key: key)
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw mapStatus(status) }
  }

  private static func readMeta(service: String, key: String) throws -> [String: Any]? {
    var query = itemQuery(service: metaService(service), key: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw mapStatus(status) }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  }

  /**
   * Builds 0.1.0-pre kept the metadata in `kSecAttrGeneric` of the secret item
   * itself. Copy it into meta items once — reading those attributes asks for
   * Face ID per item, a single time; a namespace with no secret items (every
   * fresh install) is marked without any prompt.
   */
  private static func ensureIndexed(service: String) throws {
    let marker = itemQuery(service: metaService(service), key: indexedMarker)
    if SecItemCopyMatching(marker as CFDictionary, nil) == errSecSuccess { return }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecUseDataProtectionKeychain as String: true,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let items = result as? [[String: Any]] {
      for item in items {
        guard let key = item[kSecAttrAccount as String] as? String,
              let data = item[kSecAttrGeneric as String] as? Data else { continue }
        try writeMeta(service: service, key: key, data: data)
      }
    } else if status != errSecItemNotFound {
      throw mapStatus(status)
    }
    try writeMeta(service: service, key: indexedMarker, data: Data("{}".utf8))
  }

  // MARK: - Helpers

  private static func itemQuery(service: String, key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrSynchronizable as String: false,
    ]
  }

  private static func passcodeSet() -> Bool {
    LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
  }

  /** Changes whenever a face / finger is added or removed; nil when no biometry is enrolled. */
  private static func biometryStateHash() -> Data? {
    let context = LAContext()
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
    if #available(iOS 18.0, *) {
      return context.domainState.biometry.stateHash
    }
    return context.evaluatedPolicyDomainState
  }

  private static func mapStatus(_ status: OSStatus) -> Exception {
    switch status {
    case errSecUserCanceled: return CancelledException()
    case errSecAuthFailed: return AuthFailedException()
    case errSecInteractionNotAllowed: return LockedException()
    case errSecNotAvailable: return NotAvailableException("The Keychain is not available.")
    default:
      let text = (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
      return StorageException(text)
    }
  }
}

// MARK: - Errors (codes mapped in src/errors.ts)

final class CancelledException: Exception {
  override var code: String { "ERR_FW_CANCELLED" }
  override var reason: String { "The user cancelled the authentication." }
}

final class BiometryChangedException: Exception {
  override var code: String { "ERR_FW_BIOMETRY_CHANGED" }
  override var reason: String { "Face ID / Touch ID changed since this secret was stored in strict mode; it can no longer be read." }
}

final class NoPasscodeException: Exception {
  override var code: String { "ERR_FW_NO_PASSCODE" }
  override var reason: String { "Set a device passcode to store wallet secrets." }
}

final class AuthFailedException: Exception {
  override var code: String { "ERR_FW_AUTH_FAILED" }
  override var reason: String { "Authentication failed." }
}

final class LockedException: Exception {
  override var code: String { "ERR_FW_LOCKED" }
  override var reason: String { "The device is locked or the prompt could not be shown." }
}

final class NotAvailableException: GenericException<String> {
  override var code: String { "ERR_FW_NOT_AVAILABLE" }
  override var reason: String { param }
}

final class StorageException: GenericException<String> {
  override var code: String { "ERR_FW_STORAGE" }
  override var reason: String { "Keychain: \(param)" }
}
