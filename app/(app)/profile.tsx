import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, Lock, Save, UserRound } from 'lucide-react-native';
import { accountApi } from '../../src/api/account';
import { supabase } from '../../src/auth/supabase';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { IconButton } from '../../src/components/ui/IconButton';
import { Button } from '../../src/components/ui/Button';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { useAuthReadiness, useAuthUser } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { trackEvent } from '../../src/lib/analytics';
import { saveProfileCache } from '../../src/lib/userProfileCache';
import { PROFILE_COPY } from '../../src/constants/strings';

const PASSWORD_UPDATE_TIMEOUT_MS = 15_000;

function withRejectingTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function authPasswordMessage(message?: string): string {
  if (!message) return PROFILE_COPY.passwordUpdateFailed;
  if (message === 'password_update_timeout') {
    return PROFILE_COPY.passwordUpdateTimeout;
  }
  if (message.toLowerCase().includes('different')) return message;
  if (message.toLowerCase().includes('weak') || message.toLowerCase().includes('short')) {
    return PROFILE_COPY.passwordWeak;
  }
  return PROFILE_COPY.passwordUpdateFailed;
}

export default function ProfileScreen() {
  const router = useRouter();
  const user = useAuthUser();
  const { retryFetchUser } = useAuthReadiness();
  const { iconMd, iconSm } = useResponsive();
  const colors = useThemeColors();

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState(false);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  useEffect(() => {
    setFullName(user?.fullName ?? '');
  }, [user?.fullName]);

  const handleSaveName = useCallback(async () => {
    const trimmed = fullName.trim();
    if (!trimmed) {
      setNameError(PROFILE_COPY.nameRequired);
      return;
    }
    if (trimmed.length > 120) {
      setNameError(PROFILE_COPY.nameTooLong);
      return;
    }
    setNameError(null);
    setIsSavingName(true);
    try {
      const response = await accountApi.updateMe({ fullName: trimmed });
      trackEvent({ name: 'profile_updated', props: { fields: 'full_name' } });
      saveProfileCache(response.user).catch(() => {});
      Alert.alert(PROFILE_COPY.profileUpdatedTitle, PROFILE_COPY.profileUpdatedBody);
      retryFetchUser().catch(() => {});
    } catch {
      Alert.alert(PROFILE_COPY.saveFailedTitle, PROFILE_COPY.saveFailedBody);
    } finally {
      setIsSavingName(false);
    }
  }, [fullName, retryFetchUser]);

  const handleChangePassword = useCallback(async () => {
    if (password.length < 8) {
      setPasswordError(PROFILE_COPY.passwordMinLength);
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError(PROFILE_COPY.passwordsMismatch);
      return;
    }
    setPasswordError(null);
    setIsSavingPassword(true);
    try {
      const { error } = await withRejectingTimeout(
        supabase.auth.updateUser({ password }),
        PASSWORD_UPDATE_TIMEOUT_MS,
        'password_update_timeout'
      );
      if (error) {
        throw error;
      }
      setPassword('');
      setConfirmPassword('');
      trackEvent({ name: 'profile_updated', props: { fields: 'password' } });
      Alert.alert(PROFILE_COPY.passwordUpdatedTitle, PROFILE_COPY.passwordUpdatedBody);
    } catch (error) {
      Alert.alert(
        PROFILE_COPY.passwordUpdateFailedTitle,
        authPasswordMessage(error instanceof Error ? error.message : undefined)
      );
    } finally {
      setIsSavingPassword(false);
    }
  }, [confirmPassword, password]);

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="px-5 pt-5">
          <View className="flex-row items-center mb-6">
            <IconButton
              icon={<ChevronLeft color={colors.contentPrimary} size={iconMd} />}
              label={PROFILE_COPY.goBack}
              onPress={() => router.back()}
              className="mr-3"
            />
            <Text className="text-display font-bold text-content-primary" accessibilityRole="header">
              {PROFILE_COPY.title}
            </Text>
          </View>
        </View>

        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 28 }}
          keyboardShouldPersistTaps="handled"
        >
          <Card className="p-5 mb-4">
            <View className="flex-row items-center mb-4">
              <View className="w-10 h-10 rounded-full bg-brand-100 dark:bg-surface-sunken justify-center items-center mr-3">
                <UserRound color={colors.brand500} size={iconSm} />
              </View>
              <View className="flex-1">
                <Text className="text-body-lg font-semibold text-content-primary">{PROFILE_COPY.accountName}</Text>
                <Text className="text-body-sm text-content-tertiary" numberOfLines={1}>
                  {user?.email ?? ''}
                </Text>
              </View>
            </View>
            <TextInputField
              label={PROFILE_COPY.fullName}
              value={fullName}
              onChangeText={setFullName}
              autoCapitalize="words"
              textContentType="name"
              error={nameError ?? undefined}
              returnKeyType="done"
            />
            <Button
              onPress={handleSaveName}
              loading={isSavingName}
              icon={<Save color={colors.contentOnBrand} size={iconSm} />}
              className="mt-2"
            >
              {PROFILE_COPY.saveProfile}
            </Button>
          </Card>

          <Card className="p-5">
            <View className="flex-row items-center mb-4">
              <View className="w-10 h-10 rounded-full bg-brand-100 dark:bg-surface-sunken justify-center items-center mr-3">
                <Lock color={colors.brand500} size={iconSm} />
              </View>
              <View className="flex-1">
                <Text className="text-body-lg font-semibold text-content-primary">{PROFILE_COPY.password}</Text>
                <Text className="text-body-sm text-content-tertiary">{PROFILE_COPY.passwordSubtitle}</Text>
              </View>
            </View>
            <TextInputField
              label={PROFILE_COPY.newPassword}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              autoCapitalize="none"
              autoCorrect={false}
              error={passwordError ?? undefined}
            />
            <TextInputField
              label={PROFILE_COPY.confirmPassword}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              textContentType="newPassword"
              autoCapitalize="none"
              autoCorrect={false}
              containerClassName="mt-2"
            />
            <Button
              onPress={handleChangePassword}
              loading={isSavingPassword}
              icon={<Lock color={colors.contentOnBrand} size={iconSm} />}
              className="mt-2"
            >
              {PROFILE_COPY.updatePassword}
            </Button>
          </Card>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
