import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ScreenFrame, MarketColors } from '@/components/marketplace-ui';
import { ConsumerAuthError, endConsumerInAppCall, joinConsumerInAppCall } from '@/features/consumer-auth/client';
import { endFarmerInAppCall, FarmerAuthError, joinFarmerInAppCall } from '@/features/farmer-auth/client';

type CallRole = 'farmer' | 'consumer';
type CallCredentials = { serverUrl: string; participantToken: string };
type LiveKitRoomComponent = typeof import('@livekit/react-native').LiveKitRoom;

export default function InAppCallScreen() {
  const { sessionId, role } = useLocalSearchParams<{ sessionId?: string; role?: string }>();
  const callRole: CallRole = role === 'farmer' ? 'farmer' : 'consumer';
  const [credentials, setCredentials] = useState<CallCredentials | null>(null);
  const [LiveKitRoom, setLiveKitRoom] = useState<LiveKitRoomComponent | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(!sessionId || Platform.OS === 'web');
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    let active = true;
    if (!sessionId || Platform.OS === 'web') return () => { active = false; };
    void import('@livekit/react-native').then(({ LiveKitRoom: Room, registerGlobals }) => {
      if (!active) return;
      registerGlobals();
      setLiveKitRoom(() => Room);
    }).catch(() => { if (active) setError(true); });
    const join = callRole === 'farmer' ? joinFarmerInAppCall(sessionId) : joinConsumerInAppCall(sessionId);
    void join.then((reply) => {
      if (active) setCredentials({ serverUrl: reply.serverUrl, participantToken: reply.participantToken });
    }).catch((reason) => {
      if (!active) return;
      if (reason instanceof FarmerAuthError && reason.code === 'unauthorized') router.replace('/auth/farmer');
      else if (reason instanceof ConsumerAuthError && reason.code === 'unauthorized') router.replace('/auth/consumer/login');
      else setError(true);
    });
    return () => { active = false; };
  }, [callRole, sessionId]);

  const hangUp = async () => {
    if (!sessionId || ending) return;
    setEnding(true);
    try {
      if (callRole === 'farmer') await endFarmerInAppCall(sessionId);
      else await endConsumerInAppCall(sessionId);
    } catch { /* Local disconnect still ends this device's call. */ }
    setCredentials(null);
    router.replace(callRole === 'farmer' ? '/farmer/requests' : '/consumer');
  };

  return <ScreenFrame><View style={styles.page}>
    <Text style={styles.title}>Karavali Fresh call</Text>
    {error ? <Text accessibilityRole="alert" style={styles.body}>This call is unavailable. Return to the request and try again.</Text> : null}
    {!error && !credentials ? <><ActivityIndicator color={MarketColors.green} /><Text style={styles.body}>Joining your private call…</Text></> : null}
    {credentials && LiveKitRoom ? <LiveKitRoom
      serverUrl={credentials.serverUrl}
      token={credentials.participantToken}
      connect
      audio
      onConnected={() => setConnected(true)}
      onDisconnected={() => setConnected(false)}
      onError={() => { setError(true); setCredentials(null); }}
    ><Text style={styles.body}>{connected ? 'You are in the call. The other person can join from their notification.' : 'Connecting securely…'}</Text></LiveKitRoom> : credentials ? <ActivityIndicator color={MarketColors.green} /> : null}
    <Pressable accessibilityRole="button" disabled={ending} onPress={() => void hangUp()} style={styles.hangup}>
      <Text style={styles.hangupText}>{ending ? 'Ending…' : 'End call'}</Text>
    </Pressable>
  </View></ScreenFrame>;
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, padding: 24 },
  title: { color: MarketColors.text, fontSize: 24, fontWeight: '800' },
  body: { color: MarketColors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  hangup: { minHeight: 50, minWidth: 180, borderRadius: 14, backgroundColor: '#B42318', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  hangupText: { color: '#fff', fontWeight: '800', fontSize: 16 },
});
