import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import type { SpeechEventHandlers, SpeechRecognitionAdapter } from './speech-recognition.types';

export const speechRecognition: SpeechRecognitionAdapter = {
  isRecognitionAvailable: () => ExpoSpeechRecognitionModule.isRecognitionAvailable(),
  requestPermissionsAsync: async () => ExpoSpeechRecognitionModule.requestPermissionsAsync(),
  start: (options) => ExpoSpeechRecognitionModule.start(options),
  stop: () => ExpoSpeechRecognitionModule.stop(),
  subscribe: (handlers: SpeechEventHandlers) => {
    const subscriptions = [
      handlers.start && ExpoSpeechRecognitionModule.addListener('start', handlers.start),
      handlers.end && ExpoSpeechRecognitionModule.addListener('end', handlers.end),
      handlers.result && ExpoSpeechRecognitionModule.addListener('result', handlers.result),
      handlers.error && ExpoSpeechRecognitionModule.addListener('error', handlers.error),
      handlers.nomatch && ExpoSpeechRecognitionModule.addListener('nomatch', handlers.nomatch),
    ].filter((subscription): subscription is { remove: () => void } => Boolean(subscription));
    return () => subscriptions.forEach((subscription) => subscription.remove());
  },
};
