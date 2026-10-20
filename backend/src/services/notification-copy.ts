type Language = 'en' | 'kn' | 'tcy';
import { VERIFIED_MARKET_COMMODITIES } from '../providers/market-commodities.js';

const KNOWN_KN: Record<string, string> = {
  tomato: 'ಟೊಮೇಟೊ', tomatoes: 'ಟೊಮೇಟೊ', brinjal: 'ಬದನೆಕಾಯಿ', eggplant: 'ಬದನೆಕಾಯಿ',
  'ladies finger': 'ಬೆಂಡೆಕಾಯಿ', okra: 'ಬೆಂಡೆಕಾಯಿ', beans: 'ಬೀನ್ಸ್', carrot: 'ಕ್ಯಾರೆಟ್',
  cabbage: 'ಎಲೆಕೋಸು', cauliflower: 'ಹೂಕೋಸು', cucumber: 'ಸೌತೆಕಾಯಿ',
};

export function notificationCopy(language: Language | undefined, event: 'request_created' | 'request_decided', data: {
  buyerName?: string; vegetableName?: string; quantity?: number; unit?: string; decision?: 'accepted' | 'rejected';
}) {
  // Tulu push copy falls back to English until reviewed Tulu notification translations are available.
  const lang = language === 'kn' ? 'kn' : 'en';
  if (event === 'request_created') {
    const raw = data.vegetableName ?? 'produce';
    const official = Object.keys(VERIFIED_MARKET_COMMODITIES).find((name) => name.toLocaleLowerCase('en-IN') === raw.trim().toLocaleLowerCase('en-IN'));
    const verifiedAlias = official ? VERIFIED_MARKET_COMMODITIES[official as keyof typeof VERIFIED_MARKET_COMMODITIES].find((name) => /[\u0c80-\u0cff]/u.test(name)) : undefined;
    const vegetable = lang === 'kn' ? KNOWN_KN[raw.trim().toLocaleLowerCase('en-IN')] ?? verifiedAlias ?? raw : raw;
    const quantity = `${data.quantity ?? ''} ${lang === 'kn' ? ({ kg: 'ಕೆಜಿ', quintal: 'ಕ್ವಿಂಟಾಲ್', bunch: 'ಕಟ್ಟು', pieces: 'ತುಂಡು' }[data.unit ?? ''] ?? data.unit ?? '') : data.unit ?? ''}`.trim();
    const buyer = data.buyerName || (lang === 'kn' ? 'ಖರೀದಿದಾರರು' : 'A buyer');
    return lang === 'kn'
      ? { title: 'ಹೊಸ ಉತ್ಪನ್ನ ವಿನಂತಿ', body: `${buyer} ${vegetable} ${quantity} ಕೇಳಿದ್ದಾರೆ. ಒಪ್ಪಿಕೊಳ್ಳಿ ಅಥವಾ ನಿರಾಕರಿಸಿ?` }
      : { title: 'New produce request', body: `${buyer} wants ${quantity} of ${vegetable}. Accept or decline?` };
  }
  return lang === 'kn'
    ? { title: 'ವಿನಂತಿಯ ಸ್ಥಿತಿ ಬದಲಾಗಿದೆ', body: data.decision === 'accepted' ? 'ರೈತರು ನಿಮ್ಮ ಉತ್ಪನ್ನ ವಿನಂತಿಯನ್ನು ಒಪ್ಪಿದ್ದಾರೆ.' : 'ರೈತರು ನಿಮ್ಮ ಉತ್ಪನ್ನ ವಿನಂತಿಯನ್ನು ನಿರಾಕರಿಸಿದ್ದಾರೆ.' }
    : { title: 'Request status updated', body: data.decision === 'accepted' ? 'The farmer accepted your produce request.' : 'The farmer declined your produce request.' };
}
