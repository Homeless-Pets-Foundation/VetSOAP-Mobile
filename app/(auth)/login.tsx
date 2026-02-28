import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/hooks/useAuth';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSignIn = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password');
      return;
    }

    setError(null);
    setIsLoading(true);

    const result = await signIn(email.trim(), password);
    if (result.error) {
      setError(result.error);
    }

    setIsLoading(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24 }}
      >
        {/* Logo / Brand */}
        <View style={{ alignItems: 'center', marginBottom: 40 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              backgroundColor: '#0d8775',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <Text style={{ fontSize: 28, color: '#fff', fontWeight: '700' }}>V</Text>
          </View>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#1c1917' }}>
            VetSOAP Mobile
          </Text>
          <Text style={{ fontSize: 14, color: '#78716c', marginTop: 4 }}>
            Sign in to your account
          </Text>
        </View>

        {/* Form */}
        <View
          style={{
            backgroundColor: '#fff',
            borderRadius: 16,
            padding: 24,
            borderWidth: 1,
            borderColor: '#e7e5e4',
          }}
        >
          {error && (
            <View
              style={{
                backgroundColor: '#fee2e2',
                padding: 12,
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              <Text style={{ color: '#991b1b', fontSize: 13 }}>{error}</Text>
            </View>
          )}

          <View style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
              Email
            </Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor="#a8a29e"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                borderWidth: 1,
                borderColor: '#d6d3d1',
                borderRadius: 8,
                padding: 12,
                fontSize: 15,
                color: '#1c1917',
              }}
            />
          </View>

          <View style={{ marginBottom: 24 }}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
              Password
            </Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Enter your password"
              placeholderTextColor="#a8a29e"
              secureTextEntry
              style={{
                borderWidth: 1,
                borderColor: '#d6d3d1',
                borderRadius: 8,
                padding: 12,
                fontSize: 15,
                color: '#1c1917',
              }}
            />
          </View>

          <Pressable
            onPress={handleSignIn}
            disabled={isLoading}
            style={({ pressed }) => ({
              backgroundColor: pressed ? '#0bb89a' : '#0d8775',
              padding: 14,
              borderRadius: 10,
              alignItems: 'center',
              opacity: isLoading ? 0.7 : 1,
            })}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Sign In</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
