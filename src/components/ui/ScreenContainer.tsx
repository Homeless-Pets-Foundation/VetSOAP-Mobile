import React from 'react';
import { ScrollView, RefreshControl, View, type ScrollViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
  if (!scrollable) {
    return (
      <SafeAreaView className="screen" style={{ alignItems: 'center' }}>
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
            <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} />
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
