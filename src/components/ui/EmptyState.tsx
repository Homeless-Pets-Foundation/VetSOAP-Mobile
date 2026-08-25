import React from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { type LucideIcon } from 'lucide-react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { Button } from './Button';
import { Card } from './Card';
import { cx } from './styles';

interface EmptyStateAction {
  label: string;
  onPress: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'dangerGhost';
}

interface EmptyStateProps {
  icon?: LucideIcon | React.ReactNode;
  title?: string;
  description: string;
  details?: React.ReactNode;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  contained?: boolean;
  iconColor?: string;
  iconSize?: number;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  details,
  action,
  secondaryAction,
  contained = false,
  iconColor,
  iconSize = 32,
  className,
}: EmptyStateProps) {
  const colors = useThemeColors();
  const resolvedIconColor = iconColor ?? colors.stone500;
  const renderedIcon = icon
    ? React.isValidElement(icon)
      ? icon
      : React.createElement(icon as LucideIcon, { color: resolvedIconColor, size: iconSize })
    : null;

  const content = (
    <View className={cx('items-center py-6', className)}>
      {renderedIcon}
      {/* w-full — the parent is items-center, so without it both labels shrink-wrap
          to their measured width and Android "Bold text" lays the trailing word out
          of view (CLAUDE.md > UI Gotchas; the fenced login.tsx precedent). text-center
          keeps the visual centring the parent used to provide. An empty state is pure
          instruction, so the lost half is the actionable half. */}
      {title ? (
        <Text className="text-body font-semibold text-content-primary mt-3 text-center w-full">
          {title}
        </Text>
      ) : null}
      <Text className="text-body text-content-tertiary mt-3 text-center w-full">{description}</Text>
      {details ? <View className="mt-2">{details}</View> : null}
      {action || secondaryAction ? (
        <View className="mt-4 flex-row gap-3">
          {secondaryAction ? (
            <Button
              variant={secondaryAction.variant ?? 'secondary'}
              size="sm"
              onPress={secondaryAction.onPress}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
          {action ? (
            <Button variant={action.variant ?? 'primary'} size="sm" onPress={action.onPress}>
              {action.label}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  if (contained) {
    return <Card className={className}>{content}</Card>;
  }

  return content;
}
