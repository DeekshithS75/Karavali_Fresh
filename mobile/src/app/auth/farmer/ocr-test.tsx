import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LanguageSelector } from '@/components/language-selector';
import { MarketColors, ScreenFrame } from '@/components/marketplace-ui';
import { FarmerAuthError, runFarmerOcrTest, type FarmerOcrTestInput, type FarmerOcrTestResult } from '@/features/farmer-auth/client';
import { useLanguage } from '@/localization/LanguageProvider';
import type { TranslationKey } from '@/localization/types';

type ImageSelection = { uri: string; type: string; name: string };
export default function FarmerOcrTestScreen() {
  const { t } = useLanguage();
  const [values, setValues] = useState<FarmerOcrTestInput>({ fullName: '', dateOfBirth: '', gender: 'male', address: '' });
  const [image, setImage] = useState<ImageSelection | null>(null);
  const [result, setResult] = useState<FarmerOcrTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [validation, setValidation] = useState<TranslationKey | null>(null);

  const chooseImage = async () => {
    if (busy) return;
    setError(null); setResult(null);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, allowsEditing: false });
      if (!picked.canceled && picked.assets[0]) {
        const asset = picked.assets[0];
        setImage({ uri: asset.uri, type: asset.mimeType ?? 'image/jpeg', name: asset.fileName ?? 'sample-image' });
      }
    } catch { setError('ocrTest.imageError'); }
  };

  const runTest = async () => {
    setError(null); setResult(null); setValidation(null);
    if (!image) { setValidation('ocrTest.error.image'); return; }
    if (!values.fullName.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(values.dateOfBirth) || !values.address.trim()) {
      setValidation('ocrTest.error.fields'); return;
    }
    setBusy(true);
    try { setResult(await runFarmerOcrTest(values, image.uri, image.type, image.name)); }
    catch (cause) {
      setError(cause instanceof FarmerAuthError && cause.code === 'apiUrlMissing' ? 'ocrTest.backendUrlMissing'
        : cause instanceof FarmerAuthError && cause.code === 'urlNotAllowed' ? 'ocrTest.urlNotAllowed'
          : cause instanceof FarmerAuthError && cause.code === 'testModeDisabled' ? 'ocrTest.notEnabled'
            : cause instanceof FarmerAuthError && cause.code === 'network' ? 'ocrTest.networkError'
        : cause instanceof FarmerAuthError && cause.code === 'ocrUnavailable' ? 'ocrTest.notConfigured'
          : 'ocrTest.requestError');
    } finally { setBusy(false); }
  };

  const field = (key: 'fullName' | 'dateOfBirth' | 'address', labelKey: TranslationKey, placeholderKey: TranslationKey, multiline = false) => (
    <View style={styles.field} key={key}>
      <Text style={styles.label}>{t(labelKey)}</Text>
      <TextInput accessibilityLabel={t(labelKey)} value={values[key]} onChangeText={(value) => { setValues((current) => ({ ...current, [key]: value })); setValidation(null); }} placeholder={t(placeholderKey)} placeholderTextColor={MarketColors.muted} autoCapitalize={key === 'dateOfBirth' ? 'none' : 'words'} multiline={multiline} style={[styles.input, multiline && styles.multiline]} />
    </View>
  );

  const comparisonText = (value: 'match' | 'mismatch' | 'unreadable') => t(`ocrTest.comparison.${value}` as TranslationKey);
  const statusColor = result?.status === 'match' ? MarketColors.green : result?.status === 'mismatch' ? '#B54708' : MarketColors.blue;
  const issueKey = (issue: string): TranslationKey => ({ low_resolution: 'ocrTest.issue.lowResolution', too_bright: 'ocrTest.issue.tooBright', too_dark: 'ocrTest.issue.tooDark', low_contrast: 'ocrTest.issue.lowContrast', blurred: 'ocrTest.issue.blurred', unsupported_image: 'ocrTest.issue.unsupported', text_not_recognized: 'ocrTest.issue.noText', required_fields_missing: 'ocrTest.issue.missingFields' }[issue] as TranslationKey) ?? 'ocrTest.issue.missingFields';

  return <ScreenFrame>
    <View style={styles.topBar}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('navigation.back')} onPress={() => router.back()} style={styles.back}><Text style={styles.link}>‹ {t('navigation.back')}</Text></Pressable>
      <LanguageSelector />
    </View>
    <Text style={styles.eyebrow}>{t('ocrTest.eyebrow')}</Text>
    <Text style={styles.title}>{t('ocrTest.title')}</Text>
    <Text style={styles.intro}>{t('ocrTest.description')}</Text>
    <View style={styles.note}><Text style={styles.noteText}>{t('ocrTest.syntheticNote')}</Text></View>

    <View style={styles.card}>
      {field('fullName', 'ocrTest.fullName', 'ocrTest.fullNamePlaceholder')}
      {field('dateOfBirth', 'ocrTest.dateOfBirth', 'ocrTest.dateOfBirthPlaceholder')}
      <Text style={styles.label}>{t('ocrTest.gender')}</Text>
      <View style={styles.genderRow}>{(['male', 'female', 'other'] as const).map((gender) => <Pressable key={gender} accessibilityRole="radio" accessibilityState={{ selected: values.gender === gender }} onPress={() => setValues((current) => ({ ...current, gender }))} style={[styles.genderButton, values.gender === gender && styles.genderSelected]}><Text style={styles.genderText}>{t(`farmerAuth.gender.${gender}` as TranslationKey)}</Text></Pressable>)}</View>
      {field('address', 'ocrTest.address', 'ocrTest.addressPlaceholder', true)}
      <Text style={styles.help}>{t('ocrTest.ocrCaveat')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('ocrTest.chooseImage')} disabled={busy} onPress={chooseImage} style={[styles.secondaryButton, busy && styles.disabled]}><Text style={styles.link}>{t(image ? 'ocrTest.chooseAnother' : 'ocrTest.chooseImage')}</Text></Pressable>
      {image ? <View style={styles.preview}><Image source={{ uri: image.uri }} style={styles.image} resizeMode="contain" accessibilityLabel={t('ocrTest.selectedImage')} /><Text style={styles.help}>{t('ocrTest.imageSelected')}</Text></View> : <Text style={styles.help}>{t('ocrTest.noImage')}</Text>}
      {validation ? <Text accessibilityRole="alert" style={styles.error}>{t(validation)}</Text> : null}
      {error ? <View accessibilityRole="alert" style={styles.errorCard}><Text style={styles.errorStatus}>{t('ocrTest.status.error')}</Text><Text style={styles.error}>{t(error)}</Text><Text style={styles.help}>{t('ocrTest.retryGuidance')}</Text></View> : null}
      <Pressable accessibilityRole="button" disabled={busy || !image} onPress={runTest} style={[styles.primaryButton, (busy || !image) && styles.disabled]}>
        {busy ? <View style={styles.loading}><ActivityIndicator color="#fff" /><Text style={styles.buttonText}>{t('ocrTest.processing')}</Text></View> : <Text style={styles.buttonText}>{t('ocrTest.run')}</Text>}
      </Pressable>
    </View>

    {result ? <View accessibilityLiveRegion="polite" style={styles.resultCard}>
      <Text style={[styles.status, { color: statusColor }]}>{t(`ocrTest.status.${result.status}` as TranslationKey)}</Text>
      <Text style={styles.sectionTitle}>{t('ocrTest.extracted')}</Text>
      {(['fullName', 'dateOfBirth', 'gender', 'address'] as const).map((key) => {
        const val = result.extracted[key];
        const display = val ? key === 'gender' ? t(`farmerAuth.gender.${val}` as TranslationKey) : val : t('ocrTest.unreadableValue');
        return <View key={key} style={styles.resultRow}><Text style={styles.resultLabel}>{t(`ocrTest.${key}` as TranslationKey)}</Text><Text selectable style={styles.resultValue}>{display}</Text></View>;
      })}
      <Text style={styles.sectionTitle}>{t('ocrTest.comparisons')}</Text>
      {(['fullName', 'dateOfBirth', 'gender', 'address'] as const).map((key) => <View key={key} style={styles.resultRow}><Text style={styles.resultLabel}>{t(`ocrTest.${key}` as TranslationKey)}</Text><Text style={[styles.resultValue, { color: result.comparisons[key] === 'match' ? MarketColors.green : result.comparisons[key] === 'mismatch' ? '#B42318' : MarketColors.blue }]}>{comparisonText(result.comparisons[key])}</Text></View>)}
      {result.issues?.length ? <View style={styles.guidance}><Text style={styles.sectionTitle}>{t('ocrTest.retryTitle')}</Text>{result.issues.map((issue) => <Text key={issue} style={styles.help}>• {t(issueKey(issue))}</Text>)}<Text style={styles.help}>{t('ocrTest.retryGuidance')}</Text></View> : result.status === 'mismatch' ? <Text style={styles.help}>{t('ocrTest.mismatchGuidance')}</Text> : null}
    </View> : null}
    <Pressable accessibilityRole="button" onPress={() => router.replace('/auth/farmer/register' as never)} style={styles.return}><Text style={styles.link}>{t('ocrTest.returnToRegistration')}</Text></Pressable>
  </ScreenFrame>;
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }, back: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 },
  eyebrow: { color: MarketColors.blue, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 7 }, title: { color: MarketColors.text, fontSize: 26, fontWeight: '800' }, intro: { color: MarketColors.muted, fontSize: 14, lineHeight: 20, marginTop: 8, marginBottom: 13 },
  note: { backgroundColor: MarketColors.blueSoft, borderRadius: 13, padding: 12, marginBottom: 14 }, noteText: { color: MarketColors.blue, fontSize: 12, lineHeight: 18, fontWeight: '600' }, card: { backgroundColor: MarketColors.card, borderRadius: 20, borderWidth: 1, borderColor: MarketColors.border, padding: 17, gap: 12 }, field: { gap: 6 }, label: { color: MarketColors.text, fontSize: 13, fontWeight: '700' }, input: { minHeight: 47, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 12, backgroundColor: MarketColors.background, paddingHorizontal: 12, color: MarketColors.text, fontSize: 14 }, multiline: { minHeight: 80, paddingVertical: 10, textAlignVertical: 'top' }, help: { color: MarketColors.muted, fontSize: 11, lineHeight: 16 },
  genderRow: { flexDirection: 'row', gap: 7 }, genderButton: { flex: 1, minHeight: 41, borderWidth: 1, borderColor: MarketColors.border, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }, genderSelected: { borderColor: MarketColors.green, backgroundColor: MarketColors.greenSoft }, genderText: { color: MarketColors.text, fontSize: 12, fontWeight: '600' }, secondaryButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: MarketColors.green, borderRadius: 12 }, link: { color: MarketColors.green, fontSize: 13, fontWeight: '700', textAlign: 'center' }, preview: { alignItems: 'center', gap: 5 }, image: { width: '100%', height: 210, borderRadius: 10, backgroundColor: MarketColors.background },
  primaryButton: { minHeight: 49, borderRadius: 14, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, buttonText: { color: '#fff', fontSize: 14, fontWeight: '800' }, loading: { flexDirection: 'row', alignItems: 'center', gap: 9 }, disabled: { opacity: 0.45 }, error: { color: '#B42318', fontSize: 12, lineHeight: 17 }, errorCard: { marginTop: 16, backgroundColor: '#FFF3F1', borderRadius: 16, borderWidth: 1, borderColor: '#F2C4BE', padding: 15, gap: 7 }, errorStatus: { color: '#B42318', fontSize: 15, fontWeight: '800' }, resultCard: { marginTop: 16, backgroundColor: MarketColors.card, borderRadius: 20, borderWidth: 1, borderColor: MarketColors.border, padding: 17, gap: 8 }, status: { fontSize: 17, fontWeight: '800', marginBottom: 2 }, sectionTitle: { color: MarketColors.text, fontSize: 14, fontWeight: '800', marginTop: 5 }, resultRow: { borderBottomWidth: 1, borderColor: MarketColors.border, paddingVertical: 7, gap: 3 }, resultLabel: { color: MarketColors.muted, fontSize: 11, fontWeight: '700' }, resultValue: { color: MarketColors.text, fontSize: 13, lineHeight: 18 }, guidance: { marginTop: 4, gap: 4 }, return: { alignSelf: 'center', padding: 16 },
});
