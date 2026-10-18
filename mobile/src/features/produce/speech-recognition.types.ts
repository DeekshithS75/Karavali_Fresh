import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionOptions,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';

export type SpeechEventHandlers = {
  start?: () => void;
  end?: () => void;
  result?: (event: ExpoSpeechRecognitionResultEvent) => void;
  error?: (event: ExpoSpeechRecognitionErrorEvent) => void;
  nomatch?: () => void;
};

export type SpeechRecognitionAdapter = {
  isRecognitionAvailable: () => boolean;
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: ExpoSpeechRecognitionOptions) => void;
  stop: () => void;
  subscribe: (handlers: SpeechEventHandlers) => () => void;
};
