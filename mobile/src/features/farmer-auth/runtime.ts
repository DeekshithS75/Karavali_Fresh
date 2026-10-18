// Transient navigation data only. Never persisted or logged.
let phoneVerification: { challengeId: string; callNumber: string; instruction: string; expiresAt: string } | null = null;
let verificationId: string | null = null;
let verificationState: 'pending' | 'failed' | null = null;
let registrationOtp = false;
let farmerPhone = '';

export const farmerAuthRuntime = {
  setPhoneVerification(value: { challengeId: string; callNumber: string; instruction: string; expiresAt: string }) { phoneVerification = value; },
  getPhoneVerification() { return phoneVerification; },
  clearPhoneVerification() { phoneVerification = null; },
  setRegistrationOtp(value: boolean) { registrationOtp = value; },
  isRegistrationOtp() { return registrationOtp; },
  clearRegistrationOtp() { registrationOtp = false; },
  setPhone(value: string) { farmerPhone = value; },
  getPhone() { return farmerPhone; },
  takePhone() { const value = farmerPhone; farmerPhone = ''; return value; },
  setVerification(id: string, state: 'pending' | 'failed' = 'pending') { verificationId = id; verificationState = state; },
  getVerification() { return verificationId; },
  getVerificationState() { return verificationState; },
  clearVerification() { verificationId = null; verificationState = null; },
};
