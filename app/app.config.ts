import { existsSync } from 'node:fs';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// Firebase config for "NOID received" notifications. The app builds and works
// without it; notifications then stay unavailable. See SETUP-NOTIFICATIONS.md.
export default ({ config }: ConfigContext): ExpoConfig => {
  const firebase = existsSync('./google-services.json');
  return {
    ...(config as ExpoConfig),
    android: {
      ...config.android,
      ...(firebase ? { googleServicesFile: './google-services.json' } : {}),
    },
  };
};
