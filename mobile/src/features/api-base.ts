import Constants from 'expo-constants';
import { Platform } from 'react-native';

const API_PORT = 4000;

/**
 * Native development builds receive the current reachable host from Metro.
 * This avoids keeping yesterday's LAN IP in a bundle after the network changes.
 * Web and production builds continue to use the explicitly configured URL.
 */
export function getApiBase() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '');
  if (Platform.OS !== 'web' && __DEV__ && isLocalDevelopmentUrl(configuredUrl)) {
    const hostUri = Constants.expoConfig?.hostUri;
    if (hostUri) {
      try {
        const parsed = new URL(hostUri.includes('://') ? hostUri : `http://${hostUri}`);
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return configuredUrl;
        const hostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
        return `http://${hostname}:${API_PORT}`;
      } catch {
        // Use the configured API URL if Expo has not provided a usable host.
      }
    }
  }
  return configuredUrl;
}

function isLocalDevelopmentUrl(value?: string) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    return parsed.protocol === 'http:' && (
      host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)
    );
  } catch {
    return false;
  }
}
