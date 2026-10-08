export {
  CONFIG_NOT_TRUSTED_CODE,
  CONFIG_NOT_TRUSTED_NOTE,
  SETTINGS_VERSION,
  SettingsError,
  addTrustedRepo,
  createRuleSettingsReader,
  createTrustCheck,
  emptySettings,
  parseSettings,
  readSettings,
  removeTrustedRepo,
  ruleSettingsFor,
  writeSettings,
} from './settings.js';
export type { ParsedSettings, RuleSettingsReader, TrustCheck, UserRuleSettings, TrustCheckOptions, UserSettings } from './settings.js';
