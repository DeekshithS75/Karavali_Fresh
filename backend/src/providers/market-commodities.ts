/**
 * Exact names and reviewed aliases for official AGMARKNET commodities.
 * Every official commodity below was observed in a bounded live Karnataka API
 * response on 2026-10-18. The API's substring-like filters may return neighbors,
 * so callers must still compare the returned commodity exactly.
 */
export const VERIFIED_MARKET_COMMODITIES = {
  Tomato: ['tomato', 'tomatoes', 'ಟೊಮೇಟೊ', 'ಟೊಮ್ಯಾಟೊ'],
  Brinjal: ['brinjal', 'eggplant', 'aubergine', 'ಬದನೆಕಾಯಿ'],
  'Ladies Finger': ['ladies finger', 'lady finger', 'okra', 'bhindi', 'ಬೆಂಡೆಕಾಯಿ'],
  'Ridgeguard(Tori)': ['ridge gourd', 'ridgeguard tori', 'ಹೀರೆಕಾಯಿ'],
  'Green Chilli': ['green chilli', 'green chili', 'ಹಸಿಮೆಣಸಿನಕಾಯಿ'],
  Beans: ['beans', 'ಬೀನ್ಸ್'],
  'Bottle gourd': ['bottle gourd', 'lauki', 'ಸೊರೆಕಾಯಿ'],
  'Bitter gourd': ['bitter gourd', 'bitter melon', 'ಹಾಗಲಕಾಯಿ'],
  Cauliflower: ['cauliflower', 'ಹೂಕೋಸು'],
  Cabbage: ['cabbage', 'ಎಲೆಕೋಸು'],
  Carrot: ['carrot', 'ಕ್ಯಾರೆಟ್'],
  Beetroot: ['beetroot', 'ಬೀಟ್ರೂಟ್'],
  Capsicum: ['capsicum', 'ದೊಣ್ಣೆ ಮೆಣಸಿನಕಾಯಿ'],
  Drumstick: ['drumstick', 'ನುಗ್ಗೆಕಾಯಿ'],
  Raddish: ['raddish', 'radish', 'ಮೂಲಂಗಿ'],
  'Cucumbar(Kheera)': ['cucumber', 'kheera', 'ಸೌತೆಕಾಯಿ'],
} as const;

export function normalizeCommodityName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-IN').replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const aliasToOfficial = new Map<string, string>();
for (const [official, aliases] of Object.entries(VERIFIED_MARKET_COMMODITIES)) {
  aliasToOfficial.set(normalizeCommodityName(official), official);
  for (const alias of aliases) aliasToOfficial.set(normalizeCommodityName(alias), official);
}

/** Resolves only exact, live-verified official names or explicit reviewed aliases. */
export function resolveOfficialCommodity(names: string[]): string | null {
  const resolved = new Set(names
    .map((name) => name.normalize('NFKC').trim())
    .filter((name) => name.length > 0 && name.length <= 120)
    .map((name) => aliasToOfficial.get(normalizeCommodityName(name)))
    .filter((name): name is string => Boolean(name)));
  return resolved.size === 1 ? [...resolved][0]! : null;
}
