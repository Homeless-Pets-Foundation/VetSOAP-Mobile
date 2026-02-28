import React, { useState } from 'react';
import { View, Text, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeInUp, FadeIn } from 'react-native-reanimated';
import { AlertCircle } from 'lucide-react-native';
import { useAuth } from '../../src/hooks/useAuth';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';

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
