import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRegistrationDocument } from '../src/features/farmer-auth/document-upload.ts';

test('web registration attaches the selected image as a real multipart file', async () => {
  const form = new FormData();
  let requestedUri = '';
  await appendRegistrationDocument(
    form,
    'blob:http://localhost/sample-image',
    'image/png',
    'web',
    async (uri) => {
      requestedUri = uri;
      return new Response(new Blob(['synthetic-image']), { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  );
  assert.equal(requestedUri, 'blob:http://localhost/sample-image');
  const uploaded = form.get('document');
  assert.ok(uploaded instanceof Blob);
  assert.equal(uploaded.name, 'identity-document.png');
  assert.equal(await uploaded.text(), 'synthetic-image');
});

test('web registration rejects an image URI that cannot be read', async () => {
  await assert.rejects(
    appendRegistrationDocument(new FormData(), 'blob:missing', 'image/jpeg', 'web', async () => new Response(null, { status: 404 })),
    /invalid_document/,
  );
});
