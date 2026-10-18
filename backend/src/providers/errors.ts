export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: 'ocr' | 'otp') { super(`${provider}_provider_not_configured`); }
}
