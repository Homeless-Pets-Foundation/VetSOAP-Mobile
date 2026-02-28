import React from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LogOut, User, ChevronLeft } from 'lucide-react-native';
import { useAuth } from '../../src/hooks/useAuth';
import Constants from 'expo-constants';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <View style={{ padding: 20 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}>
          <Pressable onPress={() => router.back()} style={{ marginRight: 12 }}>
            <ChevronLeft color="#1c1917" size={24} />
          </Pressable>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#1c1917' }}>Settings</Text>
        </View>

        {/* User Info */}
        <View
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 20,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: '#0d8775',
                justifyContent: 'center',
                alignItems: 'center',
                marginRight: 14,
              }}
            >
              <User color="#fff" size={24} />
            </View>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917' }}>
                {user?.fullName || 'User'}
              </Text>
              <Text style={{ fontSize: 13, color: '#78716c', marginTop: 2 }}>
                {user?.email || ''}
              </Text>
              {user?.role && (
                <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2, textTransform: 'capitalize' }}>
                  {user.role}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Sign Out */}
        <Pressable
          onPress={handleSignOut}
          style={({ pressed }) => ({
            backgroundColor: pressed ? '#fee2e2' : '#fff',
            borderRadius: 14,
            padding: 16,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 16,
          })}
        >
          <LogOut color="#ef4444" size={20} style={{ marginRight: 12 }} />
          <Text style={{ fontSize: 15, fontWeight: '500', color: '#ef4444' }}>Sign Out</Text>
        </Pressable>

        {/* App Info */}
        <View style={{ alignItems: 'center', marginTop: 40 }}>
          <Text style={{ fontSize: 12, color: '#a8a29e' }}>
            VetSOAP Mobile v{Constants.expoConfig?.version || '1.0.0'}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}
