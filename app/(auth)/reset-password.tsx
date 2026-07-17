import React, { useState } from 'react';
import { View, Text, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { AlertCircle, Eye, EyeOff } from 'lucide-react-native';
import { supabase } from '../../src/auth/supabase';
import { useAuthReadiness } from '../../src/hooks/useAuth';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { PASSWORD_RESET_COPY } from '../../src/constants/strings';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { clearPasswordRecovery } = useAuthReadiness();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const leaveToLogin = () => {
    // The PASSWORD_RECOVERY session is authenticated, so clearing the flag
    // first would let the (auth) layout redirect to '/' (a half-auth spinner
    // — recovery deliberately skips fetchUser). Sign the recovery session
    // out FIRST, then clear the flag and land on Login explicitly (the deep
    // link may have an empty back stack, so no router.back()).
    setIsLoading(true);
    supabase.auth
      .signOut()
      .catch(() => {})
      .finally(() => {
        clearPasswordRecovery();
        router.replace('/(auth)/login');
      });
  };

  const handleResetPassword = async () => {
    setPasswordError(null);
    setConfirmError(null);
    setUpdateError(null);

    if (password.length < 8) {
      setPasswordError(PASSWORD_RESET_COPY.passwordTooShort);
      return;
    }
    if (password !== confirmPassword) {
      setConfirmError(PASSWORD_RESET_COPY.passwordMismatch);
      return;
    }

    setIsLoading(true);
    try {
      // supabase-js v2 returns { error } rather than throwing — ignoring it
      // showed "Password updated" for a password that was never set (policy
      // reject, expired recovery session).
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setUpdateError(PASSWORD_RESET_COPY.updateFailed);
        return;
      }

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
              clearPasswordRecovery();
              supabase.auth.signOut()
                .catch(() => {})
                .finally(() => {
                  router.replace('/(auth)/login');
                });
            },
          },
        ]
      );
    } catch {
      setUpdateError(PASSWORD_RESET_COPY.updateFailed);
    } finally {
      setIsLoading(false);
    }
  };

  const eyeToggle = (
    <Pressable
      onPress={() => setShowPassword((prev) => !prev)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
    >
      {showPassword ? (
        <EyeOff color={colors.contentTertiary} size={20} />
      ) : (
        <Eye color={colors.contentTertiary} size={20} />
      )}
    </Pressable>
  );

  return (
    <SafeAreaView className="flex-1 bg-surface-raised">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="px-6 py-6">
            <View className="mb-8">
              <Text className="text-heading-lg font-bold text-content-primary mb-2">
                Set new password
              </Text>
              <Text className="text-body text-content-secondary">
                Enter your new password below.
              </Text>
            </View>

            {updateError && (
              <View
                className="flex-row items-center gap-2 rounded-input bg-status-danger p-3 mb-4"
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                <AlertCircle color={colors.statusDangerFg} size={16} />
                <Text className="text-body-sm text-status-danger flex-1">{updateError}</Text>
              </View>
            )}

            <View className="gap-4 mb-6">
              <TextInputField
                label="New password"
                required
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  setPasswordError(null);
                  setUpdateError(null);
                }}
                placeholder="At least 8 characters"
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                secureTextEntry={!showPassword}
                editable={!isLoading}
                error={passwordError ?? undefined}
                rightAccessory={eyeToggle}
              />
              <TextInputField
                label="Confirm password"
                required
                value={confirmPassword}
                onChangeText={(text) => {
                  setConfirmPassword(text);
                  setConfirmError(null);
                  setUpdateError(null);
                }}
                placeholder="At least 8 characters"
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                secureTextEntry={!showPassword}
                returnKeyType="go"
                onSubmitEditing={() => {
                  handleResetPassword().catch(() => {});
                }}
                editable={!isLoading}
                error={confirmError ?? undefined}
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
                onPress={leaveToLogin}
                variant="secondary"
                disabled={isLoading}
              >
                Cancel
              </Button>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
