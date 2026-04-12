import React, { useState } from 'react';
import { View, Text, Alert, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/auth/supabase';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResetPassword = async () => {
    setError(null);

    // Validate password length
    if (password.length < 8) {
      Alert.alert('Password too short', 'Password must be at least 8 characters');
      return;
    }

    // Validate passwords match
    if (password !== confirmPassword) {
      Alert.alert('Passwords do not match', 'Please ensure both password fields are identical');
      return;
    }

    setIsLoading(true);
    try {
      await supabase.auth.updateUser({ password });

      // Clear fields
      setPassword('');
      setConfirmPassword('');

      // Show success alert and sign out
      Alert.alert(
        'Password updated',
        'Your password has been changed. Please sign in.',
        [
          {
            text: 'OK',
            onPress: () => {
              supabase.auth.signOut().catch(() => {});
              router.replace('/(auth)/login');
            },
          },
        ]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reset password';
      Alert.alert('Error', message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 justify-center px-6">
        <View className="mb-8">
          <Text className="text-heading-lg font-bold text-stone-900 mb-2">
            Set new password
          </Text>
          <Text className="text-body text-stone-600">
            Enter your new password below.
          </Text>
        </View>

        <View className="gap-4 mb-6">
          <TextInputField
            label="New password"
            required
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setError(null);
            }}
            placeholder="At least 8 characters"
            autoCapitalize="none"
            autoComplete="new-password"
            secureTextEntry
            editable={!isLoading}
          />
          <TextInputField
            label="Confirm password"
            required
            value={confirmPassword}
            onChangeText={(text) => {
              setConfirmPassword(text);
              setError(null);
            }}
            placeholder="At least 8 characters"
            autoCapitalize="none"
            autoComplete="new-password"
            secureTextEntry
            editable={!isLoading}
          />
        </View>

        <View className="gap-3">
          <Button
            onPress={() => {
              handleResetPassword().catch(() => {});
            }}
            loading={isLoading}
            variant="primary"
          >
            Update password
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
