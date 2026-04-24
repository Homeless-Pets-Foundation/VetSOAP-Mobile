import React from 'react';
import { Text, View } from 'react-native';
import { type LucideIcon } from 'lucide-react-native';
import { Button } from './Button';
import { Card } from './Card';
import { cx, UI_COLORS } from './styles';

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
  iconColor = UI_COLORS.stone,
  iconSize = 32,
  className,
}: EmptyStateProps) {
  const renderedIcon = icon
    ? React.isValidElement(icon)
      ? icon
      : React.createElement(icon as LucideIcon, { color: iconColor, size: iconSize })
    : null;

  const content = (
    <View className={cx('items-center py-6', className)}>
      {renderedIcon}
      {title ? (
        <Text className="text-body font-semibold text-stone-900 mt-3 text-center">
          {title}
        </Text>
      ) : null}
      <Text className="text-body text-stone-500 mt-3 text-center">{description}</Text>
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
