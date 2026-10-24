/**
 * Expo config plugin: `["@anywalletkit/backup-cloud", { "iCloudContainer": "iCloud.<your.bundle.id>" }]`.
 *
 * Adds the iCloud Documents entitlements for the app's own container. With
 * automatic signing, `xcodebuild -allowProvisioningUpdates` / Xcode registers the
 * container on your team. No Info.plist NSUbiquitousContainers entry: the
 * backups stay in the container's hidden scope, not in the Files app.
 * iCloud Keychain needs no entitlement (the app's default access group syncs).
 */
module.exports = function withAnyWalletKitBackupCloud(config, props = {}) {
  const container = props.iCloudContainer
  if (typeof container !== 'string' || !/^iCloud\.[A-Za-z0-9.-]+$/.test(container)) {
    throw new Error('@anywalletkit/backup-cloud: pass { iCloudContainer: "iCloud.<bundle id>" } to the plugin.')
  }
  const ios = { ...(config.ios || {}) }
  const entitlements = { ...(ios.entitlements || {}) }
  const add = (key, value) => {
    const list = Array.isArray(entitlements[key]) ? entitlements[key] : []
    entitlements[key] = list.includes(value) ? list : [...list, value]
  }
  add('com.apple.developer.icloud-container-identifiers', container)
  add('com.apple.developer.ubiquity-container-identifiers', container)
  add('com.apple.developer.icloud-services', 'CloudDocuments')
  ios.entitlements = entitlements
  return { ...config, ios }
}
