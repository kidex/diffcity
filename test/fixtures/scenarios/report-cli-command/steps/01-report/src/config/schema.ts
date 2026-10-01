export const configSchema = {
  output: { type: 'string', default: 'text' },
  color: { type: 'boolean', default: true },
  report: { type: 'string', default: 'day' },
};

export type ConfigKey = keyof typeof configSchema;
