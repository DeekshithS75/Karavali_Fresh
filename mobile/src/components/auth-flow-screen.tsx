import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LanguageSelector } from '@/components/language-selector';
import { MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { useLanguage } from '@/localization/LanguageProvider';
import type { TranslationKey } from '@/localization/types';
import { authRoutes, type AuthPage, type AuthRole } from '@/features/auth/routes';

type Props = { role: AuthRole; page: AuthPage };
type Field = 'name' | 'mobile' | 'password' | 'confirm' | 'village' | 'otp';
type Errors = Partial<Record<Field, TranslationKey>>;

const roleKey = (role: AuthRole) => role === 'farmer' ? 'auth.role.farmer' : 'auth.role.consumer';
const homeRoute = (role: AuthRole) => role === 'farmer' ? '/farmer' : '/consumer';

export function AuthFlowScreen({ role, page }: Props) {
  const { t } = useLanguage();
  const [values, setValues] = useState<Record<Field, string>>({ name: '', mobile: '', password: '', confirm: '', village: '', otp: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const isLogin = page === 'login';
  const isRegister = page === 'register';
  const isForgot = page === 'forgot-password';
  const isOtp = page === 'otp';
  const titleKey: TranslationKey = isLogin
    ? role === 'farmer' ? 'auth.loginTitle.farmer' : 'auth.loginTitle.consumer'
    : isRegister ? role === 'farmer' ? 'auth.registerTitle.farmer' : 'auth.registerTitle.consumer'
      : isForgot ? 'auth.forgotTitle' : 'auth.otpTitle';
  const introKey: TranslationKey = isLogin ? 'auth.loginIntro' : isRegister ? 'auth.registerIntro' : isForgot ? 'auth.forgotIntro' : 'auth.otpIntro';

  const update = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };
  const validMobile = /^\d{10}$/.test(values.mobile.replace(/\D/g, ''));
  const validate = (): boolean => {
    const next: Errors = {};
    if (isRegister && !values.name.trim()) next.name = 'auth.error.fullNameRequired';
    if ((isLogin || isRegister || isForgot) && !values.mobile.trim()) next.mobile = 'auth.error.mobileRequired';
    else if ((isLogin || isRegister || isForgot) && !validMobile) next.mobile = 'auth.error.mobileInvalid';
    if (isLogin || isRegister) {
      if (!values.password) next.password = 'auth.error.passwordRequired';
      else if (values.password.length < 8) next.password = 'auth.error.passwordShort';
    }
    if (isRegister && values.password && values.password !== values.confirm) next.confirm = 'auth.error.passwordMismatch';
    if (isRegister && role === 'farmer' && !values.village.trim()) next.village = 'auth.error.villageRequired';
    if (isOtp && !/^\d{6}$/.test(values.otp)) next.otp = 'auth.error.otpInvalid';
    setErrors(next);
    return Object.keys(next).length === 0;
  };
  const submit = () => {
    if (!validate()) return;
    if (isLogin) {
      // Demo-only navigation. No credentials are stored or sent to a service.
      router.replace(homeRoute(role));
      return;
    }
    if (isRegister) {
      setValues({ name: '', mobile: '', password: '', confirm: '', village: '', otp: '' });
      setNotice('auth.registrationDemoNotice');
      return;
    }
    if (isForgot) {
      setValues((current) => ({ ...current, otp: '' }));
      router.push(authRoutes[role].otp as never);
      return;
    }
    setNotice('auth.otpActionNotice');
  };
  const back = () => {
    if (isLogin) router.replace('/');
    else if (isRegister || isForgot) router.replace(authRoutes[role].login as never);
    else router.replace(authRoutes[role]['forgot-password'] as never);
  };

  const field = (name: Field, labelKey: TranslationKey, placeholderKey: TranslationKey, options: { secure?: boolean; keyboard?: 'default' | 'number-pad'; maxLength?: number } = {}) => (
    <View style={styles.fieldWrap} key={name}>
      <Text style={styles.label}>{t(labelKey)}</Text>
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel={t(labelKey)}
          value={values[name]}
          onChangeText={(value) => update(name, value)}
          placeholder={t(placeholderKey)}
          placeholderTextColor={MarketColors.muted}
          autoCapitalize={name === 'mobile' || name === 'otp' ? 'none' : 'words'}
          keyboardType={options.keyboard ?? 'default'}
          secureTextEntry={options.secure && !passwordVisible}
          maxLength={options.maxLength}
          style={styles.input}
        />
        {options.secure ? <Pressable accessibilityRole="button" accessibilityLabel={t(passwordVisible ? 'auth.hidePassword' : 'auth.showPassword')} onPress={() => setPasswordVisible((visible) => !visible)} style={styles.visibility}><Text style={styles.visibilityText}>{t(passwordVisible ? 'auth.hidePassword' : 'auth.showPassword')}</Text></Pressable> : null}
      </View>
      {errors[name] ? <Text accessibilityRole="alert" style={styles.error}>{t(errors[name]!)}</Text> : null}
    </View>
  );

  return (
    <ScreenFrame>
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('navigation.back')} onPress={back} style={styles.backButton}><Text style={styles.backText}>‹ {t('navigation.back')}</Text></Pressable>
        <LanguageSelector />
      </View>
      <View style={styles.brand}><View style={styles.brandMark}><Text style={styles.brandGlyph}>❧</Text></View><View><Text style={styles.brandName}>{t('brand.name')}</Text><Text style={styles.brandRegion}>{t('brand.region')}</Text></View></View>
      <View style={styles.card}>
        <Text style={styles.role}>{t(roleKey(role))}</Text>
        <Text style={styles.title}>{t(titleKey)}</Text>
        <Text style={styles.intro}>{t(introKey)}</Text>
        <View style={styles.demoBanner}><Text style={styles.demoText}>{t('auth.demoBanner')}</Text></View>
        {isRegister ? field('name', 'auth.fullName', 'auth.fullNamePlaceholder') : null}
        {isLogin || isRegister || isForgot ? field('mobile', 'auth.mobile', 'auth.mobilePlaceholder', { keyboard: 'number-pad', maxLength: 10 }) : null}
        {isLogin || isRegister ? field('password', 'auth.password', 'auth.passwordPlaceholder', { secure: true }) : null}
        {isRegister ? field('confirm', 'auth.confirmPassword', 'auth.confirmPasswordPlaceholder', { secure: true }) : null}
        {isRegister && role === 'farmer' ? field('village', 'auth.villageArea', 'auth.villageAreaPlaceholder') : null}
        {isOtp ? field('otp', 'auth.otpCode', 'auth.otpCodePlaceholder', { keyboard: 'number-pad', maxLength: 6 }) : null}
        {isForgot ? <Text style={styles.notice}>{t('auth.forgotDemoNotice')}</Text> : null}
        {isOtp ? <Text style={styles.notice}>{t('auth.otpDemoNotice')}</Text> : null}
        {notice ? <Text accessibilityRole="alert" style={styles.notice}>{t(notice)}</Text> : null}
        <Pressable accessibilityRole="button" onPress={submit} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
          <Text style={styles.primaryButtonText}>{t(isLogin ? role === 'farmer' ? 'auth.signInFarmerDemo' : 'auth.signInConsumerDemo' : isRegister ? 'auth.registerDemo' : isForgot ? 'auth.continueOtpDemo' : 'auth.verifyOtpDemo')}</Text>
        </Pressable>
        {isLogin ? <>
          <Pressable accessibilityRole="button" onPress={() => router.push(authRoutes[role].register as never)} style={styles.linkButton}><Text style={styles.linkText}>{t('auth.createAccount')}</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push(authRoutes[role]['forgot-password'] as never)} style={styles.linkButton}><Text style={styles.linkText}>{t('auth.forgotPasswordLink')}</Text></Pressable>
        </> : null}
        {isRegister || isForgot || isOtp ? <Pressable accessibilityRole="button" onPress={() => router.replace(authRoutes[role].login as never)} style={styles.linkButton}><Text style={styles.linkText}>{t('auth.returnToLogin')}</Text></Pressable> : null}
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  backButton: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 },
  backText: { color: MarketColors.green, fontSize: 14, fontWeight: '700' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  brandMark: { width: 43, height: 43, borderRadius: 15, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' },
  brandGlyph: { color: '#fff', fontSize: 26, lineHeight: 30 },
  brandName: { color: MarketColors.text, fontSize: 17, fontWeight: '800' },
  brandRegion: { color: MarketColors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.1, marginTop: 2 },
  card: { backgroundColor: MarketColors.card, borderRadius: 22, borderWidth: 1, borderColor: MarketColors.border, padding: 20, gap: 12 },
  role: { color: MarketColors.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  title: { color: MarketColors.text, fontSize: 25, fontWeight: '800' },
  intro: { color: MarketColors.muted, fontSize: 14, lineHeight: 20 },
  demoBanner: { borderRadius: 13, backgroundColor: MarketColors.blueSoft, padding: 12 },
  demoText: { color: MarketColors.blue, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  fieldWrap: { gap: 6 },
  label: { color: MarketColors.text, fontSize: 13, fontWeight: '700' },
  inputRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background, paddingHorizontal: 12 },
  input: { flex: 1, minHeight: 46, color: MarketColors.text, fontSize: 14 },
  visibility: { paddingVertical: 10, paddingLeft: 8 },
  visibilityText: { color: MarketColors.green, fontSize: 11, fontWeight: '700' },
  error: { color: '#B42318', fontSize: 12 },
  notice: { color: MarketColors.blue, fontSize: 12, lineHeight: 18 },
  primaryButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: MarketColors.green, paddingHorizontal: 14, marginTop: 2 },
  primaryButtonText: { color: '#fff', textAlign: 'center', fontSize: 14, fontWeight: '800' },
  linkButton: { minHeight: 38, justifyContent: 'center', alignItems: 'center' },
  linkText: { color: MarketColors.green, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
