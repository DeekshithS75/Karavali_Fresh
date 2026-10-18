import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LanguageSelector } from '@/components/language-selector';
import { MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import type { LanguageCode, TranslationKey } from '@/localization/types';
import {
  FarmerAuthError,
  getFarmerCapabilities,
  getVerificationStatus,
  hasValidFarmerSession,
  lookupFarmerAccount,
  logoutFarmer,
  requestFarmerOtp,
  requestFarmerRegistrationOtp,
  submitFarmerRegistration,
  verifyFarmerOtp,
  type FarmerCapabilities,
  type FarmerRegistration,
} from '@/features/farmer-auth/client';
import { farmerAuthRuntime } from '@/features/farmer-auth/runtime';

type Page = 'entry' | 'register' | 'login' | 'otp' | 'verification';
type FormErrors = Partial<Record<keyof FarmerRegistration | 'otp' | 'consent' | 'smsConsent' | 'document', TranslationKey>>;
type Props = { page: Page };

export function FarmerAuthFlow({ page }: Props) {
  const { language, t } = useLanguage();
  const [busy, setBusy] = useState(page === 'entry');
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [capabilities, setCapabilities] = useState<FarmerCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [values, setValues] = useState<FarmerRegistration>({ fullName: '', age: '', gender: '', phone: '', aadhaar: '', address: '' });
  const [otp, setOtp] = useState('');
  const [consented, setConsented] = useState(false);
  const [smsConsented, setSmsConsented] = useState(false);
  const [documentUri, setDocumentUri] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState('image/jpeg');
  const documentUriRef = useRef<string | null>(null);

  useEffect(() => { documentUriRef.current = documentUri; }, [documentUri]);
  useEffect(() => () => {
    const uri = documentUriRef.current;
    if (uri?.startsWith('file://')) {
      try { new File(uri).delete(); } catch { /* Best-effort cleanup of temporary picker output. */ }
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (page === 'entry') {
      hasValidFarmerSession().then(async (valid) => {
        if (active && valid) router.replace('/farmer');
        else if (active) setBusy(false);
      }).catch(() => { if (active) setBusy(false); });
    }
    getFarmerCapabilities().then((value) => { if (active) setCapabilities(value); })
      .catch(() => { if (active) setCapabilities(null); })
      .finally(() => { if (active) setLoadingCapabilities(false); });
    return () => { active = false; };
  }, [page]);

  useEffect(() => {
    if (page !== 'register' && page !== 'login') return;
    const phone = farmerAuthRuntime.takePhone();
    if (phone) setValues((current) => ({ ...current, phone }));
  }, [page]);

  const update = (field: keyof FarmerRegistration, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };
  const errorText = (error: unknown): TranslationKey => error instanceof FarmerAuthError && error.code === 'network'
    ? 'farmerAuth.networkError'
    : error instanceof FarmerAuthError && error.code === 'documentMismatch'
      ? 'farmerAuth.documentMismatch'
      : error instanceof FarmerAuthError && error.code === 'documentUnreadable'
        ? 'farmerAuth.documentUnreadable'
      : error instanceof FarmerAuthError && error.code === 'otpNotConfigured'
        ? 'farmerAuth.otpProviderMissing'
        : error instanceof FarmerAuthError && error.code === 'otpProviderFailure'
          ? 'farmerAuth.otpProviderFailure'
          : error instanceof FarmerAuthError && error.code === 'rateLimited'
            ? 'farmerAuth.rateLimited'
        : error instanceof FarmerAuthError && error.code === 'ocrUnavailable'
          ? 'farmerAuth.providerMissing'
          : error instanceof FarmerAuthError && error.code === 'farmerNotFound'
            ? 'farmerAuth.accountNotFound'
    : error instanceof FarmerAuthError && error.code === 'rejected'
      ? page === 'otp' ? 'farmerAuth.otpRejected' : 'farmerAuth.requestRejected'
      : 'farmerAuth.backendUnavailable';
  const privacyNotice = capabilities?.privacyNotice[language as LanguageCode] ?? capabilities?.privacyNotice.en;
  const canCollectIdentity = Boolean(
    capabilities?.registrationEnabled && capabilities.documentComparisonEnabled &&
    capabilities.ocrEngineConfigured &&
    capabilities.privacyNoticeVersion && capabilities.ocrEngineName && privacyNotice
  );

  const discardDocument = () => {
    if (documentUri?.startsWith('file://')) {
      try { new File(documentUri).delete(); } catch { /* Best-effort cleanup of temporary picker output. */ }
    }
    setDocumentUri(null);
  };

  const chooseDocument = async (source: 'camera' | 'library') => {
    if (!consented || !canCollectIdentity || busy) return;
    try {
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false });
      if (!result.canceled && result.assets[0]) {
        discardDocument();
        setDocumentUri(result.assets[0].uri);
        setDocumentType(result.assets[0].mimeType ?? 'image/jpeg');
        setErrors((current) => ({ ...current, document: undefined }));
      }
    } catch {
      setNotice('farmerAuth.documentError');
    }
  };

  const validateRegistration = () => {
    const next: FormErrors = {};
    if (!values.fullName.trim()) next.fullName = 'farmerAuth.error.name';
    const age = Number(values.age);
    if (!values.age || !Number.isInteger(age) || age < 18 || age > 100) next.age = 'farmerAuth.error.age';
    if (!values.gender) next.gender = 'farmerAuth.error.gender';
    if (!/^\d{10}$/.test(values.phone.replace(/\D/g, ''))) next.phone = 'farmerAuth.error.phone';
    if (!/^\d{12}$/.test(values.aadhaar.replace(/\D/g, ''))) next.aadhaar = 'farmerAuth.error.aadhaar';
    if (!values.address.trim()) next.address = 'farmerAuth.error.address';
    if (!consented) next.consent = 'farmerAuth.error.consent';
    if (!smsConsented) next.smsConsent = 'farmerAuth.error.smsConsent';
    if (!documentUri) next.document = 'farmerAuth.error.document';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submitRegistration = async () => {
    if (!validateRegistration()) return;
    if (!canCollectIdentity || !documentUri) {
      setNotice('farmerAuth.backendUnavailable');
      return;
    }
    setBusy(true);
    try {
      const result = await submitFarmerRegistration(values, documentUri, documentType, capabilities!.privacyNoticeVersion!);
      const failed = result.status === 'failed' || result.documentComparison === 'failed';
      farmerAuthRuntime.setVerification(result.verificationId, failed ? 'failed' : 'pending');
      setValues({ fullName: '', age: '', gender: '', phone: '', aadhaar: '', address: '' });
      setDocumentUri(null);
      router.replace('/auth/farmer/verification' as never);
      setNotice(failed ? 'farmerAuth.verificationFailed' : 'farmerAuth.verificationPending');
    } catch (error) {
      if (error instanceof FarmerAuthError && error.code === 'exists') router.replace('/auth/farmer/login' as never);
      else setNotice(errorText(error));
    } finally {
      if (documentUri?.startsWith('file://')) {
        try { new File(documentUri).delete(); } catch { /* Best-effort deletion of temporary picker output. */ }
      }
      setDocumentUri(null);
      setValues((current) => ({ ...current, aadhaar: '' }));
      setBusy(false);
    }
  };

  const sendOtp = async () => {
    const phone = values.phone.replace(/\D/g, '');
    if (!/^\d{10}$/.test(phone)) {
      setErrors({ phone: 'farmerAuth.error.phone' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await requestFarmerOtp(phone);
      farmerAuthRuntime.setRegistrationOtp(false);
      farmerAuthRuntime.setOtpChallenge(result.challengeId);
      router.push('/auth/farmer/otp' as never);
    } catch (error) {
      setNotice(errorText(error));
    } finally { setBusy(false); }
  };

  const continueFromEntry = async () => {
    const phone = values.phone.replace(/\D/g, '');
    if (!/^\d{10}$/.test(phone)) {
      setErrors({ phone: 'farmerAuth.error.phone' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const account = await lookupFarmerAccount(phone);
      farmerAuthRuntime.setPhone(phone);
      if (account.accountStatus === 'registered') router.push('/auth/farmer/login' as never);
      else if (account.accountStatus === 'pending' && account.verificationId) {
        farmerAuthRuntime.setVerification(account.verificationId, 'pending');
        router.push('/auth/farmer/verification' as never);
      } else if (account.accountStatus === 'new') router.push('/auth/farmer/register' as never);
      else setNotice('farmerAuth.requestRejected');
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  };

  const verifyOtp = async () => {
    const challengeId = farmerAuthRuntime.getOtpChallenge();
    if (!/^\d{6}$/.test(otp)) { setErrors({ otp: 'farmerAuth.error.otp' }); return; }
    if (!challengeId) { setNotice('farmerAuth.backendUnavailable'); return; }
    setBusy(true);
    setNotice(null);
    try {
      await verifyFarmerOtp(challengeId, otp);
      if (await hasValidFarmerSession()) {
        farmerAuthRuntime.clearRegistrationOtp();
        farmerAuthRuntime.takeOtpChallenge();
        router.replace('/farmer');
      } else {
        setNotice('farmerAuth.sessionInvalid');
      }
    } catch (error) { setNotice(errorText(error)); }
    finally { setOtp(''); setBusy(false); }
  };

  const checkVerification = async () => {
    const id = farmerAuthRuntime.getVerification();
    if (!id) { setNotice('farmerAuth.backendUnavailable'); return; }
    setBusy(true);
    setNotice(null);
    try {
      const status = await getVerificationStatus(id);
      if (status.documentComparison === 'failed' || status.status === 'failed') {
        farmerAuthRuntime.setVerification(id, 'failed');
        setNotice('farmerAuth.verificationFailed');
      } else if (status.documentComparison === 'passed' && status.status === 'pending') {
        const challenge = await requestFarmerRegistrationOtp(id);
        farmerAuthRuntime.setRegistrationOtp(true);
        farmerAuthRuntime.setOtpChallenge(challenge.challengeId);
        farmerAuthRuntime.clearVerification();
        router.replace('/auth/farmer/otp' as never);
      } else if (status.documentComparison === 'pending' || status.status === 'pending') {
        farmerAuthRuntime.setVerification(id, 'pending');
        setNotice('farmerAuth.verificationPending');
      } else setNotice('farmerAuth.verificationFailed');
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  };

  const field = (name: keyof FarmerRegistration, labelKey: TranslationKey, placeholderKey: TranslationKey, options: { keyboard?: 'default' | 'number-pad'; secure?: boolean; maxLength?: number } = {}) => (
    <View style={styles.field} key={name}>
      <Text style={styles.label}>{t(labelKey)}</Text>
      <View style={name === 'phone' ? styles.phoneInputRow : undefined}>
      {name === 'phone' ? <View style={styles.countryPrefix}><Text style={styles.countryPrefixText}>+91</Text></View> : null}
      <TextInput
        accessibilityLabel={t(labelKey)}
        value={values[name]}
        onChangeText={(value) => update(name, value)}
        placeholder={t(placeholderKey)}
        placeholderTextColor={MarketColors.muted}
        keyboardType={options.keyboard ?? 'default'}
        secureTextEntry={options.secure}
        maxLength={options.maxLength}
        autoCapitalize={name === 'phone' || name === 'aadhaar' ? 'none' : 'words'}
        style={[styles.input, name === 'phone' && styles.phoneInput]}
      />
      </View>
      {errors[name] ? <Text accessibilityRole="alert" style={styles.error}>{t(errors[name]!)}</Text> : null}
    </View>
  );

  const header = <View style={styles.topBar}>
    <Pressable accessibilityRole="button" accessibilityLabel={t('navigation.back')} onPress={() => router.replace(page === 'entry' ? '/' : page === 'otp' ? farmerAuthRuntime.isRegistrationOtp() ? '/auth/farmer/verification' : '/auth/farmer/login' : '/auth/farmer')} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.back')}</Text></Pressable>
    <LanguageSelector />
  </View>;
  const brand = <View style={styles.brand}><View style={styles.brandMark}><Text style={styles.brandGlyph}>❧</Text></View><View><Text style={styles.brandName}>{t('brand.name')}</Text><Text style={styles.brandRegion}>{t('brand.region')}</Text></View></View>;
  const banner = <View style={styles.demoBanner}><Text style={styles.demoText}>{t(capabilities?.otpLoginEnabled ? 'farmerAuth.secureBanner' : 'farmerAuth.demoBanner')}</Text></View>;
  const visibleNotice = notice ?? (page === 'otp' && !farmerAuthRuntime.getOtpChallenge() ? 'farmerAuth.backendUnavailable' : null);
  const noticeView = visibleNotice ? <Text accessibilityRole="alert" style={styles.notice}>{t(visibleNotice)}</Text> : null;
  const button = (labelKey: TranslationKey, action: () => void, disabled = false) => <Pressable accessibilityRole="button" disabled={busy || disabled} onPress={action} style={({ pressed }) => [styles.primaryButton, (busy || disabled) && styles.disabled, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>{t(busy ? 'farmerAuth.loading' : labelKey)}</Text></Pressable>;

  return <ScreenFrame>
    {header}{brand}
    {page === 'entry' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text>
      <Text style={styles.title}>{t('farmerAuth.entryTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.entryIntro')}</Text>
      {banner}
      {loadingCapabilities || busy ? <Text style={styles.notice}>{t('farmerAuth.checkingSession')}</Text> : null}
      {!loadingCapabilities && !capabilities?.registrationEnabled ? <Text style={styles.warning}>{t('farmerAuth.backendUnavailable')}</Text> : null}
      {field('phone', 'farmerAuth.phone', 'farmerAuth.phonePlaceholder', { keyboard: 'number-pad', maxLength: 10 })}
      {noticeView}{button('farmerAuth.continue', continueFromEntry, loadingCapabilities)}
    </View> : null}

    {page === 'register' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.registerTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.registerIntro')}</Text>{banner}
      {__DEV__ ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => router.push('/auth/farmer/ocr-test' as never)} style={[styles.secondaryButton, busy && styles.disabled]}><Text style={styles.linkText}>{t('ocrTest.open')}</Text></Pressable> : null}
      {field('fullName', 'farmerAuth.fullName', 'farmerAuth.fullNamePlaceholder')}
      {field('age', 'farmerAuth.age', 'farmerAuth.agePlaceholder', { keyboard: 'number-pad', maxLength: 3 })}
      <Text style={styles.label}>{t('farmerAuth.gender')}</Text>
      <View style={styles.genderRow}>{(['male', 'female', 'other'] as const).map((g) => <Pressable key={g} accessibilityRole="radio" accessibilityState={{ selected: values.gender === g }} onPress={() => update('gender', g)} style={[styles.genderOption, values.gender === g && styles.genderSelected]}><Text style={styles.genderText}>{t(`farmerAuth.gender.${g}` as TranslationKey)}</Text></Pressable>)}</View>
      {errors.gender ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.gender)}</Text> : null}
      {field('phone', 'farmerAuth.phone', 'farmerAuth.phonePlaceholder', { keyboard: 'number-pad', maxLength: 10 })}
      {field('aadhaar', 'farmerAuth.aadhaar', 'farmerAuth.aadhaarPlaceholder', { keyboard: 'number-pad', secure: true, maxLength: 12 })}
      <Text style={styles.help}>{t('farmerAuth.aadhaarPrivacy')}</Text>
      {field('address', 'farmerAuth.address', 'farmerAuth.addressPlaceholder')}
      <Text style={styles.help}>{t('farmerAuth.linkedPhoneNotice')}</Text>
      <Text style={styles.help}>{t('farmerAuth.ocrNotice')}</Text>
      {privacyNotice && capabilities?.ocrEngineConfigured ? <View style={styles.providerDisclosure}><Text style={styles.label}>{capabilities.ocrEngineName}</Text><Text style={styles.help}>{privacyNotice}</Text></View> : null}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: consented }} onPress={() => { if (consented) { update('aadhaar', ''); discardDocument(); } setConsented((value) => !value); setErrors((current) => ({ ...current, consent: undefined })); }} style={styles.consentRow}><View style={[styles.checkbox, consented && styles.checkboxChecked]}>{consented ? <Text style={styles.checkmark}>✓</Text> : null}</View><Text style={styles.consentText}>{t('farmerAuth.consent')}</Text></Pressable>
      {errors.consent ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.consent)}</Text> : null}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: smsConsented }} onPress={() => { setSmsConsented((value) => !value); setErrors((current) => ({ ...current, smsConsent: undefined })); }} style={styles.consentRow}><View style={[styles.checkbox, smsConsented && styles.checkboxChecked]}>{smsConsented ? <Text style={styles.checkmark}>✓</Text> : null}</View><Text style={styles.consentText}>{t('farmerAuth.smsConsent')}</Text></Pressable>
      {errors.smsConsent ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.smsConsent)}</Text> : null}
      <Text style={styles.label}>{t('farmerAuth.document')}</Text>
      <View style={styles.documentActions}>
        <Pressable accessibilityRole="button" disabled={!consented || !canCollectIdentity || busy} onPress={() => chooseDocument('camera')} style={[styles.secondaryButton, (!consented || !canCollectIdentity) && styles.disabled]}><Text style={styles.linkText}>{t('farmerAuth.captureDocument')}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={!consented || !canCollectIdentity || busy} onPress={() => chooseDocument('library')} style={[styles.secondaryButton, (!consented || !canCollectIdentity) && styles.disabled]}><Text style={styles.linkText}>{t('farmerAuth.uploadDocument')}</Text></Pressable>
      </View>
      <Text style={styles.help}>{documentUri ? t('farmerAuth.documentSelected') : t('farmerAuth.documentUnavailable')}</Text>
      {errors.document ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.document)}</Text> : null}
      {!loadingCapabilities && !canCollectIdentity ? <Text style={styles.warning}>{t('farmerAuth.providerMissing')}</Text> : null}
      {noticeView}
      {button('farmerAuth.submitRegistration', submitRegistration, !canCollectIdentity)}
      {__DEV__ ? <Text style={styles.devNote}>{t('farmerAuth.devMockNote')}</Text> : null}
    </View> : null}

    {page === 'login' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.loginTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.loginIntro')}</Text>{banner}
      {field('phone', 'farmerAuth.phone', 'farmerAuth.phonePlaceholder', { keyboard: 'number-pad', maxLength: 10 })}
      {noticeView}{button('farmerAuth.sendOtp', sendOtp)}
    </View> : null}

    {page === 'otp' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.otpTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.otpIntro')}</Text>{banner}
      <Text style={styles.label}>{t('farmerAuth.otp')}</Text>
      <TextInput accessibilityLabel={t('farmerAuth.otp')} value={otp} onChangeText={(value) => { setOtp(value.replace(/\D/g, '').slice(0, 6)); setErrors({}); }} keyboardType="number-pad" maxLength={6} style={styles.input} placeholder={t('farmerAuth.otpPlaceholder')} placeholderTextColor={MarketColors.muted} />
      {errors.otp ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.otp)}</Text> : null}
      {noticeView}{button('farmerAuth.verifyOtp', verifyOtp)}
    </View> : null}

    {page === 'verification' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.verificationTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.verificationIntro')}</Text>{banner}
      {noticeView ?? <Text style={styles.notice}>{t(farmerAuthRuntime.getVerificationState() === 'failed' ? 'farmerAuth.verificationFailed' : 'farmerAuth.verificationPending')}</Text>}
      {button('farmerAuth.checkStatus', checkVerification)}
    </View> : null}

    <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.returnLink}><Text style={styles.linkText}>{t('navigation.returnToWelcome')}</Text></Pressable>
  </ScreenFrame>;
}

export function FarmerDashboardGuard({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [valid, setValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { hasValidFarmerSession().then(setValid).catch(() => setValid(false)); }, []);
  useEffect(() => { if (valid === false) router.replace('/auth/farmer'); }, [valid]);
  if (valid !== true) return <ScreenFrame><Text style={styles.notice}>{t('farmerAuth.checkingSession')}</Text></ScreenFrame>;
  return <View style={styles.gate}><View style={styles.logoutBar}><Pressable accessibilityRole="button" disabled={busy} onPress={async () => { setBusy(true); try { await logoutFarmer(); } catch { /* Local credentials are cleared even when service logout is unavailable. */ } finally { router.dismissAll(); router.replace('/auth/farmer'); } }} style={styles.logoutButton}><Text style={styles.linkText}>{t(busy ? 'farmerAuth.loading' : 'farmerAuth.logout')}</Text></Pressable></View>{children}</View>;
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  back: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 }, backText: { color: MarketColors.green, fontSize: 14, fontWeight: '700' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 }, brandMark: { width: 43, height: 43, borderRadius: 15, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' }, brandGlyph: { color: '#fff', fontSize: 26, lineHeight: 30 }, brandName: { color: MarketColors.text, fontSize: 17, fontWeight: '800' }, brandRegion: { color: MarketColors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.1, marginTop: 2 },
  card: { backgroundColor: MarketColors.card, borderRadius: 22, borderWidth: 1, borderColor: MarketColors.border, padding: 20, gap: 12 }, eyebrow: { color: MarketColors.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 }, title: { color: MarketColors.text, fontSize: 25, fontWeight: '800' }, intro: { color: MarketColors.muted, fontSize: 14, lineHeight: 20 }, demoBanner: { borderRadius: 13, backgroundColor: MarketColors.blueSoft, padding: 12 }, demoText: { color: MarketColors.blue, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  field: { gap: 6 }, label: { color: MarketColors.text, fontSize: 13, fontWeight: '700' }, input: { minHeight: 48, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background, paddingHorizontal: 12, color: MarketColors.text, fontSize: 14 }, help: { color: MarketColors.muted, fontSize: 11, lineHeight: 16 }, error: { color: '#B42318', fontSize: 12 }, notice: { color: MarketColors.blue, fontSize: 13, lineHeight: 19 }, warning: { color: '#8A5A00', backgroundColor: '#FFF4D6', borderRadius: 12, padding: 11, fontSize: 12, lineHeight: 18 }, devNote: { color: MarketColors.muted, fontSize: 11, lineHeight: 16 },
  phoneInputRow: { flexDirection: 'row', gap: 8 }, countryPrefix: { minHeight: 48, minWidth: 60, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background }, countryPrefixText: { color: MarketColors.text, fontSize: 14, fontWeight: '700' }, phoneInput: { flex: 1 },
  genderRow: { flexDirection: 'row', gap: 7 }, genderOption: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, paddingHorizontal: 5 }, genderSelected: { backgroundColor: MarketColors.greenSoft, borderColor: MarketColors.green }, genderText: { color: MarketColors.text, fontSize: 12, fontWeight: '600' },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 }, checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' }, checkboxChecked: { backgroundColor: MarketColors.green }, checkmark: { color: '#fff', fontSize: 15, fontWeight: '800' }, consentText: { flex: 1, color: MarketColors.text, fontSize: 12, lineHeight: 18 },
  documentActions: { flexDirection: 'row', gap: 9 }, secondaryButton: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: MarketColors.green, borderRadius: 12, paddingHorizontal: 6 }, providerDisclosure: { borderRadius: 12, backgroundColor: MarketColors.background, padding: 10, gap: 4 },
  primaryButton: { minHeight: 49, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: MarketColors.green, paddingHorizontal: 12 }, primaryButtonText: { color: '#fff', textAlign: 'center', fontSize: 14, fontWeight: '800' }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.72 }, linkText: { color: MarketColors.green, fontSize: 13, fontWeight: '700', textAlign: 'center' }, returnLink: { alignSelf: 'center', padding: 13 }, gate: { flex: 1 }, logoutBar: { alignItems: 'flex-end', marginBottom: 8 }, logoutButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: MarketColors.greenSoft },
});
