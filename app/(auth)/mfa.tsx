import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { AlertCircle, Copy, LogOut, RefreshCw, ShieldCheck } from 'lucide-react-native';
import { useAuthActions, useAuthMfa, useAuthReadiness } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { isSetupApprovalCodeError, mfaErrorMessage } from '../../src/auth/mfaPolicy';
import { copyWithAutoClear } from '../../src/lib/secureClipboard';
import { MFA_BOOTSTRAP_COPY } from '../../src/constants/strings';

type MfaMode = 'loading' | 'challenge' | 'enroll' | 'error';

interface PendingEnrollment {
  factorId: string;
  uri: string;
  secret: string;
}

export default function MfaScreen() {
  const router = useRouter();
  const { scale, iconSm, iconMd } = useResponsive();
  const colors = useThemeColors();
  const {
    isAuthenticated,
    pendingRecoveryDraftSlotId,
    consumePendingRecoveryDraftSlotId,
    retryFetchUser,
  } = useAuthReadiness();
  const { signOut } = useAuthActions();
  const {
    mfaRequired,
    mfaReturnPath,
    mfaReason,
    listMfaFactors,
    enrollMfaFactor,
    startMfaChallenge,
    verifyMfaChallenge,
    verifyMfaEnrollment,
    refreshMfaStatus,
    clearMfaChallenge,
  } = useAuthMfa();
  const [mode, setMode] = useState<MfaMode>('loading');
  const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [bootstrapCode, setBootstrapCode] = useState('');
  const [bootstrapCodeRequired, setBootstrapCodeRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [setupKeyCopied, setSetupKeyCopied] = useState(false);
  const autoBootstrapKeyRef = useRef<string | null>(null);

  const returnToApp = useCallback(() => {
    if (pendingRecoveryDraftSlotId) {
      const draftSlotId = consumePendingRecoveryDraftSlotId();
      if (draftSlotId) {
        router.replace({
          pathname: '/(tabs)/record',
          params: { draftSlotId },
        } as never);
        return;
      }
    }
    router.replace((mfaReturnPath || '/') as never);
  }, [
    consumePendingRecoveryDraftSlotId,
    mfaReturnPath,
    pendingRecoveryDraftSlotId,
    router,
  ]);

  const startEnrollment = useCallback(
    async (setupApprovalCode?: string) => {
      const pending = await enrollMfaFactor('Captivet mobile', setupApprovalCode);
      setEnrollment(pending);
      setBootstrapCode('');
      setBootstrapCodeRequired(false);
      setMode('enroll');
    },
    [enrollMfaFactor]
  );

  const bootstrapMfa = useCallback(async () => {
    if (!isAuthenticated) {
      router.replace('/(auth)/login' as never);
      return;
    }

    setIsBootstrapping(true);
    setError(null);
    setCode('');
    setEnrollment(null);
    setBootstrapCodeRequired(false);

    try {
      if (mfaReason === 'MFA_ENROLLMENT_REQUIRED') {
        try {
          await startEnrollment();
        } catch (enrollmentError) {
          setMode('enroll');
          setBootstrapCodeRequired(isSetupApprovalCodeError(enrollmentError));
          setError(mfaErrorMessage(enrollmentError));
        }
        return;
      }

      const status = await refreshMfaStatus();
      const stillRequired = Boolean(status.required);
      if (!stillRequired) {
        const profileLoaded = await retryFetchUser();
        if (profileLoaded) {
          returnToApp();
          return;
        }
      }

      if (status.enrollmentRequired) {
        try {
          await startEnrollment();
        } catch (enrollmentError) {
          setMode('enroll');
          setBootstrapCodeRequired(isSetupApprovalCodeError(enrollmentError));
          setError(mfaErrorMessage(enrollmentError));
        }
        return;
      }

      const factors = await listMfaFactors();
      const verifiedTotp = factors.find(
        (factor) => factor.factorType === 'totp' && factor.status === 'verified'
      );

      if (verifiedTotp) {
        await startMfaChallenge(verifiedTotp.id);
        setMode('challenge');
        return;
      }

      await startEnrollment();
    } catch (e) {
      if (isSetupApprovalCodeError(e)) {
        setMode('enroll');
        setBootstrapCodeRequired(true);
        setError(mfaErrorMessage(e));
        return;
      }
      // A generic bootstrap failure means no challenge was started — showing
      // the code form would only let Verify fail again. Present an explicit
      // failed state with Retry instead.
      setMode('error');
      setError(mfaErrorMessage(e));
    } finally {
      setIsBootstrapping(false);
    }
  }, [
    isAuthenticated,
    listMfaFactors,
    mfaReason,
    refreshMfaStatus,
    retryFetchUser,
    returnToApp,
    router,
    startEnrollment,
    startMfaChallenge,
  ]);

  const bootstrapKey = `${isAuthenticated ? '1' : '0'}:${mfaRequired ? '1' : '0'}:${mfaReason ?? ''}`;
  useEffect(() => {
    if (autoBootstrapKeyRef.current === bootstrapKey) return;
    autoBootstrapKeyRef.current = bootstrapKey;
    bootstrapMfa().catch(() => {});
  }, [bootstrapKey, bootstrapMfa]);

  const handleCodeChange = useCallback((value: string) => {
    setCode(value.replace(/\D/g, '').slice(0, 6));
  }, []);

  const handleStartEnrollment = useCallback(async () => {
    if (bootstrapCodeRequired && !bootstrapCode.trim()) {
      setError('Enter the setup approval code to continue.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setCode('');
    setEnrollment(null);

    try {
      await startEnrollment(bootstrapCode.trim() || undefined);
    } catch (e) {
      if (isSetupApprovalCodeError(e)) {
        setMode('enroll');
        setBootstrapCodeRequired(true);
      }
      setError(mfaErrorMessage(e));
    } finally {
      setIsSubmitting(false);
    }
  }, [bootstrapCode, bootstrapCodeRequired, startEnrollment]);

  const handleVerify = useCallback(async () => {
    if (code.length !== 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (mode === 'enroll') {
        if (!enrollment) throw new Error('Authenticator setup has not started.');
        await verifyMfaEnrollment(enrollment.factorId, code);
      } else {
        await verifyMfaChallenge(code);
      }
      clearMfaChallenge();
      returnToApp();
    } catch (e) {
      setError(mfaErrorMessage(e));
      setCode('');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    clearMfaChallenge,
    code,
    enrollment,
    mode,
    returnToApp,
    verifyMfaChallenge,
    verifyMfaEnrollment,
  ]);

  const handleSignOut = useCallback(() => {
    signOut().catch(() => {});
  }, [signOut]);

  const isEnrollmentSetupPending = mode === 'enroll' && !enrollment;
  const title = mode === 'enroll' ? 'Set up MFA' : 'Verify your identity';
  const subtitle =
    mode === 'error'
      ? MFA_BOOTSTRAP_COPY.failed
      : isEnrollmentSetupPending
      ? 'Set up an authenticator app before continuing.'
      : mode === 'enroll'
      ? 'Scan the QR code with your authenticator app, then enter the generated code.'
      : 'Enter the 6-digit code from your authenticator app to continue.';

  return (
    <SafeAreaView className="screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingHorizontal: 24,
            paddingVertical: 32,
          }}
        >
          <View style={{ width: '100%', maxWidth: scale(420), alignSelf: 'center' }}>
            <View className="card p-6">
              <View className="w-12 h-12 rounded-full bg-brand-50 dark:bg-surface-sunken justify-center items-center mb-5">
                <ShieldCheck color={colors.brand500} size={iconMd} />
              </View>

              <Text className="text-heading-lg font-bold text-content-primary mb-2">
                {title}
              </Text>
              <Text className="text-body text-content-secondary mb-6">{subtitle}</Text>

              {error ? (
                <View
                  className="bg-status-danger p-3 rounded-input mb-4 flex-row items-center gap-2"
                  accessibilityRole="alert"
                  accessibilityLiveRegion="assertive"
                >
                  <AlertCircle color={colors.statusDangerFg} size={16} />
                  <Text className="text-body-sm text-status-danger flex-1">{error}</Text>
                </View>
              ) : null}

              {isBootstrapping || mode === 'loading' ? (
                <View className="py-8 items-center">
                  <ActivityIndicator size="large" color={colors.brand500} />
                </View>
              ) : mode === 'error' ? (
                <View className="gap-3">
                  <Button
                    variant="primary"
                    size="lg"
                    icon={<RefreshCw color={colors.contentOnBrand} size={iconSm} />}
                    disabled={isBootstrapping}
                    onPress={() => {
                      bootstrapMfa().catch(() => {});
                    }}
                  >
                    {MFA_BOOTSTRAP_COPY.retry}
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<LogOut color={colors.contentBody} size={iconSm} />}
                    onPress={handleSignOut}
                  >
                    Sign out
                  </Button>
                </View>
              ) : (
                <View>
                  {isEnrollmentSetupPending ? (
                    <View>
                      <TextInputField
                        label="Setup approval code"
                        value={bootstrapCode}
                        onChangeText={setBootstrapCode}
                        placeholder={
                          bootstrapCodeRequired ? 'Required for admin setup' : 'Optional'
                        }
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        editable={!isSubmitting}
                        returnKeyType="done"
                        onSubmitEditing={() => {
                          handleStartEnrollment().catch(() => {});
                        }}
                      />
                      <View className="gap-3 mt-4">
                        <Button
                          variant="primary"
                          size="lg"
                          icon={<ShieldCheck color={colors.contentOnBrand} size={iconSm} />}
                          loading={isSubmitting}
                          disabled={isSubmitting}
                          onPress={() => {
                            handleStartEnrollment().catch(() => {});
                          }}
                        >
                          Set up authenticator app
                        </Button>
                        <Button
                          variant="secondary"
                          icon={<RefreshCw color={colors.contentBody} size={iconSm} />}
                          disabled={isSubmitting || isBootstrapping}
                          onPress={() => {
                            bootstrapMfa().catch(() => {});
                          }}
                        >
                          Start over
                        </Button>
                        <Button
                          variant="ghost"
                          icon={<LogOut color={colors.contentBody} size={iconSm} />}
                          disabled={isSubmitting}
                          onPress={handleSignOut}
                        >
                          Sign out
                        </Button>
                      </View>
                    </View>
                  ) : (
                    <>
                      {mode === 'enroll' && enrollment ? (
                        <View
                          className="items-center bg-surface rounded-lg p-4 mb-5"
                          accessible
                          accessibilityLabel="QR code for authenticator app setup — or copy the setup key below"
                        >
                          <QRCode
                            value={enrollment.uri}
                            size={Math.min(scale(220), 220)}
                            backgroundColor={colors.surfaceRaised}
                            color={colors.contentPrimary}
                          />
                          <Text className="text-caption font-semibold text-content-tertiary mt-4 mb-1">
                            Setup key
                          </Text>
                          <Text
                            selectable
                            className="text-body-sm text-content-body text-center"
                          >
                            {enrollment.secret}
                          </Text>
                          <View className="mt-3">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Copy color={colors.contentBody} size={iconSm} />}
                              onPress={() => {
                                copyWithAutoClear(enrollment.secret)
                                  .then(() => {
                                    setSetupKeyCopied(true);
                                    setTimeout(() => setSetupKeyCopied(false), 1500);
                                  })
                                  .catch(() => {});
                              }}
                            >
                              {setupKeyCopied ? 'Copied!' : 'Copy setup key'}
                            </Button>
                          </View>
                        </View>
                      ) : null}

                      <TextInputField
                        label="Authentication code"
                        value={code}
                        onChangeText={handleCodeChange}
                        placeholder="123456"
                        keyboardType="number-pad"
                        textContentType="oneTimeCode"
                        autoComplete="one-time-code"
                        maxLength={6}
                        editable={!isSubmitting}
                        returnKeyType="done"
                        onSubmitEditing={() => {
                          handleVerify().catch(() => {});
                        }}
                      />

                      <View className="gap-3 mt-4">
                        <Button
                          variant="primary"
                          size="lg"
                          icon={<ShieldCheck color={colors.contentOnBrand} size={iconSm} />}
                          loading={isSubmitting}
                          disabled={isBootstrapping}
                          onPress={() => {
                            handleVerify().catch(() => {});
                          }}
                        >
                          Verify
                        </Button>
                        <Button
                          variant="secondary"
                          icon={<RefreshCw color={colors.contentBody} size={iconSm} />}
                          disabled={isSubmitting || isBootstrapping}
                          onPress={() => {
                            bootstrapMfa().catch(() => {});
                          }}
                        >
                          Start over
                        </Button>
                        <Button
                          variant="ghost"
                          icon={<LogOut color={colors.contentBody} size={iconSm} />}
                          disabled={isSubmitting}
                          onPress={handleSignOut}
                        >
                          Sign out
                        </Button>
                      </View>
                    </>
                  )}
                </View>
              )}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
