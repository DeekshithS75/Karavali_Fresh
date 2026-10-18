import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const colors = {
  green: '#287A49',
  greenSoft: '#E8F3E8',
  blue: '#287D9B',
  background: '#F8F8F2',
  card: '#FFFFFF',
  text: '#24312B',
  muted: '#66746C',
  border: '#E5EAE3',
};

type RoleHomeProps = {
  role: 'Farmer' | 'Consumer';
  greeting: string;
  description: string;
  icon: string;
};

export function RoleHome({ role, greeting, description, icon }: RoleHomeProps) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandLeaf}>❧</Text>
            </View>
            <Text style={styles.brandName}>Karavali Fresh</Text>
          </View>

          <View style={styles.welcomeCard}>
            <View style={styles.roleIconWrap}>
              <Text style={styles.roleIcon}>{icon}</Text>
            </View>
            <Text style={styles.eyebrow}>{role.toUpperCase()} SPACE</Text>
            <Text style={styles.title}>{greeting}</Text>
            <Text style={styles.description}>{description}</Text>
          </View>

          <View style={styles.nextCard}>
            <Text style={styles.nextTitle}>A strong local food community starts here.</Text>
            <Text style={styles.nextDescription}>
              Your Karavali Fresh {role.toLowerCase()} experience is taking shape. More tools and
              details will be added here as the marketplace grows.
            </Text>
            <View style={styles.noteRow}>
              <Text style={styles.noteIcon}>🌊</Text>
              <Text style={styles.noteText}>Rooted in coastal Karnataka</Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
            <Text style={styles.backArrow}>‹</Text>
            <Text style={styles.backText}>Back to welcome</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 20, paddingVertical: 18 },
  content: { width: '100%', maxWidth: 480 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 30 },
  brandMark: { width: 42, height: 42, borderRadius: 15, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  brandLeaf: { color: '#FFFFFF', fontSize: 26, lineHeight: 30 },
  brandName: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.4 },
  welcomeCard: {
    backgroundColor: colors.greenSoft,
    borderRadius: 24,
    paddingHorizontal: 23,
    paddingVertical: 25,
    alignItems: 'flex-start',
  },
  roleIconWrap: { width: 58, height: 58, borderRadius: 20, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  roleIcon: { fontSize: 30 },
  eyebrow: { color: colors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  title: { color: colors.text, fontSize: 31, lineHeight: 37, fontWeight: '800', letterSpacing: -0.8, marginTop: 8 },
  description: { color: colors.muted, fontSize: 14, lineHeight: 22, marginTop: 9 },
  nextCard: { backgroundColor: colors.card, borderRadius: 20, borderWidth: 1, borderColor: colors.border, padding: 20, marginTop: 16 },
  nextTitle: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '800' },
  nextDescription: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 8 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  noteIcon: { fontSize: 16 },
  noteText: { color: colors.blue, fontSize: 12, fontWeight: '700' },
  backButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 18, gap: 7 },
  backArrow: { color: colors.green, fontSize: 25, lineHeight: 28 },
  backText: { color: colors.green, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
