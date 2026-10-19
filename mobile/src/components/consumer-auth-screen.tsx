import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LanguageSelector } from '@/components/language-selector';
import { MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { ConsumerAuthError, getConsumerSessionState, loginConsumer, registerConsumer } from '@/features/consumer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';

type Page = 'login' | 'register' | 'forgot-password' | 'otp';

export function ConsumerAuthScreen({ page }: { page: Page }) {
  const { t } = useLanguage();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isRegister = page === 'register';
  const unsupportedPage = page === 'forgot-password' || page === 'otp';

  useEffect(() => {
    if (page !== 'login') return;
    let active = true;
    void getConsumerSessionState().then((state) => { if (active && state === 'valid') router.replace('/consumer'); });
    return () => { active = false; };
  }, [page]);

  const submit = async () => {
    setErrorKey(null);
    if (isRegister && !fullName.trim()) { setErrorKey('consumer.auth.nameRequired'); return; }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErrorKey('consumer.auth.emailInvalid'); return; }
    if (!password || (isRegister && password.length < 10)) { setErrorKey('consumer.auth.passwordInvalid'); return; }
    if (isRegister && password !== confirm) { setErrorKey('consumer.auth.passwordMismatch'); return; }
    setBusy(true);
    try {
      if (isRegister) await registerConsumer({ fullName: fullName.trim(), email: email.trim(), password });
      else await loginConsumer({ email: email.trim(), password });
      router.replace('/consumer');
    } catch (error) {
      const key = error instanceof ConsumerAuthError ? ({
        emailRegistered: 'consumer.auth.emailRegistered',
        invalidCredentials: 'consumer.auth.invalidCredentials',
        rateLimited: 'consumer.auth.rateLimited',
        configurationIncomplete: 'consumer.auth.notConfigured',
        apiUrlMissing: 'consumer.auth.notConfigured',
        urlNotAllowed: 'consumer.auth.notConfigured',
        network: 'consumer.auth.networkError',
        validationFailed: 'consumer.auth.invalidInput',
        rejected: 'consumer.auth.invalidInput',
        unauthorized: 'consumer.auth.invalidCredentials',
      } as const)[error.code] : 'consumer.auth.networkError';
      setErrorKey(key ?? 'consumer.auth.networkError');
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
        <View style={styles.field}><Text style={styles.label}>{t('consumer.auth.email')}</Text><TextInput accessibilityLabel={t('consumer.auth.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" style={styles.input} /></View>
        <View style={styles.field}><Text style={styles.label}>{t('consumer.auth.password')}</Text><View style={styles.passwordRow}><TextInput accessibilityLabel={t('consumer.auth.password')} value={password} onChangeText={setPassword} secureTextEntry={!passwordVisible} autoCapitalize="none" autoComplete={isRegister ? 'new-password' : 'current-password'} style={styles.password} /><Pressable accessibilityRole="button" onPress={() => setPasswordVisible((value) => !value)} style={styles.toggle}><Text style={styles.toggleText}>{t(passwordVisible ? 'consumer.auth.hidePassword' : 'consumer.auth.showPassword')}</Text></Pressable></View></View>
        {isRegister ? <View style={styles.field}><Text style={styles.label}>{t('consumer.auth.confirmPassword')}</Text><TextInput accessibilityLabel={t('consumer.auth.confirmPassword')} value={confirm} onChangeText={setConfirm} secureTextEntry={!passwordVisible} autoCapitalize="none" autoComplete="new-password" style={styles.input} /></View> : null}
        {errorKey ? <Text accessibilityRole="alert" style={styles.error}>{t(errorKey as never)}</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void submit()} style={[styles.primary, busy && styles.disabled]}><Text style={styles.primaryText}>{t(busy ? 'consumer.auth.working' : isRegister ? 'consumer.auth.createAccount' : 'consumer.auth.signIn')}</Text></Pressable>
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
