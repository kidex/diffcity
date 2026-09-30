// Review zones for this CLI: the config schema is plain data here, releases are not.
export default {
  tier1: (defaults) => [...defaults.filter((token) => token !== 'schema'), 'release'],
};
