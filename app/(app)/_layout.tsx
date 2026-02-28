import React from 'react';
import { Redirect, Tabs } from 'expo-router';
import { useAuth } from '../../src/hooks/useAuth';
import { View, ActivityIndicator } from 'react-native';
import { Home, Mic, FileText } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View className="flex-1 justify-center items-center bg-stone-50">
        <ActivityIndicator size="large" color="#0d8775" />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#0d8775',
        tabBarInactiveTintColor: '#a8a29e',
        tabBarStyle: {
          backgroundColor: '#fafaf9',
          borderTopColor: '#e7e5e4',
          paddingBottom: 8,
          paddingTop: 8,
          height: 64,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.04,
          shadowRadius: 4,
          elevation: 4,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
      screenListeners={{
        tabPress: () => {
          Haptics.selectionAsync();
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
          tabBarAccessibilityLabel: 'Home dashboard',
        }}
      />
      <Tabs.Screen
        name="record"
        options={{
          title: 'Record',
          tabBarIcon: ({ color, size }) => <Mic color={color} size={size} />,
          tabBarAccessibilityLabel: 'Record new appointment',
        }}
      />
      <Tabs.Screen
        name="recordings"
        options={{
          title: 'Records',
          tabBarIcon: ({ color, size }) => <FileText color={color} size={size} />,
          tabBarAccessibilityLabel: 'View all recordings',
        }}
      />
      {/* Hide settings from tab bar */}
      <Tabs.Screen
        name="settings"
        options={{ href: null }}
      />
    </Tabs>
  );
}
