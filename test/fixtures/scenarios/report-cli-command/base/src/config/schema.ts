export const configSchema = {
  output: { type: 'string', default: 'text' },
  color: { type: 'boolean', default: true },
};

export type ConfigKey = keyof typeof configSchema;
