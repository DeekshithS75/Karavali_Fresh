import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LanguageSelector } from '@/components/language-selector';
import { useLanguage } from '@/localization/LanguageProvider';

const colors = {
  green: '#287A49',
  greenDark: '#1E633A',
  greenSoft: '#E8F3E8',
  blue: '#287D9B',
  blueSoft: '#E7F2F6',
  background: '#F8F8F2',
  card: '#FFFFFF',
  text: '#24312B',
  muted: '#66746C',
  border: '#E5EAE3',
};

export default function WelcomeScreen() {
  const { width } = useWindowDimensions();
  const compact = width < 390;
  const { t } = useLanguage();

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandLeaf} accessibilityLabel={t('accessibility.brandMark')}>
                ❧
              </Text>
            </View>
            <View>
              <Text style={styles.brandName}>{t('brand.name')}</Text>
              <Text style={styles.brandRegion}>{t('brand.region')}</Text>
            </View>
            <LanguageSelector />
          </View>

          <View style={[styles.hero, compact && styles.heroCompact]}>
            <View style={styles.heroBadge}>
              <View style={styles.badgeDot} />
              <Text style={styles.heroBadgeText}>{t('welcome.eyebrow')}</Text>
            </View>
            <Text style={[styles.headline, compact && styles.headlineCompact]}>
              {t('welcome.headline')}
            </Text>
            <Text style={styles.tagline}>{t('welcome.tagline')}</Text>
            <Text style={styles.description}>{t('welcome.description')}</Text>

            <View style={styles.illustration}>
              <View style={styles.sun} />
              <View style={styles.fieldBack} />
              <View style={styles.fieldFront} />
              <View style={styles.produceCard}>
                <Text style={styles.produceEmoji} accessibilityElementsHidden>🥥</Text>
                <Text style={styles.produceEmoji} accessibilityElementsHidden>🥬</Text>
                <Text style={styles.produceEmoji} accessibilityElementsHidden>🍌</Text>
              </View>
              <View style={styles.coastPill}>
                <Text style={styles.coastPillText}>🌊  {t('welcome.coastNote')}</Text>
              </View>
            </View>
          </View>

          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>{t('welcome.joinTitle')}</Text>
            <Text style={styles.actionSubtitle}>{t('welcome.joinDescription')}</Text>

            <RoleButton
              title={t('welcome.farmerButton')}
              subtitle={t('welcome.farmerSubtitle')}
              icon="🌱"
              onPress={() => router.push('/farmer')}
              primary
            />
            <RoleButton
              title={t('welcome.consumerButton')}
              subtitle={t('welcome.consumerSubtitle')}
              icon="🧺"
              onPress={() => router.push('/consumer')}
            />
            <Text style={styles.footerNote}>{t('welcome.footer')}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type RoleButtonProps = {
  title: string;
  subtitle: string;
  icon: string;
  onPress: () => void;
  primary?: boolean;
};

function RoleButton({ title, subtitle, icon, onPress, primary = false }: RoleButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.roleButton,
        primary ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.pressed,
      ]}>
      <Text style={styles.roleIcon} accessibilityElementsHidden>
        {icon}
      </Text>
      <View style={styles.roleCopy}>
        <Text style={[styles.roleTitle, primary && styles.primaryButtonText]}>{title}</Text>
        <Text style={[styles.roleSubtitle, primary && styles.primaryButtonSubtext]}>{subtitle}</Text>
      </View>
      <Text style={[styles.chevron, primary && styles.primaryButtonText]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 20, paddingVertical: 18 },
  content: { width: '100%', maxWidth: 480 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 26 },
  brandMark: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandLeaf: { color: '#FFFFFF', fontSize: 27, lineHeight: 31 },
  brandName: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.4 },
  brandRegion: { color: colors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginTop: 2 },
  hero: { paddingTop: 8 },
  heroCompact: { paddingTop: 0 },
  heroBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 30,
    backgroundColor: colors.greenSoft,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  badgeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  heroBadgeText: { color: colors.greenDark, fontSize: 9, fontWeight: '800', letterSpacing: 0.9 },
  headline: { color: colors.text, fontSize: 43, lineHeight: 47, fontWeight: '800', letterSpacing: -1.8, marginTop: 18 },
  headlineCompact: { fontSize: 39, lineHeight: 43 },
  tagline: { color: colors.green, fontSize: 16, fontWeight: '700', marginTop: 10 },
  description: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 9, maxWidth: 440 },
  illustration: {
    height: 166,
    borderRadius: 24,
    marginTop: 20,
    overflow: 'hidden',
    backgroundColor: colors.blueSoft,
    justifyContent: 'flex-end',
  },
  sun: { position: 'absolute', width: 61, height: 61, borderRadius: 31, top: 20, right: 42, backgroundColor: '#F8D67C' },
  fieldBack: {
    position: 'absolute',
    width: '120%',
    height: 100,
    borderRadius: 100,
    left: '-10%',
    bottom: -52,
    backgroundColor: '#A9CF9C',
    transform: [{ rotate: '-4deg' }],
  },
  fieldFront: {
    position: 'absolute',
    width: '120%',
    height: 82,
    borderRadius: 100,
    right: '-18%',
    bottom: -60,
    backgroundColor: colors.green,
    transform: [{ rotate: '6deg' }],
  },
  produceCard: {
    position: 'absolute',
    left: 26,
    top: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: '#FFFFFFE8',
    shadowColor: '#294D38',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
  },
  produceEmoji: { fontSize: 29, marginHorizontal: 3 },
  coastPill: { position: 'absolute', right: 14, bottom: 17, backgroundColor: '#FFFFFFE8', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 20 },
  coastPillText: { color: colors.blue, fontSize: 10, fontWeight: '700' },
  actionCard: {
    backgroundColor: colors.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 17,
    marginTop: 18,
    shadowColor: '#294D38',
    shadowOpacity: 0.045,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 1,
  },
  actionTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  actionSubtitle: { color: colors.muted, fontSize: 12, marginTop: 4, marginBottom: 13 },
  roleButton: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 15,
    paddingHorizontal: 13,
    paddingVertical: 10,
    marginTop: 8,
  },
  pressed: { opacity: 0.78 },
  primaryButton: { backgroundColor: colors.green },
  secondaryButton: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  roleIcon: { fontSize: 23, marginRight: 11 },
  roleCopy: { flex: 1 },
  roleTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  roleSubtitle: { color: colors.muted, fontSize: 11, marginTop: 3 },
  primaryButtonText: { color: '#FFFFFF' },
  primaryButtonSubtext: { color: '#E5F2E8' },
  chevron: { color: colors.green, fontSize: 25, lineHeight: 28, marginLeft: 8 },
  footerNote: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: 15 },
});
