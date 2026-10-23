export { createSecureStorage } from './storage.js'
export type {
  DeviceSecretStorage,
  MigrateOptions,
  MigrationResult,
  MigrationSource,
  PromptText,
  SecureStorageOptions,
  SetSecretOptions,
} from './storage.js'
export { SecureStorageError, isSecureStorageError } from './errors.js'
export type { SecureStorageErrorCode } from './errors.js'
export { PROTECTIONS } from './types.js'
export type { Protection, StoredSecretInfo } from './types.js'
export type { NativeCapabilities, NativeEntry, NativePrompt, NativeSecureStorage } from './native.js'
