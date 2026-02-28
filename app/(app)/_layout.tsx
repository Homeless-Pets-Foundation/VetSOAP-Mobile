import React from 'react';
import { Redirect, Tabs } from 'expo-router';
import { useAuth } from '../../src/hooks/useAuth';
import { View, ActivityIndicator } from 'react-native';
import { Home, Mic, FileText } from 'lucide-react-native';

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fafaf9' }}>
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
          paddingBottom: 4,
          height: 56,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="record"
        options={{
          title: 'Record',
          tabBarIcon: ({ color, size }) => <Mic color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="recordings"
        options={{
          title: 'Records',
          tabBarIcon: ({ color, size }) => <FileText color={color} size={size} />,
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
