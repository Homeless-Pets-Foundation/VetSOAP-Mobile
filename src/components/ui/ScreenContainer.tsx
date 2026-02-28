import React from 'react';
import { ScrollView, RefreshControl, type ScrollViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
      <SafeAreaView className="screen">
        {children}
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
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
