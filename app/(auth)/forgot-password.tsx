import React, { useState } from 'react';
import { View, Text, Alert, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/auth/supabase';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { emailSchema } from '../../src/lib/validation';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);

  const handleSendResetLink = async () => {
    setError(null);

    // Validate email format
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      setError(emailResult.error.issues[0]?.message ?? 'Invalid email');
      return;
    }

    setIsLoading(true);
    try {
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'captivet://reset-password',
      });
      setEmailSent(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send reset link';
      Alert.alert('Error', message);
    } finally {
      setIsLoading(false);
    }
  };

  if (emailSent) {
    return (
      <SafeAreaView className="flex-1 bg-white">
        <View className="flex-1 justify-center px-6">
          <View className="items-center">
            <Text className="text-heading-lg font-bold text-stone-900 mb-3">
              Check your email
            </Text>
            <Text className="text-body text-stone-600 text-center mb-6">
              We've sent a password reset link to:
            </Text>
            <Text className="text-body font-semibold text-brand-500 mb-8">
              {email}
            </Text>
            <Text className="text-body-sm text-stone-500 text-center mb-8">
              Click the link in the email to reset your password. If you don't see the email, check your spam folder.
            </Text>
          </View>

          <View className="gap-3">
            <Button
              onPress={() => {
                router.back();
              }}
              variant="primary"
            >
              Back to Login
            </Button>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 justify-center px-6">
        <View className="mb-8">
          <Text className="text-heading-lg font-bold text-stone-900 mb-2">
            Reset password
          </Text>
          <Text className="text-body text-stone-600">
            Enter your email address and we'll send you a link to reset your password.
          </Text>
        </View>

        <View className="gap-4 mb-6">
          <TextInputField
            label="Email"
            required
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setError(null);
            }}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            editable={!isLoading}
            error={error ?? undefined}
          />
        </View>

        <View className="gap-3">
          <Button
            onPress={() => {
              handleSendResetLink().catch(() => {});
            }}
            loading={isLoading}
            variant="primary"
          >
            Send reset link
          </Button>
          <Button
            onPress={() => {
              router.back();
            }}
            variant="secondary"
            disabled={isLoading}
          >
            Cancel
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}
