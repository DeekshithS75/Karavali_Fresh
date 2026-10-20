import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LanguageSelector } from '@/components/language-selector';
import { MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { ConsumerAuthError, completeConsumerPhoneVerification, getConsumerPhoneVerificationStatus, getConsumerSessionState, startConsumerPhoneVerification, type ConsumerChallenge } from '@/features/consumer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';

type Page = 'login' | 'register' | 'forgot-password' | 'otp';

export function ConsumerAuthScreen({ page }: { page: Page }) {
  const { t, language } = useLanguage();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<ConsumerChallenge | null>(null);
  const [verified, setVerified] = useState(false);
  const [phoneConsent, setPhoneConsent] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = page === 'register';
  const unsupportedPage = page === 'forgot-password' || page === 'otp';

  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => void getConsumerPhoneVerificationStatus(challenge.challengeId).then((result) => {
      if (result.status === 'verified') setVerified(true);
      if (result.status === 'expired' || result.status === 'cancelled') { setChallenge(null); setErrorKey('consumer.auth.verificationExpired'); }
    }).catch(() => undefined), 2500);
    return () => clearInterval(timer);
  }, [challenge]);

  useEffect(() => {
    if (page !== 'login') return;
    let active = true;
    void getConsumerSessionState().then((state) => { if (active && state === 'valid') router.replace('/consumer'); });
    return () => { active = false; };
  }, [page]);

  const submit = async () => {
    setErrorKey(null);
    if (challenge && verified) {
      setBusy(true);
      try { await completeConsumerPhoneVerification(challenge.challengeId, isRegister ? fullName.trim() : undefined, language); router.replace('/consumer'); }
      catch { setErrorKey('consumer.auth.networkError'); }
      finally { setBusy(false); }
      return;
    }
    if (isRegister && !fullName.trim()) { setErrorKey('consumer.auth.nameRequired'); return; }
    const digits = phone.replace(/\D/g, '');
    const normalizedPhone = digits.length === 10 ? '+91' + digits : digits.length === 12 && digits.startsWith('91') ? '+' + digits : phone.trim();
    if (!/^\+91[6-9]\d{9}$/.test(normalizedPhone)) { setErrorKey('consumer.auth.phoneInvalid'); return; }
    if (!phoneConsent) { setErrorKey('consumer.auth.consentRequired'); return; }
    setBusy(true);
    try {
      setChallenge(await startConsumerPhoneVerification(normalizedPhone, isRegister ? 'registration' : 'login', fullName.trim()));
    } catch (error) {
      const key = error instanceof ConsumerAuthError && error.code === 'rateLimited' ? 'consumer.auth.rateLimited'
        : error instanceof ConsumerAuthError && error.code === 'configurationIncomplete' ? 'consumer.auth.notConfigured'
          : error instanceof ConsumerAuthError && error.serverError === 'verification_credits_exhausted' ? 'consumer.auth.creditsExhausted'
            : error instanceof ConsumerAuthError && error.serverError === 'verification_expired' ? 'consumer.auth.verificationExpired'
              : error instanceof ConsumerAuthError && error.serverError === 'consumer_account_not_found' ? 'consumer.auth.accountMissing'
                : error instanceof ConsumerAuthError && error.serverError === 'consumer_phone_registered' ? 'consumer.auth.phoneRegistered'
                  : error instanceof ConsumerAuthError && ['phone_verification_provider_not_configured', 'verification_provider_unavailable', 'verification_line_not_configured', 'verification_request_unavailable'].includes(error.serverError ?? '') ? 'consumer.auth.providerFailed'
                    : error instanceof ConsumerAuthError && error.serverError === 'invalid_phone' ? 'consumer.auth.phoneInvalid'
          : error instanceof ConsumerAuthError && error.code === 'rejected' ? 'consumer.auth.invalidInput' : 'consumer.auth.networkError';
      setErrorKey(key);
    } finally { setBusy(false); }
  };

  return <ScreenFrame>
    <View style={styles.topBar}>
      <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.welcome')}</Text></Pressable>
      <LanguageSelector />
    </View>
    <View style={styles.brand}><View style={styles.mark}><Text style={styles.glyph}>❧</Text></View><View><Text style={styles.brandName}>{t('brand.name')}</Text><Text style={styles.brandRegion}>{t('consumer.role')}</Text></View></View>
    <View style={styles.card}>
      <Text style={styles.title}>{t(isRegister ? 'consumer.auth.registerTitle' : unsupportedPage ? 'consumer.auth.recoveryTitle' : 'consumer.auth.loginTitle')}</Text>
      <Text style={styles.intro}>{t(isRegister ? 'consumer.auth.registerIntro' : unsupportedPage ? 'consumer.auth.recoveryUnavailable' : 'consumer.auth.loginIntro')}</Text>
      {!unsupportedPage ? <Text style={styles.note}>{t('consumer.auth.providerNote')}</Text> : null}
      {!unsupportedPage ? <>
        {isRegister ? <View style={styles.field}><Text style={styles.label}>{t('consumer.auth.fullName')}</Text><TextInput accessibilityLabel={t('consumer.auth.fullName')} value={fullName} onChangeText={setFullName} autoCapitalize="words" style={styles.input} /></View> : null}
        {!challenge ? <><View style={styles.field}><Text style={styles.label}>{t('consumer.auth.phone')}</Text><TextInput accessibilityLabel={t('consumer.auth.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" style={styles.input} /></View><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: phoneConsent }} onPress={() => setPhoneConsent((value) => !value)} style={styles.note}><Text>{phoneConsent ? '☑' : '□'} {t('consumer.auth.providerNote')}</Text></Pressable></> : <View style={styles.note}><Text style={styles.intro}>{challenge.instruction}</Text><Text style={styles.title}>{challenge.callNumber}</Text><Pressable accessibilityRole="button" onPress={() => void Linking.openURL(`tel:${challenge.callNumber}`)} style={styles.link}><Text style={styles.linkText}>{t('consumer.auth.callToVerify')}</Text></Pressable><Text style={styles.note}>{t(verified ? 'consumer.auth.verified' : 'consumer.auth.waiting')}</Text></View>}
        {errorKey ? <Text accessibilityRole="alert" style={styles.error}>{t(errorKey as never)}</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy || Boolean(challenge && !verified)} onPress={() => void submit()} style={[styles.primary, busy && styles.disabled]}><Text style={styles.primaryText}>{t(busy ? 'consumer.auth.working' : challenge ? 'consumer.auth.completeVerification' : isRegister ? 'consumer.auth.createAccount' : 'consumer.auth.signIn')}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => router.replace(isRegister ? '/auth/consumer/login' : '/auth/consumer/register')} style={styles.link}><Text style={styles.linkText}>{t(isRegister ? 'consumer.auth.haveAccount' : 'consumer.auth.needAccount')}</Text></Pressable>
      </> : <Pressable accessibilityRole="button" onPress={() => router.replace('/auth/consumer/login')} style={styles.primary}><Text style={styles.primaryText}>{t('consumer.auth.backToLogin')}</Text></Pressable>}
    </View>
  </ScreenFrame>;
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  back: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 }, backText: { color: MarketColors.green, fontWeight: '700' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 }, mark: { width: 43, height: 43, borderRadius: 15, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' }, glyph: { color: '#fff', fontSize: 25 }, brandName: { color: MarketColors.text, fontSize: 17, fontWeight: '800' }, brandRegion: { color: MarketColors.muted, fontSize: 9, fontWeight: '700', marginTop: 3 },
  card: { backgroundColor: MarketColors.card, borderRadius: 22, borderWidth: 1, borderColor: MarketColors.border, padding: 20, gap: 13 }, title: { color: MarketColors.text, fontSize: 25, fontWeight: '800' }, intro: { color: MarketColors.muted, fontSize: 14, lineHeight: 20 },
  field: { gap: 6 }, label: { color: MarketColors.text, fontSize: 13, fontWeight: '700' }, input: { minHeight: 49, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, paddingHorizontal: 12, color: MarketColors.text, backgroundColor: MarketColors.background }, passwordRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, paddingHorizontal: 12, backgroundColor: MarketColors.background }, password: { flex: 1, minHeight: 46, color: MarketColors.text }, toggle: { minHeight: 42, justifyContent: 'center', paddingLeft: 8 }, toggleText: { color: MarketColors.green, fontSize: 12, fontWeight: '700' },
  note: { color: MarketColors.muted, fontSize: 12, lineHeight: 18, backgroundColor: MarketColors.blueSoft, borderRadius: 11, padding: 10 }, error: { color: '#B42318', fontSize: 13, lineHeight: 18 }, primary: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: MarketColors.green, paddingHorizontal: 14 }, primaryText: { color: '#fff', fontSize: 14, fontWeight: '800' }, link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' }, linkText: { color: MarketColors.greenDark, fontSize: 13, fontWeight: '700' }, disabled: { opacity: 0.55 },
});
