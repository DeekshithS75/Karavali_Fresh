type Language = 'en' | 'kn' | 'tcy';
import { VERIFIED_MARKET_COMMODITIES } from '../providers/market-commodities.js';

const KNOWN_KN: Record<string, string> = {
  tomato: 'ಟೊಮೇಟೊ', tomatoes: 'ಟೊಮೇಟೊ', brinjal: 'ಬದನೆಕಾಯಿ', eggplant: 'ಬದನೆಕಾಯಿ',
  'ladies finger': 'ಬೆಂಡೆಕಾಯಿ', okra: 'ಬೆಂಡೆಕಾಯಿ', beans: 'ಬೀನ್ಸ್', carrot: 'ಕ್ಯಾರೆಟ್',
  cabbage: 'ಎಲೆಕೋಸು', cauliflower: 'ಹೂಕೋಸು', cucumber: 'ಸೌತೆಕಾಯಿ',
};

type NotificationEvent = 'request_created' | 'request_decided' | 'call_queued' | 'call_initiated' | 'call_failed' | 'call_completed';

export function notificationCopy(language: Language | undefined, event: NotificationEvent, data: {
  buyerName?: string; vegetableName?: string; quantity?: number; unit?: string; decision?: 'accepted' | 'rejected'; failureCode?: string;
}) {
  // Tulu push copy falls back to English until reviewed Tulu notification translations are available.
  const lang = language === 'kn' ? 'kn' : 'en';
  if (event === 'request_created') {
    const raw = data.vegetableName ?? 'produce';
    const official = Object.keys(VERIFIED_MARKET_COMMODITIES).find((name) => name.toLocaleLowerCase('en-IN') === raw.trim().toLocaleLowerCase('en-IN'));
    const verifiedAlias = official ? VERIFIED_MARKET_COMMODITIES[official as keyof typeof VERIFIED_MARKET_COMMODITIES].find((name) => /[\u0c80-\u0cff]/u.test(name)) : undefined;
    const vegetable = lang === 'kn' ? KNOWN_KN[raw.trim().toLocaleLowerCase('en-IN')] ?? verifiedAlias ?? raw : raw;
    const quantity = `${data.quantity ?? ''} ${lang === 'kn' ? ({ kg: 'ಕೆಜಿ', quintal: 'ಕ್ವಿಂಟಾಲ್', bunch: 'ಕಟ್ಟು', pieces: 'ತುಂಡು' }[data.unit ?? ''] ?? data.unit ?? '') : data.unit ?? ''}`.trim();
    const shorten = (value: string, maximum: number) => value.length > maximum ? `${value.slice(0, maximum - 1).trimEnd()}…` : value;
    const buyer = shorten(data.buyerName || (lang === 'kn' ? 'ಖರೀದಿದಾರರು' : 'A buyer'), 32);
    const displayVegetable = shorten(vegetable, 44);
    return lang === 'kn'
      ? { title: 'ಹೊಸ ಉತ್ಪನ್ನ ವಿನಂತಿ', body: `${buyer} ${displayVegetable} ${quantity} ಕೇಳಿದ್ದಾರೆ. ಒಪ್ಪಿಕೊಳ್ಳಿ ಅಥವಾ ನಿರಾಕರಿಸಿ?` }
      : { title: 'New produce request', body: `${buyer} wants ${quantity} of ${displayVegetable}. Accept or decline?` };
  }
  if (event === 'call_queued') return lang === 'kn'
    ? { title: 'ಕರೆ ವಿನಂತಿ ಕ್ಯೂನಲ್ಲಿ ಇದೆ', body: 'ಕರೆ ಸೇವೆ ವಿನಂತಿಯನ್ನು ಸ್ವೀಕರಿಸಿದೆ. ಕರೆ ಸ್ಥಿತಿಯನ್ನು ನವೀಕರಿಸುತ್ತೇವೆ.' }
    : { title: 'Call request queued', body: 'The call provider accepted the request. We will update you when it connects.' };
  if (event === 'call_initiated') return lang === 'kn'
    ? { title: 'ಕರೆ ಸಂಪರ್ಕದಲ್ಲಿದೆ', body: 'Karavali Fresh ವ್ಯವಹಾರ ಸಂಖ್ಯೆಯಿಂದ ಕರೆ ಬರುತ್ತದೆ. ವೈಯಕ್ತಿಕ ಸಂಖ್ಯೆಗಳು ಹಂಚಿಕೊಳ್ಳುವುದಿಲ್ಲ.' }
    : { title: 'Call connecting', body: 'Expect a call through Karavali Fresh. Personal phone numbers are not shared.' };
  if (event === 'call_completed') return lang === 'kn'
    ? { title: 'ಕರೆ ಪೂರ್ಣಗೊಂಡಿದೆ', body: 'ವ್ಯವಹಾರ ಕರೆ ಮುಗಿದಿದೆ. ವಿನಂತಿಯ ವಿವರಗಳನ್ನು ಪರಿಶೀಲಿಸಿ.' }
    : { title: 'Call completed', body: 'The business call has ended. Check the request for details.' };
  if (data.failureCode === 'provider_not_configured') return lang === 'kn'
    ? { title: 'ಸ್ವಯಂಚಾಲಿತ ಕರೆ ಲಭ್ಯವಿಲ್ಲ', body: 'ಕರೆ ಸೇವೆ ಹೊಂದಿಸಲಾಗಿಲ್ಲ. ನಿಮ್ಮ ವೈಯಕ್ತಿಕ ಸಂಪರ್ಕ ವಿವರಗಳನ್ನು ಹಂಚಿಕೊಂಡಿಲ್ಲ.' }
    : { title: 'Automatic calling unavailable', body: 'Calling is not configured. No personal contact details were shared.' };
  if (data.failureCode === 'no-answer' || data.failureCode === 'busy') return lang === 'kn'
    ? { title: 'ಕರೆ ಸಂಪರ್ಕವಾಗಲಿಲ್ಲ', body: 'ಇನ್ನೊಬ್ಬರು ಕರೆ ಸ್ವೀಕರಿಸಲಿಲ್ಲ. ರೈತರು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಬಹುದು.' }
    : { title: 'Call did not connect', body: 'The other person did not answer. The farmer can retry the call.' };
  return lang === 'kn'
    ? { title: 'ವಿನಂತಿಯ ಸ್ಥಿತಿ ಬದಲಾಗಿದೆ', body: data.decision === 'accepted' ? 'ರೈತರು ನಿಮ್ಮ ಉತ್ಪನ್ನ ವಿನಂತಿಯನ್ನು ಒಪ್ಪಿದ್ದಾರೆ.' : 'ರೈತರು ನಿಮ್ಮ ಉತ್ಪನ್ನ ವಿನಂತಿಯನ್ನು ನಿರಾಕರಿಸಿದ್ದಾರೆ.' }
    : { title: 'Request status updated', body: data.decision === 'accepted' ? 'The farmer accepted your produce request.' : 'The farmer declined your produce request.' };
}
