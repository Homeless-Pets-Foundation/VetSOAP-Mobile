import React, { useState, useRef, useCallback } from 'react';
import { View, Text, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeInUp, FadeIn } from 'react-native-reanimated';
import { AlertCircle } from 'lucide-react-native';
import { useAuth } from '../../src/hooks/useAuth';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { emailSchema, passwordSchema } from '../../src/lib/validation';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60_000; // 1 minute

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const failedAttemptsRef = useRef(0);
  const lockoutUntilRef = useRef<number>(0);

  const handleSignIn = useCallback(async () => {
    // Check lockout
    if (lockoutUntilRef.current > Date.now()) {
      const remaining = Math.ceil((lockoutUntilRef.current - Date.now()) / 1000);
      setError(`Too many failed attempts. Please try again in ${remaining}s.`);
      return;
    }

    // Validate email format
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      setError(emailResult.error.issues[0].message);
      return;
    }

    // Validate password length
    const passwordResult = passwordSchema.safeParse(password);
    if (!passwordResult.success) {
      setError(passwordResult.error.issues[0].message);
      return;
    }

    setError(null);
    setIsLoading(true);

    const result = await signIn(emailResult.data, password);
    if (result.error) {
      failedAttemptsRef.current += 1;
      if (failedAttemptsRef.current >= MAX_LOGIN_ATTEMPTS) {
        lockoutUntilRef.current = Date.now() + LOCKOUT_DURATION_MS;
        failedAttemptsRef.current = 0;
        setError('Too many failed attempts. Please try again in 60s.');
      } else {
        setError(result.error);
      }
    } else {
      failedAttemptsRef.current = 0;
    }

    setIsLoading(false);
  }, [email, password, signIn]);

  return (
    <SafeAreaView className="screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center px-6"
      >
        {/* Logo / Brand */}
        <Animated.View entering={FadeInDown.duration(500)} className="items-center mb-10">
          <View className="w-16 h-16 rounded-2xl bg-brand-500 justify-center items-center mb-4 shadow-card-md">
            <Text className="text-[28px] text-white font-bold">V</Text>
          </View>
          <Text
            className="text-display font-bold text-stone-900"
            accessibilityRole="header"
          >
            VetSOAP Mobile
          </Text>
          <Text className="text-body text-stone-500 mt-1">
            Sign in to your account
          </Text>
        </Animated.View>

        {/* Form */}
        <Animated.View
          entering={FadeInUp.duration(500).delay(200)}
          className="card p-6"
        >
          {error && (
            <Animated.View
              entering={FadeIn.duration(200)}
              className="bg-danger-100 p-3 rounded-input mb-4 flex-row items-center gap-2"
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              <AlertCircle color="#b91c1c" size={16} />
              <Text className="text-body-sm text-danger-700 flex-1">{error}</Text>
            </Animated.View>
          )}

          <TextInputField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <TextInputField
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
            secureTextEntry
          />

          <View className="mt-2">
            <Button
              variant="primary"
              size="lg"
              onPress={handleSignIn}
              loading={isLoading}
              accessibilityLabel="Sign in to your account"
            >
              Sign In
            </Button>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
