// Build settings. Nothing private is committed: a build may add web/js/config.local.js (ignored by
// git), either by hand for your own builds or from repository secrets in GitHub Actions. Format:
//
//   export default {
//     officialServer: { backendUrl: 'https://api.nuvio.tv', publishableKey: '…' },
//     tmdbApiKey: '…',
//   };

const config = {
  /** The Nuvio server this build signs in to without any setup, or null. */
  officialServer: null,
  /** A TMDB key to use when the user hasn't entered their own. */
  tmdbApiKey: '',
};

try {
  const local = await import('./config.local.js');
  Object.assign(config, local.default || {});
} catch {
  // No local config in this build.
}

export default config;
