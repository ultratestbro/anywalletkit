import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

/**
 * iCloud for wallet backups.
 *
 * Drive: small files in `<ubiquity container>/<folder>` — the container's
 * hidden scope (not `Documents/`), so they don't show in the Files app. Every
 * read and write goes through NSFileCoordinator; a file iCloud hasn't
 * downloaded yet on this device (a placeholder) is downloaded on read.
 *
 * Keychain: synchronizable generic-password items (iCloud Keychain, end-to-end
 * encrypted by Apple). A synced item can't be ThisDeviceOnly nor carry a
 * biometric ACL, so it holds only a backup KEY — the backup file lives in
 * Drive, and neither one alone opens it. The key is WhenUnlocked (never
 * readable while the phone is locked, AFU included) and this module asks for
 * the device owner (Face ID / Touch ID / passcode) before returning it — the
 * app can't read it silently. One confirmation covers reads for 30 s, so a
 * multi-wallet backup or restore asks once. Files are written with complete
 * file protection.
 */
public class BackupCloudModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ForgewalletBackupCloud")

    AsyncFunction("driveStatus") { (container: String) -> [String: Any] in
      let signedIn = FileManager.default.ubiquityIdentityToken != nil
      let url = signedIn ? FileManager.default.url(forUbiquityContainerIdentifier: container) : nil
      return ["signedIn": signedIn, "container": url != nil]
    }

    AsyncFunction("driveList") { (container: String, folder: String) -> [[String: Any]] in
      try Self.list(try Self.folder(container, folder))
    }

    AsyncFunction("driveWrite") { (container: String, folder: String, name: String, text: String) in
      let dir = try Self.folder(container, folder)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try Self.coordinatedWrite(Data(text.utf8), to: dir.appendingPathComponent(try Self.checked(name)))
    }

    AsyncFunction("driveRead") { (container: String, folder: String, name: String, timeoutMs: Int) -> String? in
      let url = try Self.folder(container, folder).appendingPathComponent(try Self.checked(name))
      guard let data = try Self.coordinatedRead(url, timeout: Double(timeoutMs) / 1000) else { return nil }
      guard let text = String(data: data, encoding: .utf8) else { throw BackupCloudException("The backup file is not UTF-8.") }
      return text
    }

    AsyncFunction("driveDelete") { (container: String, folder: String, name: String) in
      let url = try Self.folder(container, folder).appendingPathComponent(try Self.checked(name))
      try Self.coordinatedDelete(url)
    }

    AsyncFunction("keychainHas") { (service: String, account: String) -> Bool in
      // Attributes only: a synced item carries no access control, so this never prompts.
      var query = Self.keychainQuery(service, account)
      query[kSecReturnAttributes as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      let status = SecItemCopyMatching(query as CFDictionary, nil)
      if status == errSecItemNotFound { return false }
      guard status == errSecSuccess else { throw BackupCloudException("Keychain lookup failed (\(status)).") }
      return true
    }

    AsyncFunction("keychainGet") { (service: String, account: String, reason: String) -> String? in
      var query = Self.keychainQuery(service, account)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      // Nothing there → nothing to protect, no prompt.
      var probe = Self.keychainQuery(service, account)
      probe[kSecMatchLimit as String] = kSecMatchLimitOne
      if SecItemCopyMatching(probe as CFDictionary, nil) == errSecItemNotFound { return nil }
      try Self.requireDeviceOwner(reason)
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound { return nil }
      guard status == errSecSuccess, let data = result as? Data else { throw BackupCloudException("Keychain read failed (\(status)).") }
      // Keys written by 0.1.0 were AfterFirstUnlock: raise them to WhenUnlocked (still synced).
      SecItemUpdate(Self.keychainQuery(service, account) as CFDictionary, [kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked] as CFDictionary)
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("keychainSet") { (service: String, account: String, value: String) in
      let query = Self.keychainQuery(service, account)
      SecItemDelete(query as CFDictionary)
      var add = query
      add[kSecValueData as String] = Data(value.utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
      let status = SecItemAdd(add as CFDictionary, nil)
      guard status == errSecSuccess else { throw BackupCloudException("Keychain write failed (\(status)).") }
    }

    AsyncFunction("keychainDelete") { (service: String, account: String) in
      let status = SecItemDelete(Self.keychainQuery(service, account) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw BackupCloudException("Keychain delete failed (\(status)).") }
    }
  }

  // MARK: - Drive

  private static func folder(_ container: String, _ folder: String) throws -> URL {
    guard FileManager.default.ubiquityIdentityToken != nil else { throw NotSignedInException() }
    guard let root = FileManager.default.url(forUbiquityContainerIdentifier: container) else {
      throw BackupCloudException("iCloud container \(container) is not available — check the app's iCloud entitlement.")
    }
    return root.appendingPathComponent(try checked(folder), isDirectory: true)
  }

  private static func checked(_ name: String) throws -> String {
    let ok = !name.isEmpty && name.count <= 200 && !name.hasPrefix(".") &&
      name.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "._-".unicodeScalars.contains($0) }
    guard ok else { throw BackupCloudException("Bad file name.") }
    return name
  }

  /** Real files and iCloud placeholders (".name.icloud" — present in iCloud, not downloaded here). */
  private static func list(_ dir: URL) throws -> [[String: Any]] {
    guard FileManager.default.fileExists(atPath: dir.path) else { return [] }
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    let entries = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [])
    var out: [[String: Any]] = []
    for url in entries {
      var name = url.lastPathComponent
      var downloaded = true
      if name.hasPrefix(".") && name.hasSuffix(".icloud") {
        name = String(name.dropFirst().dropLast(".icloud".count))
        downloaded = false
      } else if name.hasPrefix(".") {
        continue
      }
      let values = try? url.resourceValues(forKeys: Set(keys))
      out.append([
        "name": name,
        "downloaded": downloaded,
        "modifiedAt": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
      ])
    }
    return out
  }

  private static func coordinatedWrite(_ data: Data, to url: URL) throws {
    var coordError: NSError?
    var writeError: Error?
    NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { target in
      do { try data.write(to: target, options: [.atomic, .completeFileProtection]) } catch { writeError = error }
    }
    if let e = coordError ?? writeError { throw BackupCloudException("Could not write the backup: \(e.localizedDescription)") }
  }

  private static func coordinatedRead(_ url: URL, timeout: Double) throws -> Data? {
    let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    let fm = FileManager.default
    if !fm.fileExists(atPath: url.path) {
      guard fm.fileExists(atPath: placeholder.path) else { return nil }
      try fm.startDownloadingUbiquitousItem(at: url)
      let deadline = Date().addingTimeInterval(timeout)
      while !fm.fileExists(atPath: url.path) {
        if Date() > deadline { throw BackupCloudException("iCloud did not download the backup in time — check the connection and try again.") }
        Thread.sleep(forTimeInterval: 0.25)
      }
    }
    var coordError: NSError?
    var result: Data?
    var readError: Error?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { target in
      do { result = try Data(contentsOf: target) } catch { readError = error }
    }
    if let e = coordError ?? readError { throw BackupCloudException("Could not read the backup: \(e.localizedDescription)") }
    return result
  }

  private static func coordinatedDelete(_ url: URL) throws {
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    var coordError: NSError?
    var deleteError: Error?
    NSFileCoordinator().coordinate(writingItemAt: url, options: .forDeleting, error: &coordError) { target in
      do { try FileManager.default.removeItem(at: target) } catch { deleteError = error }
    }
    if let e = coordError ?? deleteError { throw BackupCloudException("Could not delete the backup: \(e.localizedDescription)") }
  }

  // MARK: - Device owner

  private static let authLock = NSLock()
  private static var authorizedUntil = Date.distantPast
  private static let authReuse: TimeInterval = 30

  /** Face ID / Touch ID / passcode before a backup key leaves the keychain; one success covers 30 s. */
  private static func requireDeviceOwner(_ reason: String) throws {
    authLock.lock()
    defer { authLock.unlock() }
    if Date() < authorizedUntil { return }
    let context = LAContext()
    var policyError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
      throw BackupCloudException("Set a device passcode to open wallet backups.")
    }
    let done = DispatchSemaphore(value: 0)
    var outcome: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason.isEmpty ? "Open your wallet backup" : reason) { ok, error in
      if !ok { outcome = error ?? LAError(.authenticationFailed) }
      done.signal()
    }
    done.wait()
    if let e = outcome as? LAError, [.userCancel, .appCancel, .systemCancel].contains(e.code) { throw BackupCancelledException() }
    if let e = outcome { throw BackupCloudException("Authentication failed: \(e.localizedDescription)") }
    authorizedUntil = Date().addingTimeInterval(authReuse)
  }

  // MARK: - Keychain

  private static func keychainQuery(_ service: String, _ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: true,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }
}

final class NotSignedInException: Exception {
  override var code: String { "ERR_FW_ICLOUD_SIGNED_OUT" }
  override var reason: String { "Sign in to iCloud (Settings › your name) and turn on iCloud Drive." }
}

final class BackupCancelledException: Exception {
  override var code: String { "ERR_FW_CANCELLED" }
  override var reason: String { "The user cancelled the authentication." }
}

final class BackupCloudException: GenericException<String> {
  override var code: String { "ERR_FW_BACKUP_CLOUD" }
  override var reason: String { param }
}
