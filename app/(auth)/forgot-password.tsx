import React, { useEffect, useRef, useState } from 'react';
import { View, Text, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { AlertCircle } from 'lucide-react-native';
import { supabase } from '../../src/auth/supabase';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { emailSchema } from '../../src/lib/validation';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { PASSWORD_RESET_COPY } from '../../src/constants/strings';

const RESEND_COOLDOWN_SECONDS = 30;

function getPasswordResetRedirect(): string {
  const configuredScheme = Constants.expoConfig?.scheme;
  const scheme = Array.isArray(configuredScheme) ? configuredScheme[0] : configuredScheme;
  return `${scheme || 'captivet'}://reset-password`;
}

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const startResendCooldown = () => {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSendResetLink = async () => {
    setError(null);
    setSendError(null);

    // Validate email format
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      setError(emailResult.error.issues[0]?.message ?? 'Invalid email');
      return;
    }

    setIsLoading(true);
    try {
      // supabase-js v2 returns { error } rather than throwing — ignoring it
      // showed the success screen even when the send failed (rate limit,
      // network down).
      const { error: sendErr } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: getPasswordResetRedirect(),
      });
      if (sendErr) {
        const message =
          sendErr.status === 429
            ? PASSWORD_RESET_COPY.sendRateLimited
            : PASSWORD_RESET_COPY.sendFailed;
        if (emailSent) {
          setSendError(message);
        } else {
          setError(message);
        }
        return;
      }
      setEmailSent(true);
      setSendError(null);
      startResendCooldown();
    } catch {
      if (emailSent) {
        setSendError(PASSWORD_RESET_COPY.sendFailed);
      } else {
        setError(PASSWORD_RESET_COPY.sendFailed);
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (emailSent) {
    return (
      <SafeAreaView className="flex-1 bg-surface-raised">
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="px-6">
            <View className="items-center">
              <Text className="text-heading-lg font-bold text-content-primary mb-3">
                Check your email
              </Text>
              <Text className="text-body text-content-secondary text-center mb-6">
                We&apos;ve sent a password reset link to:
              </Text>
              <Text className="text-body font-semibold text-brand-500 mb-8">
                {email}
              </Text>
              <Text className="text-body-sm text-content-tertiary text-center mb-8">
                {PASSWORD_RESET_COPY.tapLink}
              </Text>
            </View>

            {sendError && (
              <View
                className="flex-row items-center gap-2 rounded-input bg-status-danger p-3 mb-4"
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                <AlertCircle color={colors.statusDangerFg} size={16} />
                <Text className="text-body-sm text-status-danger flex-1">{sendError}</Text>
              </View>
            )}

            <View className="gap-3">
              <Button
                onPress={() => {
                  handleSendResetLink().catch(() => {});
                }}
                variant="secondary"
                loading={isLoading}
                disabled={resendCooldown > 0}
              >
                {resendCooldown > 0
                  ? PASSWORD_RESET_COPY.resendCooldown(resendCooldown)
                  : PASSWORD_RESET_COPY.resend}
              </Button>
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
        </ScrollView>
      </SafeAreaView>
    );
  }

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
                Reset password
              </Text>
              <Text className="text-body text-content-secondary">
                Enter your email address and we&apos;ll send you a link to reset your password.
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
                returnKeyType="send"
                onSubmitEditing={() => {
                  handleSendResetLink().catch(() => {});
                }}
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
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
