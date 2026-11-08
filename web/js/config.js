// Build settings. Nothing private is committed: a build may add web/js/config.local.js (ignored by
// git), either by hand for your own builds or from repository secrets in GitHub Actions. Format:
//
//   export default {
//     officialServer: { backendUrl: 'https://api.nuvio.tv', publishableKey: '…' },
//     tmdbApiKey: '…',
//     trakt: { clientId: '…', clientSecret: '…' },
//   };

const config = {
  /** Public Nuvio client settings; the publishable key is not a service-role secret. */
  officialServer: {
    backendUrl: 'https://api.nuvio.tv',
    publishableKey: 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN',
  },
  /** A TMDB key to use when the user hasn't entered their own. */
  tmdbApiKey: '',
  /**
   * The Trakt API app this build signs in with ({ clientId, clientSecret }, from
   * trakt.tv/oauth/applications), or null to ask for one in Settings. apiUrl only changes for
   * testing against tools/dev-trakt-server.mjs.
   */
  trakt: null,
};

try {
  const local = await import('./config.local.js');
  Object.assign(config, local.default || {});
} catch {
  // No local config in this build.
}

export default config;
