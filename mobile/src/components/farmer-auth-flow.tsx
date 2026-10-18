import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LanguageSelector } from '@/components/language-selector';
import { MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import type { LanguageCode, TranslationKey } from '@/localization/types';
import {
  FarmerAuthError,
  cancelFarmerPhoneVerification,
  completeFarmerPhoneVerification,
  consentForRegistrationPhoneVerification,
  getFarmerCapabilities,
  getFarmerSessionState,
  getFarmerPhoneVerificationStatus,
  getVerificationStatus,
  lookupFarmerAccount,
  logoutFarmer,
  startFarmerPhoneVerification,
  startFarmerRegistrationPhoneVerification,
  submitFarmerRegistration,
  type FarmerCapabilities,
  type FarmerDocumentField,
  type FarmerRegistration,
} from '@/features/farmer-auth/client';
import { routeForFarmerAccount, routeForFarmerSession, type FarmerSessionState } from '@/features/farmer-auth/session-lifecycle';
import { farmerAuthRuntime } from '@/features/farmer-auth/runtime';

type Page = 'entry' | 'register' | 'login' | 'otp' | 'verification';
type FormErrors = Partial<Record<keyof FarmerRegistration | 'consent' | 'phoneVerificationConsent' | 'document', TranslationKey>>;
type Props = { page: Page };

const farmerFieldLabelKeys: Record<FarmerDocumentField, TranslationKey> = {
  name: 'farmerAuth.fullName',
  age: 'farmerAuth.age',
  gender: 'farmerAuth.gender',
  aadhaar: 'farmerAuth.aadhaar',
  address: 'farmerAuth.address',
  date_of_birth: 'farmerAuth.dateOfBirth',
};

function farmerAuthErrorText(error: unknown, page: Page): TranslationKey {
  if (!(error instanceof FarmerAuthError)) return 'farmerAuth.backendUnavailable';
  if (error.code === 'network') return 'farmerAuth.networkError';
  if (error.code === 'apiUrlMissing') return 'farmerAuth.apiConfigurationMissing';
  if (error.code === 'urlNotAllowed') return 'farmerAuth.apiUrlNotAllowed';
  if (error.code === 'configurationIncomplete') return 'farmerAuth.backendConfigurationIncomplete';
  if (error.code === 'documentRequired') return 'farmerAuth.error.document';
  if (error.code === 'invalidDocument') return 'farmerAuth.invalidDocument';
  if (error.code === 'privacyNoticeOutdated') return 'farmerAuth.privacyNoticeOutdated';
  if (error.code === 'validationFailed') return 'farmerAuth.registrationValidationFailed';
  if (error.code === 'documentMismatch') return 'farmerAuth.documentMismatch';
  if (error.code === 'documentFieldsMissing') return 'farmerAuth.documentFieldsMissing';
  if (error.code === 'documentUnreadable') return 'farmerAuth.documentUnreadable';
  if (error.code === 'verificationNotConfigured') return 'farmerAuth.phoneVerificationProviderMissing';
  if (error.code === 'verificationProviderFailure') return 'farmerAuth.phoneVerificationProviderFailure';
  if (error.code === 'rateLimited') return 'farmerAuth.rateLimited';
  if (error.code === 'verificationExpired') return 'farmerAuth.phoneVerificationExpired';
  if (error.code === 'ocrUnavailable') return 'farmerAuth.providerMissing';
  if (error.code === 'farmerNotFound') return 'farmerAuth.accountNotFound';
  if (error.code === 'rejected') return page === 'otp' ? 'farmerAuth.phoneVerificationRejected' : 'farmerAuth.requestRejected';
  return 'farmerAuth.backendUnavailable';
}

export function FarmerAuthFlow({ page }: Props) {
  const { language, t } = useLanguage();
  const [busy, setBusy] = useState(page === 'entry');
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [noticeFields, setNoticeFields] = useState<FarmerDocumentField[]>([]);
  const [suggestedFullName, setSuggestedFullName] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [capabilities, setCapabilities] = useState<FarmerCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [capabilityError, setCapabilityError] = useState<TranslationKey | null>(null);
  const [entrySessionState, setEntrySessionState] = useState<FarmerSessionState | 'checking'>('checking');
  const [values, setValues] = useState<FarmerRegistration>(() => ({ fullName: '', age: '', gender: '', phone: farmerAuthRuntime.takePhone(), aadhaar: '', address: '' }));
  const [consented, setConsented] = useState(false);
  const [phoneVerificationConsented, setPhoneVerificationConsented] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<'pending' | 'verified' | 'expired' | 'cancelled' | null>(null);
  const [phoneVerificationConsentRequired, setPhoneVerificationConsentRequired] = useState(false);
  const [documentUri, setDocumentUri] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState('image/jpeg');
  const documentUriRef = useRef<string | null>(null);
  const finishingVerificationRef = useRef(false);

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
      getFarmerSessionState().then((state) => {
        if (!active) return;
        setEntrySessionState(state);
        if (state === 'valid') router.replace('/farmer');
        else setBusy(false);
      });
    }
    getFarmerCapabilities().then((value) => { if (active) setCapabilities(value); })
      .catch((error) => { if (active) { setCapabilities(null); setCapabilityError(farmerAuthErrorText(error, page)); } })
      .finally(() => { if (active) setLoadingCapabilities(false); });
    return () => { active = false; };
  }, [page]);

  const update = (field: keyof FarmerRegistration, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
    setNoticeFields([]);
    setSuggestedFullName(null);
  };
  const retryFarmerEntry = async () => {
    setBusy(true);
    setCapabilityError(null);
    setLoadingCapabilities(true);
    try {
      const state = await getFarmerSessionState();
      setEntrySessionState(state);
      if (state === 'valid') { router.replace('/farmer'); return; }
      if (routeForFarmerSession(state) === 'retry') {
        setNotice(state === 'configuration-error' ? 'farmerAuth.apiConfigurationMissing' : 'farmerAuth.sessionUnavailable');
      }
      const value = await getFarmerCapabilities();
      setCapabilities(value);
      if (!value.sessionSigningConfigured) setNotice('farmerAuth.backendConfigurationIncomplete');
      else setNotice(null);
    } catch (error) {
      setCapabilities(null);
      setCapabilityError(farmerAuthErrorText(error, page));
    } finally {
      setLoadingCapabilities(false);
      setBusy(false);
    }
  };
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
        setNotice(null);
        setNoticeFields([]);
        setSuggestedFullName(null);
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
    const addressWords = new Set((values.address.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []));
    if (addressWords.size < 3) next.address = 'farmerAuth.error.address';
    if (!consented) next.consent = 'farmerAuth.error.consent';
    if (!phoneVerificationConsented) next.phoneVerificationConsent = 'farmerAuth.error.phoneVerificationConsent';
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
    setNotice(null);
    setNoticeFields([]);
    setSuggestedFullName(null);
    let submitted = false;
    try {
      const result = await submitFarmerRegistration(values, documentUri, documentType, capabilities!.privacyNoticeVersion!);
      submitted = true;
      const failed = result.status === 'failed' || result.documentComparison === 'failed';
      farmerAuthRuntime.setPhone(values.phone);
      farmerAuthRuntime.setVerification(result.verificationId, failed ? 'failed' : 'pending');
      setValues({ fullName: '', age: '', gender: '', phone: '', aadhaar: '', address: '' });
      setDocumentUri(null);
      router.replace('/auth/farmer/verification' as never);
      setNotice(failed ? 'farmerAuth.verificationFailed' : 'farmerAuth.verificationPending');
    } catch (error) {
      if (error instanceof FarmerAuthError && error.code === 'exists') router.replace('/auth/farmer/login' as never);
      else {
        setNotice(farmerAuthErrorText(error, page));
        setNoticeFields(error instanceof FarmerAuthError ? error.fields : []);
        setSuggestedFullName(error instanceof FarmerAuthError ? error.suggestedFullName : null);
      }
    } finally {
      if (submitted) {
        if (documentUri?.startsWith('file://')) {
          try { new File(documentUri).delete(); } catch { /* Best-effort cleanup of temporary picker output. */ }
        }
        setDocumentUri(null);
        setValues((current) => ({ ...current, aadhaar: '' }));
      }
      setBusy(false);
    }
  };

  const startLoginVerification = async () => {
    const phone = values.phone.replace(/\D/g, '');
    if (!/^\d{10}$/.test(phone)) {
      setErrors({ phone: 'farmerAuth.error.phone' });
      return;
    }
    if (!phoneVerificationConsented) {
      setErrors({ phoneVerificationConsent: 'farmerAuth.error.phoneVerificationConsent' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      farmerAuthRuntime.setPhone(phone);
      const result = await startFarmerPhoneVerification(phone);
      farmerAuthRuntime.setRegistrationOtp(false);
      farmerAuthRuntime.setPhoneVerification(result);
      setVerificationStatus('pending');
      router.push('/auth/farmer/otp' as never);
    } catch (error) {
      setNotice(farmerAuthErrorText(error, page));
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
      const destination = routeForFarmerAccount(account.accountStatus);
      if (destination === 'login') router.push('/auth/farmer/login' as never);
      else if (destination === 'verification' && account.verificationId) {
        farmerAuthRuntime.setVerification(account.verificationId, 'pending');
        router.push('/auth/farmer/verification' as never);
      } else if (destination === 'register') router.push('/auth/farmer/register' as never);
      else setNotice('farmerAuth.requestRejected');
    } catch (error) { setNotice(farmerAuthErrorText(error, page)); }
    finally { setBusy(false); }
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
        if (status.phoneVerificationConsentRequired) {
          setPhoneVerificationConsentRequired(true);
          setNotice('farmerAuth.phoneVerificationConsentPrompt');
          return;
        }
        const challenge = await startFarmerRegistrationPhoneVerification(id);
        farmerAuthRuntime.setRegistrationOtp(true);
        farmerAuthRuntime.setPhoneVerification(challenge);
        setVerificationStatus('pending');
        router.replace('/auth/farmer/otp' as never);
      } else if (status.documentComparison === 'pending' || status.status === 'pending') {
        farmerAuthRuntime.setVerification(id, 'pending');
        setNotice('farmerAuth.verificationPending');
      } else setNotice('farmerAuth.verificationFailed');
    } catch (error) { setNotice(farmerAuthErrorText(error, page)); }
    finally { setBusy(false); }
  };

  const giveRegistrationPhoneVerificationConsent = async () => {
    const id = farmerAuthRuntime.getVerification();
    if (!id) { setNotice('farmerAuth.backendUnavailable'); return; }
    setBusy(true);
    try {
      await consentForRegistrationPhoneVerification(id);
      setPhoneVerificationConsentRequired(false);
      await checkVerification();
    } catch (error) { setNotice(farmerAuthErrorText(error, page)); }
    finally { setBusy(false); }
  };

  const openDialer = async () => {
    const info = farmerAuthRuntime.getPhoneVerification();
    if (!info) return;
    try { await Linking.openURL(`tel:${info.callNumber.replace(/[^+\d]/g, '')}`); }
    catch { setNotice('farmerAuth.callUnavailable'); }
  };

  const finishVerified = useCallback(async (challengeId: string) => {
    if (finishingVerificationRef.current) return;
    finishingVerificationRef.current = true;
    setBusy(true);
    try {
      await completeFarmerPhoneVerification(challengeId);
      const sessionState = await getFarmerSessionState();
      if (sessionState === 'valid' || sessionState === 'unavailable' || sessionState === 'configuration-error') {
        farmerAuthRuntime.clearRegistrationOtp();
        farmerAuthRuntime.clearPhoneVerification();
        farmerAuthRuntime.clearVerification();
        router.replace('/farmer');
      } else setNotice('farmerAuth.sessionInvalid');
    } catch (error) { setNotice(farmerAuthErrorText(error, page)); }
    finally { finishingVerificationRef.current = false; setBusy(false); }
  }, [page]);

  const retryPhoneVerification = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const registration = farmerAuthRuntime.isRegistrationOtp();
      const id = farmerAuthRuntime.getVerification();
      const challenge = registration && id
        ? await startFarmerRegistrationPhoneVerification(id)
        : await startFarmerPhoneVerification(farmerAuthRuntime.getPhone());
      farmerAuthRuntime.setPhoneVerification(challenge);
      setVerificationStatus('pending');
    } catch (error) { setNotice(farmerAuthErrorText(error, page)); }
    finally { setBusy(false); }
  };

  const cancelPhoneVerificationFlow = async () => {
    const challenge = farmerAuthRuntime.getPhoneVerification();
    if (challenge) {
      setBusy(true);
      try { await cancelFarmerPhoneVerification(challenge.challengeId); }
      catch { /* Leaving the screen still stops polling; server expiry remains authoritative. */ }
      finally { setBusy(false); }
    }
    setVerificationStatus('cancelled');
    farmerAuthRuntime.clearPhoneVerification();
    router.replace(farmerAuthRuntime.isRegistrationOtp() ? '/auth/farmer/verification' as never : '/auth/farmer/login' as never);
  };

  useFocusEffect(useCallback(() => {
    if (page !== 'otp') return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const challenge = farmerAuthRuntime.getPhoneVerification();
    if (!challenge) { setNotice('farmerAuth.backendUnavailable'); return undefined; }
    const poll = async () => {
      if (!active || verificationStatus === 'expired' || verificationStatus === 'cancelled') return;
      if (AppState.currentState !== 'active') {
        timer = setTimeout(() => { void poll(); }, 2500);
        return;
      }
      try {
        const result = await getFarmerPhoneVerificationStatus(challenge.challengeId);
        if (!active) return;
        setVerificationStatus(result.status);
        if (result.status === 'verified') { await finishVerified(challenge.challengeId); return; }
        if (result.status === 'expired' || result.status === 'cancelled') return;
      } catch (error) { if (active) setNotice(farmerAuthErrorText(error, page)); }
      if (active) timer = setTimeout(() => { void poll(); }, 2500);
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [page, verificationStatus, finishVerified]));

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
    <Pressable accessibilityRole="button" accessibilityLabel={t('navigation.back')} onPress={() => page === 'otp' ? void cancelPhoneVerificationFlow() : router.replace(page === 'entry' ? '/' : '/auth/farmer')} style={styles.back}><Text style={styles.backText}>‹ {t('navigation.back')}</Text></Pressable>
    <LanguageSelector />
  </View>;
  const brand = <View style={styles.brand}><View style={styles.brandMark}><Text style={styles.brandGlyph}>❧</Text></View><View><Text style={styles.brandName}>{t('brand.name')}</Text><Text style={styles.brandRegion}>{t('brand.region')}</Text></View></View>;
  const banner = <View style={styles.demoBanner}><Text style={styles.demoText}>{t(capabilities?.phoneVerificationEnabled ? 'farmerAuth.secureBanner' : 'farmerAuth.demoBanner')}</Text></View>;
  const visibleNotice = notice ?? (page === 'otp' && !farmerAuthRuntime.getPhoneVerification() ? 'farmerAuth.backendUnavailable' : null);
  const noticeDetails = noticeFields.length && (notice === 'farmerAuth.documentMismatch' || notice === 'farmerAuth.documentFieldsMissing')
    ? t(notice === 'farmerAuth.documentMismatch' ? 'farmerAuth.fieldsMismatch' : 'farmerAuth.fieldsUnreadable')
      .replace('{fields}', noticeFields.map((fieldName) => t(farmerFieldLabelKeys[fieldName])).join(', '))
    : null;
  const suggestedNameNotice = notice === 'farmerAuth.documentMismatch' && noticeFields.includes('name') && suggestedFullName
    ? ` ${t('farmerAuth.suggestedFullName').replace('{name}', suggestedFullName)}`
    : '';
  const noticeView = visibleNotice ? <Text accessibilityRole="alert" style={styles.notice}>
    {t(visibleNotice)}{visibleNotice === notice && noticeDetails ? ` ${noticeDetails}` : ''}{visibleNotice === notice ? suggestedNameNotice : ''}
  </Text> : null;
  const button = (labelKey: TranslationKey, action: () => void, disabled = false) => <Pressable accessibilityRole="button" disabled={busy || disabled} onPress={action} style={({ pressed }) => [styles.primaryButton, (busy || disabled) && styles.disabled, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>{t(busy ? 'farmerAuth.loading' : labelKey)}</Text></Pressable>;

  return <ScreenFrame>
    {header}{brand}
    {page === 'entry' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text>
      <Text style={styles.title}>{t('farmerAuth.entryTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.entryIntro')}</Text>
      {banner}
      {loadingCapabilities || busy ? <Text style={styles.notice}>{t('farmerAuth.checkingSession')}</Text> : null}
      {!loadingCapabilities && !capabilityError && capabilities?.sessionSigningConfigured !== false && (entrySessionState === 'unavailable' || entrySessionState === 'configuration-error') ? <View style={styles.providerDisclosure}>
        <Text accessibilityRole="alert" style={styles.warningText}>{t(entrySessionState === 'configuration-error' ? 'farmerAuth.apiConfigurationMissing' : 'farmerAuth.sessionUnavailable')}</Text>
        {button('farmerAuth.retrySession', retryFarmerEntry)}
      </View> : null}
      {!loadingCapabilities && capabilityError ? <View style={styles.providerDisclosure}>
        <Text accessibilityRole="alert" style={styles.warningText}>{t(capabilityError)}</Text>
        {button('farmerAuth.retrySession', retryFarmerEntry)}
      </View> : null}
      {!loadingCapabilities && !capabilityError && capabilities && !capabilities.sessionSigningConfigured ? <View style={styles.providerDisclosure}>
        <Text accessibilityRole="alert" style={styles.warningText}>{t('farmerAuth.backendConfigurationIncomplete')}</Text>
        {capabilities.missingConfiguration?.length ? <Text selectable style={styles.help}>{capabilities.missingConfiguration.join(', ')}</Text> : null}
        {button('farmerAuth.retrySession', retryFarmerEntry)}
      </View> : null}
      {!loadingCapabilities && !capabilityError && capabilities?.sessionSigningConfigured && !capabilities.phoneVerificationConfigured ? <View style={styles.providerDisclosure}>
        <Text accessibilityRole="alert" style={styles.warningText}>{t('farmerAuth.phoneVerificationProviderMissing')}</Text>
        {capabilities.missingConfiguration?.length ? <Text selectable style={styles.help}>{capabilities.missingConfiguration.join(', ')}</Text> : null}
        {button('farmerAuth.retrySession', retryFarmerEntry)}
      </View> : null}
      {!loadingCapabilities && !capabilityError && capabilities?.sessionSigningConfigured && capabilities.phoneVerificationConfigured && (entrySessionState === 'missing' || entrySessionState === 'invalid') ? <>
        {field('phone', 'farmerAuth.phone', 'farmerAuth.phonePlaceholder', { keyboard: 'number-pad', maxLength: 10 })}
        {noticeView}{button('farmerAuth.continue', continueFromEntry)}
      </> : null}
    </View> : null}

    {page === 'register' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.registerTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.registerIntro')}</Text>{banner}
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
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: phoneVerificationConsented }} onPress={() => { setPhoneVerificationConsented((value) => !value); setErrors((current) => ({ ...current, phoneVerificationConsent: undefined })); }} style={styles.consentRow}><View style={[styles.checkbox, phoneVerificationConsented && styles.checkboxChecked]}>{phoneVerificationConsented ? <Text style={styles.checkmark}>✓</Text> : null}</View><Text style={styles.consentText}>{t('farmerAuth.phoneVerificationConsent')}</Text></Pressable>
      {errors.phoneVerificationConsent ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.phoneVerificationConsent)}</Text> : null}
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
    </View> : null}

    {page === 'login' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.loginTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.loginIntro')}</Text>{banner}
      {field('phone', 'farmerAuth.phone', 'farmerAuth.phonePlaceholder', { keyboard: 'number-pad', maxLength: 10 })}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: phoneVerificationConsented }} onPress={() => { setPhoneVerificationConsented((value) => !value); setErrors((current) => ({ ...current, phoneVerificationConsent: undefined })); }} style={styles.consentRow}><View style={[styles.checkbox, phoneVerificationConsented && styles.checkboxChecked]}>{phoneVerificationConsented ? <Text style={styles.checkmark}>✓</Text> : null}</View><Text style={styles.consentText}>{t('farmerAuth.phoneVerificationConsent')}</Text></Pressable>
      {errors.phoneVerificationConsent ? <Text accessibilityRole="alert" style={styles.error}>{t(errors.phoneVerificationConsent)}</Text> : null}
      {noticeView}{button('farmerAuth.startPhoneVerification', startLoginVerification)}
    </View> : null}

    {page === 'otp' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.phoneVerificationTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.phoneVerificationIntro')}</Text>{banner}
      {farmerAuthRuntime.getPhoneVerification() ? <View style={styles.callPanel}>
        <Text style={styles.label}>{t('farmerAuth.callNumber')}</Text>
        <Text accessibilityRole="text" style={styles.callNumber}>{farmerAuthRuntime.getPhoneVerification()!.callNumber}</Text>
        <Text style={styles.help}>{farmerAuthRuntime.getPhoneVerification()!.instruction}</Text>
        <Text style={styles.help}>{t('farmerAuth.callMayEndQuickly')}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void openDialer()} style={[styles.secondaryButton, busy && styles.disabled]}><Text style={styles.linkText}>{t('farmerAuth.callNow')}</Text></Pressable>
        <Text accessibilityLiveRegion="polite" style={verificationStatus === 'expired' ? styles.warning : styles.notice}>{t(verificationStatus === 'expired' ? 'farmerAuth.phoneVerificationExpired' : verificationStatus === 'verified' ? 'farmerAuth.phoneVerificationFinishing' : verificationStatus === 'cancelled' ? 'farmerAuth.phoneVerificationCancelled' : 'farmerAuth.phoneVerificationWaiting')}</Text>
      </View> : null}
      {noticeView}
      {verificationStatus === 'expired' ? button('farmerAuth.retryPhoneVerification', retryPhoneVerification) : null}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void cancelPhoneVerificationFlow()} style={styles.returnLink}><Text style={styles.linkText}>{t('farmerAuth.cancelPhoneVerification')}</Text></Pressable>
    </View> : null}

    {page === 'verification' ? <View style={styles.card}>
      <Text style={styles.eyebrow}>{t('auth.role.farmer')}</Text><Text style={styles.title}>{t('farmerAuth.verificationTitle')}</Text>
      <Text style={styles.intro}>{t('farmerAuth.verificationIntro')}</Text>{banner}
      {noticeView ?? <Text style={styles.notice}>{t(farmerAuthRuntime.getVerificationState() === 'failed' ? 'farmerAuth.verificationFailed' : 'farmerAuth.verificationPending')}</Text>}
      {phoneVerificationConsentRequired ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: phoneVerificationConsented }} onPress={() => setPhoneVerificationConsented((value) => !value)} style={styles.consentRow}><View style={[styles.checkbox, phoneVerificationConsented && styles.checkboxChecked]}>{phoneVerificationConsented ? <Text style={styles.checkmark}>✓</Text> : null}</View><Text style={styles.consentText}>{t('farmerAuth.phoneVerificationConsent')}</Text></Pressable> : null}
      {phoneVerificationConsentRequired && phoneVerificationConsented ? button('farmerAuth.confirmPhoneVerificationConsent', giveRegistrationPhoneVerificationConsent) : null}
      {button('farmerAuth.checkStatus', checkVerification)}
    </View> : null}

    <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.returnLink}><Text style={styles.linkText}>{t('navigation.returnToWelcome')}</Text></Pressable>
  </ScreenFrame>;
}

export function FarmerDashboardGuard({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [sessionState, setSessionState] = useState<FarmerSessionState | 'checking'>('checking');
  const [busy, setBusy] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const restore = useCallback(async () => {
    const state = await getFarmerSessionState();
    setSessionState(state);
    const destination = routeForFarmerSession(state);
    if (destination === 'authentication') router.replace('/auth/farmer');
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => { void restore(); }, 0);
    return () => clearTimeout(timer);
  }, [restore]);
  if (sessionState === 'checking') return <ScreenFrame><Text style={styles.notice}>{t('farmerAuth.checkingSession')}</Text></ScreenFrame>;
  if (sessionState !== 'valid') return <ScreenFrame>
    <View style={styles.card}>
      <Text accessibilityRole="alert" style={styles.notice}>{t(sessionState === 'invalid' || sessionState === 'missing' ? 'farmerAuth.sessionInvalid' : sessionState === 'configuration-error' ? 'farmerAuth.apiConfigurationMissing' : 'farmerAuth.sessionUnavailable')}</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setBusy(true); void restore().finally(() => setBusy(false)); }} style={styles.primaryButton}><Text style={styles.primaryButtonText}>{t(busy ? 'farmerAuth.loading' : 'farmerAuth.retrySession')}</Text></Pressable>
    </View>
  </ScreenFrame>;
  return <View style={styles.gate}><View style={styles.logoutBar}>
    {logoutError ? <Text accessibilityRole="alert" style={styles.error}>{t('farmerAuth.logoutFailed')}</Text> : null}
    <Pressable accessibilityRole="button" disabled={busy} onPress={async () => {
      setBusy(true); setLogoutError(false);
      try { await logoutFarmer(); router.dismissAll(); router.replace('/auth/farmer'); }
      catch { setLogoutError(true); }
      finally { setBusy(false); }
    }} style={styles.logoutButton}><Text style={styles.linkText}>{t(busy ? 'farmerAuth.loading' : 'farmerAuth.logout')}</Text></Pressable>
  </View>{children}</View>;
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  back: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 }, backText: { color: MarketColors.green, fontSize: 14, fontWeight: '700' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 }, brandMark: { width: 43, height: 43, borderRadius: 15, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' }, brandGlyph: { color: '#fff', fontSize: 26, lineHeight: 30 }, brandName: { color: MarketColors.text, fontSize: 17, fontWeight: '800' }, brandRegion: { color: MarketColors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.1, marginTop: 2 },
  card: { backgroundColor: MarketColors.card, borderRadius: 22, borderWidth: 1, borderColor: MarketColors.border, padding: 20, gap: 12 }, eyebrow: { color: MarketColors.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 }, title: { color: MarketColors.text, fontSize: 25, fontWeight: '800' }, intro: { color: MarketColors.muted, fontSize: 14, lineHeight: 20 }, demoBanner: { borderRadius: 13, backgroundColor: MarketColors.blueSoft, padding: 12 }, demoText: { color: MarketColors.blue, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  field: { gap: 6 }, label: { color: MarketColors.text, fontSize: 13, fontWeight: '700' }, input: { minHeight: 48, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background, paddingHorizontal: 12, color: MarketColors.text, fontSize: 14 }, help: { color: MarketColors.muted, fontSize: 11, lineHeight: 16 }, error: { color: '#B42318', fontSize: 12 }, notice: { color: MarketColors.blue, fontSize: 13, lineHeight: 19 }, warning: { color: '#8A5A00', backgroundColor: '#FFF4D6', borderRadius: 12, padding: 11, fontSize: 12, lineHeight: 18 }, warningText: { color: '#8A5A00', fontSize: 12, lineHeight: 18 },
  phoneInputRow: { flexDirection: 'row', gap: 8 }, countryPrefix: { minHeight: 48, minWidth: 60, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background }, countryPrefixText: { color: MarketColors.text, fontSize: 14, fontWeight: '700' }, phoneInput: { flex: 1 },
  genderRow: { flexDirection: 'row', gap: 7 }, genderOption: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, paddingHorizontal: 5 }, genderSelected: { backgroundColor: MarketColors.greenSoft, borderColor: MarketColors.green }, genderText: { color: MarketColors.text, fontSize: 12, fontWeight: '600' },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 }, checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' }, checkboxChecked: { backgroundColor: MarketColors.green }, checkmark: { color: '#fff', fontSize: 15, fontWeight: '800' }, consentText: { flex: 1, color: MarketColors.text, fontSize: 12, lineHeight: 18 },
  documentActions: { flexDirection: 'row', gap: 9 }, secondaryButton: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: MarketColors.green, borderRadius: 12, paddingHorizontal: 6 }, providerDisclosure: { borderRadius: 12, backgroundColor: MarketColors.background, padding: 10, gap: 4 },
  callPanel: { borderRadius: 14, backgroundColor: MarketColors.background, padding: 14, gap: 10 }, callNumber: { color: MarketColors.green, fontSize: 28, fontWeight: '800', textAlign: 'center', letterSpacing: 1.2 },
  primaryButton: { minHeight: 49, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: MarketColors.green, paddingHorizontal: 12 }, primaryButtonText: { color: '#fff', textAlign: 'center', fontSize: 14, fontWeight: '800' }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.72 }, linkText: { color: MarketColors.green, fontSize: 13, fontWeight: '700', textAlign: 'center' }, returnLink: { alignSelf: 'center', padding: 13 }, gate: { flex: 1 }, logoutBar: { alignItems: 'flex-end', marginBottom: 8 }, logoutButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: MarketColors.greenSoft },
});
