export async function appendRegistrationDocument(
  body: FormData,
  imageUri: string,
  imageType: string,
  platform: 'web' | 'native',
  fetchImage: typeof fetch = fetch,
) {
  if (platform === 'web') {
    let imageResponse: Response;
    try { imageResponse = await fetchImage(imageUri); }
    catch { throw new Error('invalid_document'); }
    if (!imageResponse.ok) throw new Error('invalid_document');
    const imageBlob = await imageResponse.blob();
    if (!imageBlob.size) throw new Error('invalid_document');
    const extension = imageType.includes('png') ? 'png' : imageType.includes('webp') ? 'webp' : imageType.includes('pdf') ? 'pdf' : 'jpg';
    body.append('document', imageBlob, `identity-document.${extension}`);
    return;
  }
  body.append('document', { uri: imageUri, name: 'identity-document', type: imageType } as never);
}
