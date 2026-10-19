export type SessionTokens = { accessToken: string; refreshToken?: string };
export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export const FARMER_SESSION_KEY = 'karavali-fresh.farmer.session.v1';
export const CONSUMER_SESSION_KEY = 'karavali-fresh.consumer.session.v1';
const PUSH_TOKEN_KEY = 'karavali-fresh.push-token.v1';

/** Stores one role's opaque server token without mixing Farmer and Consumer sessions. */
export function createSessionStorage(key: string, storage: KeyValueStorage) {
  return {
    readPushToken: () => storage.getItem(PUSH_TOKEN_KEY),
    savePushToken: (token: string) => storage.setItem(PUSH_TOKEN_KEY, token),
    clearPushToken: () => storage.removeItem(PUSH_TOKEN_KEY),
    async read(): Promise<SessionTokens | null> {
      const serialized = await storage.getItem(key);
      if (!serialized) return null;
      try {
        const parsed = JSON.parse(serialized) as SessionTokens;
        if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) return parsed;
      } catch { /* Invalid local data is removed below. */ }
      await storage.removeItem(key);
      return null;
    },
    async save(tokens: SessionTokens) {
      if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) throw new Error('invalid_server_session');
      await storage.setItem(key, JSON.stringify(tokens));
    },
    clear: () => storage.removeItem(key),
  };
}

export const createFarmerSessionStorage = (storage: KeyValueStorage) => createSessionStorage(FARMER_SESSION_KEY, storage);
