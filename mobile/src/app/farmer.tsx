import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  BrandHeader,
  EmptyState,
  MarketColors,
  ScreenFrame,
  SectionHeading,
} from '@/components/marketplace-ui';

export default function FarmerHomeScreen() {
  return (
    <ScreenFrame>
      <BrandHeader role="Farmer" />

      <View style={styles.welcomePanel}>
        <Text style={styles.eyebrow}>YOUR FARMER SPACE</Text>
        <Text style={styles.greeting}>Welcome, farmer 🌱</Text>
        <Text style={styles.intro}>
          Keep your harvest close to home. Your listings and buyer updates will appear here.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          disabled
          style={styles.addButton}>
          <Text style={styles.addIcon}>＋</Text>
          <Text style={styles.addButtonText}>Add Produce</Text>
          <Text style={styles.comingSoon}>Coming soon</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <SectionHeading title="My Listings" detail="Your produce shared with the community" />
        <EmptyState
          icon="🌾"
          title="No produce listed yet"
          message="When you add produce, your active listings will show up here."
        />
      </View>

      <View style={styles.section}>
        <SectionHeading title="Buyer Requests" detail="Messages and requests from local buyers" />
        <EmptyState
          icon="💬"
          title="No buyer requests yet"
          message="Requests from interested buyers will appear here when available."
          tone="blue"
        />
      </View>

      <View style={styles.section}>
        <SectionHeading title="Market Prices" detail="A helpful view of local market rates" />
        <EmptyState
          icon="📊"
          title="Price information is not available yet"
          message="We’ll show market price updates here once verified local data is available."
          tone="blue"
        />
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  welcomePanel: {
    backgroundColor: MarketColors.greenSoft,
    borderRadius: 22,
    padding: 20,
    marginBottom: 24,
  },
  eyebrow: { color: MarketColors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  greeting: { color: MarketColors.text, fontSize: 25, lineHeight: 31, fontWeight: '800', marginTop: 8 },
  intro: { color: MarketColors.muted, fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 540 },
  addButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: MarketColors.green,
    borderRadius: 13,
    paddingHorizontal: 15,
    marginTop: 17,
    opacity: 0.82,
  },
  addIcon: { color: '#FFFFFF', fontSize: 20, marginRight: 7 },
  addButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  comingSoon: { color: '#E5F2E8', fontSize: 10, fontWeight: '600', marginLeft: 10 },
  section: { marginBottom: 22 },
});
