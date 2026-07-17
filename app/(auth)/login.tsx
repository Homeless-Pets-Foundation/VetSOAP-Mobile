import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import Animated, { FadeInDown, FadeInUp, FadeIn } from 'react-native-reanimated';
import { AlertCircle, Eye, EyeOff, Info } from 'lucide-react-native';
import { useAuthActions } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { GoogleGlyph } from '../../src/components/ui/GoogleGlyph';
import { HIT_SLOP } from '../../src/components/ui/styles';
import { emailSchema, passwordSchema } from '../../src/lib/validation';
import { consumeLogoutReason } from '../../src/lib/logoutReason';
import {
  isAppleSignInAvailable,
  isGoogleSignInConfiguredForCurrentPlatform,
} from '../../src/auth/socialAuth';
import { LOGIN_COPY } from '../../src/constants/strings';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60_000; // 1 minute

export default function LoginScreen() {
  const router = useRouter();
  const { signIn, signInWithGoogle, signInWithApple } = useAuthActions();
  const { scale, iconSm } = useResponsive();
  const colors = useThemeColors();
  const { colorScheme } = useColorScheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [socialProvider, setSocialProvider] = useState<'google' | 'apple' | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [lockoutRemaining, setLockoutRemaining] = useState(0);

  const [sessionExpired, setSessionExpired] = useState(false);
  const failedAttemptsRef = useRef(0);
  const lockoutUntilRef = useRef<number>(0);
  const lockoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const passwordInputRef = useRef<TextInput>(null);
  // Lazy-required so old dev-clients without expo-apple-authentication don't
  // crash on module load (CLAUDE.md rule 19).
  const appleModuleRef = useRef<typeof import('expo-apple-authentication') | null>(null);

  const googleConfigured = isGoogleSignInConfiguredForCurrentPlatform();

  useEffect(() => {
    if (consumeLogoutReason() === 'session_expired') {
      setSessionExpired(true);
    }
  }, []);

  useEffect(() => {
    isAppleSignInAvailable()
      .then((available) => {
        if (!available) return;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native module (CLAUDE.md rule 19)
          appleModuleRef.current = require('expo-apple-authentication');
          setAppleAvailable(true);
        } catch {
          // Module absent in this build — keep the button hidden.
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    };
  }, []);

  // Ticking lockout countdown: disables the buttons and keeps the remaining
  // seconds current instead of a stale snapshot the user must re-press to see.
  const startLockout = useCallback(() => {
    lockoutUntilRef.current = Date.now() + LOCKOUT_DURATION_MS;
    failedAttemptsRef.current = 0;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockoutUntilRef.current - Date.now()) / 1000));
      setLockoutRemaining(remaining);
      if (remaining <= 0 && lockoutTimerRef.current) {
        clearInterval(lockoutTimerRef.current);
        lockoutTimerRef.current = null;
        setError(null);
      } else if (remaining > 0) {
        setError(LOGIN_COPY.lockout(remaining));
      }
    };
    if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    tick();
    lockoutTimerRef.current = setInterval(tick, 1000);
  }, []);

  const isLockedOut = lockoutRemaining > 0;

  const handleSignIn = useCallback(async () => {
    // Single-flight: the keyboard Go action bypasses the disabled Sign In
    // button, so repeated presses could start concurrent Supabase sign-ins
    // with competing auth-state transitions (Codex P2, PR #143).
    if (isLoading || socialProvider !== null) return;
    if (lockoutUntilRef.current > Date.now()) return;

    // Validate email format
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      setError(emailResult.error.issues[0]?.message ?? 'Invalid email');
      return;
    }

    // Validate password length
    const passwordResult = passwordSchema.safeParse(password);
    if (!passwordResult.success) {
      setError(passwordResult.error.issues[0]?.message ?? 'Invalid password');
      return;
    }

    setError(null);
    setSessionExpired(false);
    setIsLoading(true);

    try {
      const result = await signIn(emailResult.data, passwordResult.data);
      if (result.error) {
        failedAttemptsRef.current += 1;
        if (failedAttemptsRef.current >= MAX_LOGIN_ATTEMPTS) {
          startLockout();
        } else {
          setError(result.error);
        }
      } else {
        failedAttemptsRef.current = 0;
        // Clear password from React state after successful login to prevent
        // it from lingering in memory on shared clinic tablets
        setPassword('');
      }
    } catch {
      setError(LOGIN_COPY.networkError);
    } finally {
      setIsLoading(false);
    }
  }, [email, password, signIn, startLockout, isLoading, socialProvider]);

  const handleSocial = useCallback(
    async (provider: 'google' | 'apple') => {
      // Respect the same brute-force lockout that guards the password form.
      // A cancelled social prompt is a silent no-op and does not count against
      // the attempt budget (socialAuth returns { error: null } on cancel).
      if (isLoading || socialProvider !== null) return;
      if (lockoutUntilRef.current > Date.now()) return;

      setError(null);
      setSessionExpired(false);
      setSocialProvider(provider);
      try {
        const result =
          provider === 'google' ? await signInWithGoogle() : await signInWithApple();
        if (result.cancelled) {
          return;
        }
        if (result.error) {
          failedAttemptsRef.current += 1;
          if (failedAttemptsRef.current >= MAX_LOGIN_ATTEMPTS) {
            startLockout();
          } else {
            setError(result.error);
          }
        } else {
          failedAttemptsRef.current = 0;
        }
      } catch {
        setError(LOGIN_COPY.networkError);
      } finally {
        setSocialProvider(null);
      }
    },
    [signInWithGoogle, signInWithApple, startLockout, isLoading, socialProvider]
  );

  const AppleAuthenticationButton = appleModuleRef.current?.AppleAuthenticationButton;
  const appleModule = appleModuleRef.current;
  const showSocialSection = googleConfigured || (appleAvailable && !!AppleAuthenticationButton);

  return (
    <SafeAreaView className="screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 24,
            paddingVertical: 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
        <View style={{ width: '100%', maxWidth: scale(400) }}>
        {/* Logo / Brand */}
        <Animated.View entering={FadeInDown.duration(500)} className="items-center mb-10 w-full">
          <Image
            source={require('../../assets/logo-wordmark.png')}
            style={{ width: '70%', maxWidth: 320, aspectRatio: 600 / 139 }}
            resizeMode="contain"
            accessibilityLabel="Captivet"
          />
          <Text
            className="text-body text-content-tertiary mt-3"
            style={{ textAlign: 'center' }}
            numberOfLines={2}
          >
            Sign in to your account
          </Text>
        </Animated.View>

        {/* Form */}
        <Animated.View
          entering={FadeInUp.duration(500).delay(200)}
          className="card p-6"
        >
          {sessionExpired && !error && (
            <Animated.View
              entering={FadeIn.duration(200)}
              className="bg-status-warning p-3 rounded-input mb-4 flex-row items-center gap-2"
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              <Info color={colors.statusWarningFg} size={16} />
              <Text className="text-body-sm text-status-warning flex-1">Your session expired. Please sign in again.</Text>
            </Animated.View>
          )}

          {error && (
            <Animated.View
              entering={FadeIn.duration(200)}
              className="bg-status-danger p-3 rounded-input mb-4 flex-row items-center gap-2"
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              <AlertCircle color={colors.statusDangerFg} size={16} />
              <Text className="text-body-sm text-status-danger flex-1">{error}</Text>
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
            autoComplete="email"
            textContentType="username"
            editable={!isLoading && socialProvider === null}
            returnKeyType="next"
            onSubmitEditing={() => passwordInputRef.current?.focus()}
            blurOnSubmit={false}
          />

          <TextInputField
            ref={passwordInputRef}
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
            secureTextEntry={!showPassword}
            autoComplete="current-password"
            textContentType="password"
            editable={!isLoading && socialProvider === null}
            returnKeyType="go"
            onSubmitEditing={() => { handleSignIn().catch(() => {}); }}
            rightAccessory={
              <Pressable
                onPress={() => setShowPassword(prev => !prev)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <Eye color={colors.contentTertiary} size={iconSm} />
                ) : (
                  <EyeOff color={colors.contentTertiary} size={iconSm} />
                )}
              </Pressable>
            }
          />

          <Pressable
            onPress={() => router.push('/(auth)/forgot-password')}
            hitSlop={HIT_SLOP}
            accessibilityRole="link"
            accessibilityLabel={LOGIN_COPY.forgotPassword}
            className="self-end mb-1"
            style={{ minHeight: 32, justifyContent: 'center' }}
          >
            <Text className="text-body-sm font-medium text-brand-500">
              {LOGIN_COPY.forgotPassword}
            </Text>
          </Pressable>

          <View className="mt-2">
            <Button
              variant="primary"
              size="lg"
              onPress={() => { handleSignIn().catch(() => {}); }}
              loading={isLoading}
              disabled={socialProvider !== null || isLockedOut}
              accessibilityLabel="Sign In"
            >
              Sign In
            </Button>
          </View>

          {showSocialSection && (
            <>
              <View className="flex-row items-center my-5">
                <View className="flex-1 h-px bg-surface-sunken" />
                <Text className="px-3 text-body-sm text-content-tertiary">{LOGIN_COPY.orContinueWith}</Text>
                <View className="flex-1 h-px bg-surface-sunken" />
              </View>

              <View className="gap-3">
                {appleAvailable && AppleAuthenticationButton && appleModule && (
                  <AppleAuthenticationButton
                    buttonType={appleModule.AppleAuthenticationButtonType.SIGN_IN}
                    buttonStyle={
                      colorScheme === 'dark'
                        ? appleModule.AppleAuthenticationButtonStyle.WHITE
                        : appleModule.AppleAuthenticationButtonStyle.BLACK
                    }
                    cornerRadius={12}
                    style={{ width: '100%', height: 48, opacity: socialProvider === 'apple' || isLoading ? 0.5 : 1 }}
                    onPress={() => {
                      if (isLoading || socialProvider !== null || isLockedOut) return;
                      handleSocial('apple').catch(() => {});
                    }}
                  />
                )}

                {googleConfigured && (
                  <Button
                    variant="secondary"
                    size="lg"
                    icon={<GoogleGlyph size={iconSm + 2} />}
                    onPress={() => { handleSocial('google').catch(() => {}); }}
                    loading={socialProvider === 'google'}
                    disabled={isLoading || socialProvider === 'apple' || isLockedOut}
                    accessibilityLabel={LOGIN_COPY.continueWithGoogle}
                  >
                    {LOGIN_COPY.continueWithGoogle}
                  </Button>
                )}
              </View>
            </>
          )}
        </Animated.View>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
