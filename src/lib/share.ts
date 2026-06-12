import { Share } from 'react-native';
import { safeDeleteFile } from './fileOps';

type PrintModule = typeof import('expo-print');
type SharingModule = typeof import('expo-sharing');

function loadPrint(): PrintModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-print') as PrintModule;
  } catch {
    return null;
  }
}

function loadSharing(): SharingModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-sharing') as SharingModule;
  } catch {
    return null;
  }
}

export async function shareText(message: string, title = 'SOAP Note'): Promise<boolean> {
  const result = await Share.share({ title, message });
  return result.action === Share.sharedAction;
}

export async function sharePdfHtml(html: string, title = 'SOAP Note'): Promise<void> {
  const Print = loadPrint();
  const Sharing = loadSharing();
  if (!Print || !Sharing) {
    throw new Error('PDF sharing is unavailable in this build.');
  }

  let uri: string | null = null;
  try {
    const result = await Print.printToFileAsync({ html, base64: false });
    uri = result.uri;
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      throw new Error('Share sheet is unavailable on this device.');
    }
    await Sharing.shareAsync(uri, {
      dialogTitle: title,
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
    });
  } finally {
    if (uri) safeDeleteFile(uri);
  }
}
