import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, Image, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeInUp, FadeIn } from 'react-native-reanimated';
import { AlertCircle, Eye, EyeOff, Info, Apple } from 'lucide-react-native';
import { useAuth } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { TextInputField } from '../../src/components/ui/TextInputField';
import { Button } from '../../src/components/ui/Button';
import { GoogleGlyph } from '../../src/components/ui/GoogleGlyph';
import { emailSchema, passwordSchema } from '../../src/lib/validation';
import { consumeLogoutReason } from '../../src/lib/logoutReason';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60_000; // 1 minute

export default function LoginScreen() {
  const { signIn, signInWithGoogle, signInWithApple } = useAuth();
  const { scale, iconSm } = useResponsive();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [socialProvider, setSocialProvider] = useState<'google' | 'apple' | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const [sessionExpired, setSessionExpired] = useState(false);
  const failedAttemptsRef = useRef(0);
  const lockoutUntilRef = useRef<number>(0);

  useEffect(() => {
    if (consumeLogoutReason() === 'session_expired') {
      setSessionExpired(true);
    }
  }, []);

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
          lockoutUntilRef.current = Date.now() + LOCKOUT_DURATION_MS;
          failedAttemptsRef.current = 0;
          setError('Too many failed attempts. Please try again in 60s.');
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
      setError('A network error occurred. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [email, password, signIn]);

  const handleSocial = useCallback(
    async (provider: 'google' | 'apple') => {
      // Respect the same brute-force lockout that guards the password form.
      // A cancelled social prompt is a silent no-op and does not count against
      // the attempt budget (socialAuth returns { error: null } on cancel).
      if (lockoutUntilRef.current > Date.now()) {
        const remaining = Math.ceil((lockoutUntilRef.current - Date.now()) / 1000);
        setError(`Too many failed attempts. Please try again in ${remaining}s.`);
        return;
      }

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
            lockoutUntilRef.current = Date.now() + LOCKOUT_DURATION_MS;
            failedAttemptsRef.current = 0;
            setError('Too many failed attempts. Please try again in 60s.');
          } else {
            setError(result.error);
          }
        } else {
          failedAttemptsRef.current = 0;
        }
      } catch {
        setError('A network error occurred. Please check your connection and try again.');
      } finally {
        setSocialProvider(null);
      }
    },
    [signInWithGoogle, signInWithApple]
  );

  return (
    <SafeAreaView className="screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center px-6"
        style={{ alignItems: 'center' }}
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
            className="text-body text-stone-500 mt-3"
            style={{ textAlign: 'center' }}
            numberOfLines={1}
            adjustsFontSizeToFit
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
              className="bg-amber-50 p-3 rounded-input mb-4 flex-row items-center gap-2"
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              <Info color="#92400e" size={16} />
              <Text className="text-body-sm text-amber-800 flex-1">Your session expired. Please sign in again.</Text>
            </Animated.View>
          )}

          {error && (
            <Animated.View
              entering={FadeIn.duration(200)}
              className="bg-danger-50 p-3 rounded-input mb-4 flex-row items-center gap-2"
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
            secureTextEntry={!showPassword}
            rightAccessory={
              <Pressable
                onPress={() => setShowPassword(prev => !prev)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <Eye color="#78716c" size={iconSm} />
                ) : (
                  <EyeOff color="#78716c" size={iconSm} />
                )}
              </Pressable>
            }
          />

          <View className="mt-2">
            <Button
              variant="primary"
              size="lg"
              onPress={() => { handleSignIn().catch(() => {}); }}
              loading={isLoading}
              disabled={socialProvider !== null}
              accessibilityLabel="Sign into your Account"
            >
              Sign In
            </Button>
          </View>

          <View className="flex-row items-center my-5">
            <View className="flex-1 h-px bg-stone-200" />
            <Text className="px-3 text-body-sm text-stone-500">or continue with</Text>
            <View className="flex-1 h-px bg-stone-200" />
          </View>

          <View className="gap-3">
            <Button
              variant="secondary"
              size="lg"
              icon={<GoogleGlyph size={iconSm + 2} />}
              onPress={() => { handleSocial('google').catch(() => {}); }}
              loading={socialProvider === 'google'}
              disabled={isLoading || socialProvider === 'apple'}
              accessibilityLabel="Continue with Google"
            >
              Continue with Google
            </Button>

            {Platform.OS === 'ios' && (
              <Button
                variant="secondary"
                size="lg"
                icon={<Apple color="#000" size={iconSm + 2} fill="#000" />}
                onPress={() => { handleSocial('apple').catch(() => {}); }}
                loading={socialProvider === 'apple'}
                disabled={isLoading || socialProvider === 'google'}
                accessibilityLabel="Continue with Apple"
              >
                Continue with Apple
              </Button>
            )}
          </View>
        </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
