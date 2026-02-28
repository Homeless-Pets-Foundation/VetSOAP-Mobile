import React, { useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { SoapNote } from '../types';

const SECTIONS = [
  { key: 'subjective' as const, label: 'Subjective', color: '#0d8775' },
  { key: 'objective' as const, label: 'Objective', color: '#2563eb' },
  { key: 'assessment' as const, label: 'Assessment', color: '#d97706' },
  { key: 'plan' as const, label: 'Plan', color: '#7c3aed' },
];

interface SoapNoteViewProps {
  soapNote: SoapNote;
}

export function SoapNoteView({ soapNote }: SoapNoteViewProps) {
  const [expandedSection, setExpandedSection] = useState<string | null>('subjective');

  const copySection = async (label: string, content: string) => {
    await Clipboard.setStringAsync(content);
    Alert.alert('Copied', `${label} section copied to clipboard`);
  };

  const copyAll = async () => {
    const fullNote = SECTIONS.map(({ key, label }) => {
      const section = soapNote[key];
      return `${label.toUpperCase()}:\n${section.content}`;
    }).join('\n\n');

    await Clipboard.setStringAsync(fullNote);
    Alert.alert('Copied', 'Full SOAP note copied to clipboard');
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#1c1917' }}>
          SOAP Note
        </Text>
        <Pressable
          onPress={copyAll}
          style={{
            backgroundColor: '#0d8775',
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 6,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Copy All</Text>
        </Pressable>
      </View>

      {SECTIONS.map(({ key, label, color }) => {
        const section = soapNote[key];
        const isExpanded = expandedSection === key;

        return (
          <View
            key={key}
            style={{
              borderWidth: 1,
              borderColor: '#e7e5e4',
              borderRadius: 10,
              marginBottom: 8,
              overflow: 'hidden',
            }}
          >
            <Pressable
              onPress={() => setExpandedSection(isExpanded ? null : key)}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 12,
                backgroundColor: '#fafaf9',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View
                  style={{
                    width: 4,
                    height: 20,
                    backgroundColor: color,
                    borderRadius: 2,
                    marginRight: 10,
                  }}
                />
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917' }}>
                  {label}
                </Text>
              </View>
              <Text style={{ fontSize: 18, color: '#a8a29e' }}>
                {isExpanded ? '−' : '+'}
              </Text>
            </Pressable>

            {isExpanded && (
              <View style={{ padding: 12, paddingTop: 0 }}>
                <Text
                  style={{ fontSize: 14, lineHeight: 22, color: '#44403c', marginTop: 8 }}
                  selectable
                >
                  {section.content}
                </Text>
                <Pressable
                  onPress={() => copySection(label, section.content)}
                  style={{
                    marginTop: 10,
                    alignSelf: 'flex-end',
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 4,
                    borderWidth: 1,
                    borderColor: '#d6d3d1',
                  }}
                >
                  <Text style={{ fontSize: 12, color: '#57534e' }}>Copy</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
