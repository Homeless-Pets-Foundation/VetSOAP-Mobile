import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { AlertTriangle, ChevronLeft, Trash2 } from 'lucide-react-native';
import { accountApi } from '../../src/api/account';
import { ApiError } from '../../src/api/client';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { IconButton } from '../../src/components/ui/IconButton';
import { Button } from '../../src/components/ui/Button';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { DELETE_ACCOUNT_COPY } from '../../src/constants/strings';
import { useAuth } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { trackEvent } from '../../src/lib/analytics';
import { countUnsentRecordings } from '../../src/lib/localRecordings';

function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { iconMd, iconSm } = useResponsive();
  const colors = useThemeColors();
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [deletionAccepted, setDeletionAccepted] = useState(false);

  const signOutAfterDeletion = useCallback(() => {
    setIsRequesting(true);
    signOut({ recoveryMode: 'best_effort' }).catch(() => {
      setIsRequesting(false);
      Alert.alert(DELETE_ACCOUNT_COPY.signOutFailedTitle, DELETE_ACCOUNT_COPY.signOutFailedBody);
    });
  }, [signOut]);

  const submitDeletionRequest = useCallback(async () => {
    let accepted = false;
    setIsRequesting(true);
    try {
      const response = await accountApi.requestDeletion('DELETE');
      trackEvent({ name: 'account_deletion_requested', props: {} });
      const purgeDate = formatDate(response.scheduledPurgeAt);
      accepted = true;
      setDeletionAccepted(true);
      Alert.alert(
        DELETE_ACCOUNT_COPY.deletionRequestedTitle,
        purgeDate
          ? DELETE_ACCOUNT_COPY.deletionScheduled(purgeDate)
          : DELETE_ACCOUNT_COPY.deletionReceived,
        [{ text: DELETE_ACCOUNT_COPY.signOut, onPress: signOutAfterDeletion }],
        { cancelable: false }
      );
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === 'OWNER_TRANSFER_REQUIRED') {
        Alert.alert(DELETE_ACCOUNT_COPY.ownerTransferRequiredTitle, DELETE_ACCOUNT_COPY.ownerTransferRequired);
        return;
      }
      const message =
        requestError instanceof Error
          ? requestError.message
          : DELETE_ACCOUNT_COPY.requestFailedBody;
      Alert.alert(DELETE_ACCOUNT_COPY.requestFailedTitle, message);
    } finally {
      if (!accepted) {
        setIsRequesting(false);
      }
    }
  }, [signOutAfterDeletion]);

  const handleRequestDeletion = useCallback(() => {
    if (deletionAccepted) {
      signOutAfterDeletion();
      return;
    }
    if (confirmation.trim() !== 'DELETE') {
      setError(DELETE_ACCOUNT_COPY.typeDeleteRequired);
      return;
    }
    setError(null);
    setIsRequesting(true);
    countUnsentRecordings()
      .then((unsentCount) => {
        if (unsentCount > 0) {
          setIsRequesting(false);
          Alert.alert(
            DELETE_ACCOUNT_COPY.unsentTitle,
            DELETE_ACCOUNT_COPY.unsentBody(unsentCount),
            [
              { text: DELETE_ACCOUNT_COPY.cancel, style: 'cancel' },
              {
                text: DELETE_ACCOUNT_COPY.continue,
                style: 'destructive',
                onPress: () => {
                  submitDeletionRequest().catch(() => {});
                },
              },
            ]
          );
          return;
        }
        submitDeletionRequest().catch(() => {});
      })
      .catch(() => {
        submitDeletionRequest().catch(() => {});
      });
  }, [confirmation, deletionAccepted, signOutAfterDeletion, submitDeletionRequest]);

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="px-5 pt-5">
          <View className="flex-row items-center mb-6">
            <IconButton
              icon={<ChevronLeft color={colors.contentPrimary} size={iconMd} />}
              label={DELETE_ACCOUNT_COPY.goBack}
              onPress={() => router.back()}
              className="mr-3"
            />
            <Text className="text-display font-bold text-content-primary" accessibilityRole="header">
              {DELETE_ACCOUNT_COPY.title}
            </Text>
          </View>
        </View>

        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 28 }}
          keyboardShouldPersistTaps="handled"
        >
          <Card className="p-5 mb-4 border border-status-danger">
            <View className="flex-row items-center mb-4">
              <View className="w-10 h-10 rounded-full bg-status-danger justify-center items-center mr-3">
                <AlertTriangle color={colors.statusDangerFg} size={iconSm} />
              </View>
              <View className="flex-1">
                <Text className="text-body-lg font-semibold text-content-primary">
                  {DELETE_ACCOUNT_COPY.permanentDeletion}
                </Text>
                <Text className="text-body-sm text-content-secondary mt-0.5">
                  {DELETE_ACCOUNT_COPY.permanentDeletionBody}
                </Text>
              </View>
            </View>
            <Text className="text-body text-content-body mb-4">
              {DELETE_ACCOUNT_COPY.localUnsentBody}
            </Text>
            <TextInputField
              label={DELETE_ACCOUNT_COPY.typeDelete}
              value={confirmation}
              onChangeText={setConfirmation}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!deletionAccepted}
              error={error ?? undefined}
              maxLength={12}
            />
            <Button
              variant="danger"
              onPress={handleRequestDeletion}
              loading={isRequesting}
              icon={<Trash2 color={colors.white} size={iconSm} />}
              className="mt-2"
            >
              {deletionAccepted ? DELETE_ACCOUNT_COPY.signOut : DELETE_ACCOUNT_COPY.requestDeletion}
            </Button>
          </Card>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
