export {
  CONFIG_NOT_TRUSTED_CODE,
  CONFIG_NOT_TRUSTED_NOTE,
  SETTINGS_VERSION,
  SettingsError,
  addTrustedRepo,
  createTrustCheck,
  emptySettings,
  parseSettings,
  readSettings,
  removeTrustedRepo,
  writeSettings,
} from './settings.js';
export type { ParsedSettings, TrustCheck, TrustCheckOptions, UserSettings } from './settings.js';
