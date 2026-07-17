import React from 'react';
import { ScrollView, RefreshControl, View, type ScrollViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';

/** Max content width (dp) for tablet/large-screen centering */
export const CONTENT_MAX_WIDTH = 600;

interface ScreenContainerProps extends Omit<ScrollViewProps, 'style'> {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scrollable?: boolean;
}

export function ScreenContainer({
  children,
  refreshing,
  onRefresh,
  scrollable = true,
  ...rest
}: ScreenContainerProps) {
  const colors = useThemeColors();
  if (!scrollable) {
    return (
      <SafeAreaView className="screen items-center">
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, flex: 1 }}>
          {children}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="screen">
      <ScrollView
        className="flex-1 px-5 pt-5"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing ?? false}
              onRefresh={onRefresh}
              // Themed spinner: the platform default ignored brand + dark mode.
              tintColor={colors.brand500}
              colors={[colors.brand500]}
              progressBackgroundColor={colors.surfaceRaised}
            />
          ) : undefined
        }
        {...rest}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
