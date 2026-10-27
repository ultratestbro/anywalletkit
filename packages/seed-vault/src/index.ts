export {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DEFAULT_ARGON2,
  MIN_PASSWORD_LENGTH,
  addProtector,
  decodeBackup,
  describeBackup,
  encodeBackup,
  openBackup,
  removeProtector,
  sealBackup,
} from './envelope.js'
export type { Argon2Params, Argon2idImpl, BackupEnvelope, BackupMeta, KdfOptions, OpenedBackup, Protector, ProtectorRecord, Unlock } from './envelope.js'
export { BackupError, isBackupError } from './errors.js'
export type { BackupErrorCode } from './errors.js'
export type { Sealed } from './envelope.js'
