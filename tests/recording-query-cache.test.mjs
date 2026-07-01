import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('recording cache helper narrows invalidation keys by mutation type', async () => {
  const source = await read('src/lib/recordingQueryCache.ts');

  assert.match(source, /case 'review_update':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\]\]/);
  assert.match(source, /case 'draft_changed':\s*case 'draft_deleted':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\], \['local-drafts'\]\]/);
  assert.match(source, /case 'device_registration_recovered':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\], \['local-drafts'\]\]/);
  assert.match(source, /case 'submit_success':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\], \['local-drafts'\], \['dashboard', 'quality'\]\]/);
  assert.match(source, /case 'detail_deleted':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\], \['local-drafts'\], \['dashboard', 'quality'\]\]/);
  assert.match(source, /case 'soap_regenerated':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['dashboard', 'quality'\]\]/);
  assert.match(source, /case 'metadata_update':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['dashboard', 'quality'\]\]/);
  assert.match(source, /refetchType: 'active'/);
  assert.doesNotMatch(source, /queryKey: \['recordings'\]/);
});

test('hot recording mutations use central cache helper instead of broad invalidation', async () => {
  const card = await read('src/components/RecordingCard.tsx');
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const record = await read('app/(app)/(tabs)/record.tsx');

  assert.match(card, /invalidateRecordingCaches\(queryClient, 'review_update'\)/);
  assert.match(detail, /invalidateRecordingCaches\(\s*queryClient,\s*recording\?\.status === 'draft' \? 'draft_deleted' : 'detail_deleted'/);
  assert.match(record, /invalidateRecordingCaches\(queryClient, 'submit_success'\)/);
  assert.match(await read('src/components/DeviceLimitModal.tsx'), /invalidateRecordingCaches\(queryClient, 'device_registration_recovered'\)/);

  assert.doesNotMatch(card, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
  assert.doesNotMatch(detail, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
  assert.doesNotMatch(record, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
});
