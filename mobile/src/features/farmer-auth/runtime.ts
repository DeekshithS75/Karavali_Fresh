// Transient navigation data only. Never persisted or logged.
let otpChallengeId: string | null = null;
let verificationId: string | null = null;
let verificationState: 'pending' | 'failed' | null = null;
let registrationOtp = false;
let farmerPhone = '';

export const farmerAuthRuntime = {
  setOtpChallenge(id: string) { otpChallengeId = id; },
  getOtpChallenge() { return otpChallengeId; },
  setRegistrationOtp(value: boolean) { registrationOtp = value; },
  isRegistrationOtp() { return registrationOtp; },
  clearRegistrationOtp() { registrationOtp = false; },
  setPhone(value: string) { farmerPhone = value; },
  takePhone() { const value = farmerPhone; farmerPhone = ''; return value; },
  takeOtpChallenge() { const value = otpChallengeId; otpChallengeId = null; return value; },
  setVerification(id: string, state: 'pending' | 'failed' = 'pending') { verificationId = id; verificationState = state; },
  getVerification() { return verificationId; },
  getVerificationState() { return verificationState; },
  clearVerification() { verificationId = null; verificationState = null; },
};
