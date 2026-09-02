import { Alert, Linking } from 'react-native';
import { CONSULT_COPY } from '../constants/strings';

// Static outbound link to the Captivet web app Consult AI tool. Was a full
// card on the recording detail (ConsultAICard); it is now a chip in the Tools
// row that opens the link directly — same single tap, no card.
export const CONSULT_URL = 'https://app.captivet.com/consult';

/** Sync + void so it can be handed straight to an `onPress` (crash rule 2). */
export function openConsultAI(): void {
  Linking.openURL(CONSULT_URL).catch(() => {
    Alert.alert(CONSULT_COPY.openFailedTitle, CONSULT_COPY.openFailedBody);
  });
}
