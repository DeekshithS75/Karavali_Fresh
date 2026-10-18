import type { ExpoSpeechRecognitionOptions } from 'expo-speech-recognition';

import type { SpeechEventHandlers, SpeechRecognitionAdapter } from './speech-recognition.types';

type NativeSpeechModule = {
  isRecognitionAvailable: () => boolean;
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: ExpoSpeechRecognitionOptions) => void;
  stop: () => void;
  addListener: (event: string, listener: (payload: never) => void) => { remove: () => void };
};

let nativeSpeechModule: NativeSpeechModule | null = null;
try {
  // Expo Go does not contain this native module. Catch its missing-module error
  // so route evaluation still succeeds and manual entry remains available.
  nativeSpeechModule = (require('expo-speech-recognition') as { ExpoSpeechRecognitionModule: NativeSpeechModule }).ExpoSpeechRecognitionModule;
} catch {
  nativeSpeechModule = null;
}

export const speechRecognition: SpeechRecognitionAdapter = {
  isRecognitionAvailable: () => nativeSpeechModule?.isRecognitionAvailable() ?? false,
  requestPermissionsAsync: async () => nativeSpeechModule ? nativeSpeechModule.requestPermissionsAsync() : { granted: false },
  start: (options) => nativeSpeechModule?.start(options),
  stop: () => nativeSpeechModule?.stop(),
  subscribe: (handlers: SpeechEventHandlers) => {
    if (!nativeSpeechModule) return () => undefined;
    const subscriptions = [
      handlers.start && nativeSpeechModule.addListener('start', handlers.start as (payload: never) => void),
      handlers.end && nativeSpeechModule.addListener('end', handlers.end as (payload: never) => void),
      handlers.result && nativeSpeechModule.addListener('result', handlers.result as (payload: never) => void),
      handlers.error && nativeSpeechModule.addListener('error', handlers.error as (payload: never) => void),
      handlers.nomatch && nativeSpeechModule.addListener('nomatch', handlers.nomatch as (payload: never) => void),
    ].filter((subscription): subscription is { remove: () => void } => Boolean(subscription));
    return () => subscriptions.forEach((subscription) => subscription.remove());
  },
};
