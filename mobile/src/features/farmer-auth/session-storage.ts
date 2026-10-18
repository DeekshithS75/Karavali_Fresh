export type SessionTokens = { accessToken: string; refreshToken?: string };
export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export const FARMER_SESSION_KEY = 'karavali-fresh.farmer.session.v1';

/** A small adapter keeps the same server token key across app instances and platform storage. */
export function createFarmerSessionStorage(storage: KeyValueStorage) {
  return {
    async read(): Promise<SessionTokens | null> {
      const serialized = await storage.getItem(FARMER_SESSION_KEY);
      if (!serialized) return null;
      try {
        const parsed = JSON.parse(serialized) as SessionTokens;
        if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) return parsed;
      } catch { /* Invalid local data is removed below. */ }
      await storage.removeItem(FARMER_SESSION_KEY);
      return null;
    },
    async save(tokens: SessionTokens) {
      if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) throw new Error('invalid_server_session');
      await storage.setItem(FARMER_SESSION_KEY, JSON.stringify(tokens));
    },
    clear: () => storage.removeItem(FARMER_SESSION_KEY),
  };
}
