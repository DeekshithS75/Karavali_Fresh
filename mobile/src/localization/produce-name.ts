import type { LanguageCode } from './types';

const KANNADA_NAMES: Record<string, string> = {
  tomato: 'ಟೊಮೇಟೊ', tomatoes: 'ಟೊಮೇಟೊ', brinjal: 'ಬದನೆಕಾಯಿ', eggplant: 'ಬದನೆಕಾಯಿ',
  aubergine: 'ಬದನೆಕಾಯಿ', 'ladies finger': 'ಬೆಂಡೆಕಾಯಿ', 'lady finger': 'ಬೆಂಡೆಕಾಯಿ',
  okra: 'ಬೆಂಡೆಕಾಯಿ', bhindi: 'ಬೆಂಡೆಕಾಯಿ', 'ridge gourd': 'ಹೀರೆಕಾಯಿ', 'ridgeguard tori': 'ಹೀರೆಕಾಯಿ',
  'green chilli': 'ಹಸಿಮೆಣಸಿನಕಾಯಿ', 'green chili': 'ಹಸಿಮೆಣಸಿನಕಾಯಿ', beans: 'ಬೀನ್ಸ್',
  'bottle gourd': 'ಸೊರೆಕಾಯಿ', lauki: 'ಸೊರೆಕಾಯಿ', 'bitter gourd': 'ಹಾಗಲಕಾಯಿ', cauliflower: 'ಹೂಕೋಸು',
  cabbage: 'ಎಲೆಕೋಸು', carrot: 'ಕ್ಯಾರೆಟ್', beetroot: 'ಬೀಟ್ರೂಟ್', capsicum: 'ದೊಣ್ಣೆ ಮೆಣಸಿನಕಾಯಿ',
  drumstick: 'ನುಗ್ಗೆಕಾಯಿ', radish: 'ಮೂಲಂಗಿ', raddish: 'ಮೂಲಂಗಿ', cucumber: 'ಸೌತೆಕಾಯಿ', kheera: 'ಸೌತೆಕಾಯಿ',
};

export function localizedProduceName(name: string, translations: Partial<Record<LanguageCode, string>> | undefined, language: LanguageCode) {
  const supplied = translations?.[language]?.trim();
  if (supplied) return supplied;
  if (language === 'kn') return KANNADA_NAMES[name.normalize('NFKC').toLocaleLowerCase('en-IN').replace(/[()]/g, '').trim()] ?? translations?.en?.trim() ?? name;
  // Tulu display uses only explicitly stored/reviewed translations; English is the safe fallback.
  return translations?.en?.trim() ?? name;
}
