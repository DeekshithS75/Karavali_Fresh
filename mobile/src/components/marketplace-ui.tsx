import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const MarketColors = {
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

type ScreenFrameProps = { children: ReactNode };

export function ScreenFrame({ children }: ScreenFrameProps) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

type BrandHeaderProps = { role: 'Farmer' | 'Consumer' };

export function BrandHeader({ role }: BrandHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <Text style={styles.brandLeaf} accessibilityElementsHidden>
            ❧
          </Text>
        </View>
        <View>
          <Text style={styles.brandName}>Karavali Fresh</Text>
          <Text style={styles.brandRole}>{role.toUpperCase()} HOME</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Return to welcome screen"
        onPress={() => router.replace('/')}
        style={({ pressed }) => [styles.welcomeLink, pressed && styles.pressed]}>
        <Text style={styles.welcomeLinkText}>‹ Welcome</Text>
      </Pressable>
    </View>
  );
}

type SectionHeadingProps = { title: string; detail?: string };

export function SectionHeading({ title, detail }: SectionHeadingProps) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {detail ? <Text style={styles.sectionDetail}>{detail}</Text> : null}
    </View>
  );
}

type EmptyStateProps = {
  icon: string;
  title: string;
  message: string;
  tone?: 'green' | 'blue';
};

export function EmptyState({ icon, title, message, tone = 'green' }: EmptyStateProps) {
  return (
    <View style={styles.emptyCard}>
      <View style={[styles.emptyIconWrap, tone === 'blue' && styles.emptyIconBlue]}>
        <Text style={styles.emptyIcon} accessibilityElementsHidden>
          {icon}
        </Text>
      </View>
      <View style={styles.emptyCopy}>
        <Text style={styles.emptyTitle}>{title}</Text>
        <Text style={styles.emptyMessage}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: MarketColors.background },
  scrollContent: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 32 },
  content: { width: '100%', maxWidth: 680 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 43, height: 43, borderRadius: 15, backgroundColor: MarketColors.green, alignItems: 'center', justifyContent: 'center' },
  brandLeaf: { color: '#FFFFFF', fontSize: 26, lineHeight: 30 },
  brandName: { color: MarketColors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.35 },
  brandRole: { color: MarketColors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.15, marginTop: 2 },
  welcomeLink: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 },
  welcomeLinkText: { color: MarketColors.green, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  sectionHeading: { marginBottom: 11 },
  sectionTitle: { color: MarketColors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  sectionDetail: { color: MarketColors.muted, fontSize: 12, marginTop: 3 },
  emptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    backgroundColor: MarketColors.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: MarketColors.border,
    padding: 15,
  },
  emptyIconWrap: { width: 43, height: 43, borderRadius: 15, backgroundColor: MarketColors.greenSoft, alignItems: 'center', justifyContent: 'center' },
  emptyIconBlue: { backgroundColor: MarketColors.blueSoft },
  emptyIcon: { fontSize: 21 },
  emptyCopy: { flex: 1 },
  emptyTitle: { color: MarketColors.text, fontSize: 13, fontWeight: '700' },
  emptyMessage: { color: MarketColors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
