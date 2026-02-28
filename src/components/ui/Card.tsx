import React from 'react';
import { type ViewProps } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

interface CardProps extends Pick<ViewProps, 'accessibilityLabel' | 'accessibilityRole'> {
  children: React.ReactNode;
  className?: string;
  animated?: boolean;
}

export function Card({ children, className = '', animated = false, ...rest }: CardProps) {
  const baseClass = 'card';

  if (animated) {
    return (
      <Animated.View entering={FadeIn.duration(300)} className={`${baseClass} ${className}`} {...rest}>
        {children}
      </Animated.View>
    );
  }

  return (
    <Animated.View className={`${baseClass} ${className}`} {...rest}>
      {children}
    </Animated.View>
  );
}
