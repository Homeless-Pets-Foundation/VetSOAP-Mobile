import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { IconButton } from './IconButton';
import { cx, runMaybeAsync, UI_COLORS } from './styles';

interface SheetProps {
  visible: boolean;
  onClose: () => void | Promise<void>;
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  closeLabel?: string;
  closeOnBackdropPress?: boolean;
  className?: string;
  contentClassName?: string;
}

export function Sheet({
  visible,
  onClose,
  title,
  description,
  children,
  footer,
  closeLabel = 'Close',
  closeOnBackdropPress = true,
  className,
  contentClassName,
}: SheetProps) {
  const insets = useSafeAreaInsets();

  const close = () => {
    runMaybeAsync('Sheet onClose', onClose);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
    >
      <View className="flex-1 justify-end bg-black/40">
        {closeOnBackdropPress ? (
          <Pressable
            className="absolute inset-0"
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            onPress={close}
          />
        ) : null}
        <View
          className={cx('bg-white rounded-t-2xl border border-stone-200 max-h-[86%]', className)}
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          accessibilityViewIsModal
        >
          <View className="flex-row items-start px-5 pt-5 pb-3 border-b border-stone-200">
            <View className="flex-1 mr-3">
              {title ? (
                <Text className="text-heading font-bold text-stone-900">{title}</Text>
              ) : null}
              {description ? (
                <Text className="text-body-sm text-stone-500 mt-1">{description}</Text>
              ) : null}
            </View>
            <IconButton
              icon={<X color={UI_COLORS.stoneDark} size={20} />}
              label={closeLabel}
              onPress={close}
              size="sm"
              haptic={false}
            />
          </View>
          <ScrollView className={cx('px-5 py-3', contentClassName)}>{children}</ScrollView>
          {footer ? <View className="px-5 pt-3 border-t border-stone-200">{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}
