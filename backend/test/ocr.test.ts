import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { compareAadhaarDocument, compareExtractedFields, extractAadhaarFieldsFromLines, initializeOcr, shutdownOcr, testAadhaarDocument, type RegistrationDetails } from '../src/providers/ocr.js';

test.after(async () => shutdownOcr());

const lines = [
  { text: 'To', confidence: 92 },
  { text: 'Sample Farmer', confidence: 94 },
  { text: 'S/O Sample Parent', confidence: 90 },
  { text: 'Village Example, District Example', confidence: 89 },
  { text: 'State Karnataka, PIN Code 570000', confidence: 91 },
  { text: 'Your Aadhaar No.', confidence: 93 },
  { text: '9999 8888 7777', confidence: 95 },
  { text: 'Name: Sample Farmer', confidence: 91 },
  { text: 'ಜನ್ಮ ದಿನಾಂಕ / DOB: 01/01/1980', confidence: 88 },
  { text: 'ಲಿಂಗ / Gender: Male', confidence: 89 },
];

const farmer: RegistrationDetails = {
  fullName: 'Sample Farmer', age: 46, gender: 'male', phone: '9876543210',
  aadhaar: '999988887777', address: 'Village Example District Example',
};

test('extracts Aadhaar fields using text labels rather than fixed card coordinates', () => {
  const fields = extractAadhaarFieldsFromLines(lines);
  assert.equal(fields.aadhaarNumber, '999988887777');
  assert.equal(fields.dateOfBirth, '1980-01-01');
  assert.equal(fields.gender, 'male');
  assert.equal(fields.fullName, 'Sample Farmer');
  assert.match(fields.addressText ?? '', /Village Example/);
  assert.deepEqual(compareExtractedFields(fields, farmer), {
    name: true, gender: true, aadhaar: true, address: true,
  });
});

test('reports field mismatch without returning extracted Aadhaar data as the error', () => {
  const fields = extractAadhaarFieldsFromLines(lines);
  const result = compareExtractedFields(fields, { ...farmer, fullName: 'Different Person' });
  assert.deepEqual(result, { name: false, gender: true, aadhaar: true, address: true });
});

test('registration comparison does not verify entered age against document date of birth', () => {
  const withoutDobLines = lines.filter(({ text }) => !/DOB|ಜನ್ಮ/i.test(text));
  const withoutBirthDate = extractAadhaarFieldsFromLines(withoutDobLines);
  const entered = { ...farmer, age: 99 };
  assert.equal(withoutBirthDate.dateOfBirth, null);
  assert.deepEqual(compareExtractedFields(withoutBirthDate, entered), {
    name: true, gender: true, aadhaar: true, address: true,
  });
});

test('address comparison accepts meaningful partial overlap and a one-character OCR variation', () => {
  const fields = { ...extractAadhaarFieldsFromLines(lines), addressText: 'Shivakrupa Nilaya, Renja, Karnataka' };
  const entered = { ...farmer, address: 'Shivakrupa Nilaya, Renja, Karkala Taluk' };
  assert.equal(compareExtractedFields(fields, entered).address, true);

  const talukuFields = { ...fields, addressText: 'Shivakrupa Nilaya, Renja, Karkala Taluku' };
  assert.equal(compareExtractedFields(talukuFields, entered).address, true);
});

test('address comparison still fails when fewer than two meaningful tokens match', () => {
  const fields = { ...extractAadhaarFieldsFromLines(lines), addressText: 'Shivakrupa Nilaya' };
  const entered = { ...farmer, address: 'Shivakrupa Nilaya, Renja, Karkala Taluk' };
  assert.equal(compareExtractedFields(fields, entered).address, false);
});

test('uses bilingual labels and does not assume the name/address blocks occupy fixed positions', () => {
  const reordered = [
    { text: 'ಕನ್ನಡ ಶೀರ್ಷಿಕೆ / Government heading', confidence: 80 },
    { text: 'Aadhaar No. / ಆಧಾರ್ ಸಂಖ್ಯೆ', confidence: 92 },
    { text: '9999 8888 7777', confidence: 94 },
    { text: 'Address / ವಿಳಾಸ', confidence: 86 },
    { text: 'Village Example, District Example, Karnataka', confidence: 90 },
    { text: 'Name: Sample Farmer', confidence: 94 },
    { text: 'DOB / ಜನ್ಮ ದಿನಾಂಕ: 01/01/1980', confidence: 89 },
    { text: 'Gender / ಲಿಂಗ: Male', confidence: 91 },
  ];
  const fields = extractAadhaarFieldsFromLines(reordered);
  assert.deepEqual(compareExtractedFields(fields, farmer), {
    name: true, gender: true, aadhaar: true, address: true,
  });
});

test('associates the Aadhaar number when OCR orders it before its printed label', () => {
  const numberBeforeLabel = extractAadhaarFieldsFromLines([
    { text: '9999 8888 7777', confidence: 95 },
    { text: 'Your Aadhaar No.', confidence: 90 },
    ...lines.slice(7),
  ]);
  assert.equal(numberBeforeLabel.aadhaarNumber, '999988887777');
});

test('extracts the lower-card English name when OCR merges bilingual text with a number', () => {
  const fields = extractAadhaarFieldsFromLines([
    { text: 'To', confidence: 95 },
    { text: 'Sample Farmer', confidence: 95 },
    { text: 'Aadhaar No.', confidence: 95 },
    { text: '9999 8888 7777', confidence: 95 },
    { text: 'ದೀಕ್ಷಿತ್ 03 Deekshith', confidence: 85 },
    { text: 'DOB: 01/01/1980', confidence: 95 },
    { text: 'Gender: Male', confidence: 95 },
    { text: 'Address', confidence: 95 },
    { text: 'Village Example District Example Karnataka', confidence: 95 },
  ]);
  assert.equal(fields.fullName, 'Deekshith');
});

test('does not extract an upper address recipient as the lower-section full name', () => {
  const upperOnly = extractAadhaarFieldsFromLines([
    { text: 'To', confidence: 95 },
    { text: 'Sample Farmer', confidence: 95 },
    { text: 'Village Example District Example', confidence: 95 },
    { text: 'Date of Birth: 01/01/1980', confidence: 95 },
  ]);
  assert.equal(upperOnly.fullName, null);
});

test('full name comparison requires the complete extracted name, not a matching substring', () => {
  const extracted = extractAadhaarFieldsFromLines([
    { text: 'Address: Sample Farmer District', confidence: 90 },
    { text: 'Name: Sample Farmer Holdings', confidence: 95 },
    { text: 'DOB: 01/01/1980', confidence: 95 },
  ]);
  assert.equal(extracted.fullName, 'Sample Farmer Holdings');
  const comparison = compareExtractedFields(extracted, farmer);
  assert.equal(comparison.name, false);
});

test('runs local English/Kannada Tesseract OCR on an in-memory synthetic image', async () => {
  await initializeOcr();
  const svg = `<svg width="1300" height="1700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="Noto Sans Kannada, Arial" font-size="48" fill="black"><text x="90" y="200">To</text><text x="90" y="280">Sample Farmer</text><text x="90" y="360">Village Example District Example</text><text x="90" y="500">Aadhaar No. / ಆಧಾರ್ ಸಂಖ್ಯೆ</text><text x="90" y="580">9999 8888 7777</text><text x="90" y="900">Name: Sample Farmer</text><text x="90" y="1000">ಜನ್ಮ ದಿನಾಂಕ / Date of Birth: 01/01/1980</text><text x="90" y="1100">ಲಿಂಗ / Gender: Male</text><text x="90" y="1250">ವಿಳಾಸ / Address</text><text x="90" y="1330">Village Example District Example Karnataka</text></g></svg>`;
  const image = await sharp(Buffer.from(svg)).png().toBuffer();
  const result = await compareAadhaarDocument(image, 'image/png', farmer);
  assert.equal(result.status, 'matched', result.status === 'unreadable' ? result.issues.join(',') : result.status === 'mismatch' ? result.mismatches.join(',') : '');
  const preview = await testAadhaarDocument(image, 'image/png', { fullName: farmer.fullName, dateOfBirth: '1980-01-01', gender: farmer.gender, address: farmer.address });
  assert.equal(preview.status, 'match');
  assert.deepEqual(preview.comparisons, { fullName: 'match', dateOfBirth: 'match', gender: 'match', address: 'match' });
  assert.equal('aadhaarNumber' in preview.extracted, false);

  const unrelatedNameSvg = `<svg width="1300" height="1700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="Arial" font-size="48" fill="black"><text x="90" y="180">Sample Farmer</text><text x="90" y="280">Example Market Information</text><text x="90" y="500">Aadhaar No.</text><text x="90" y="580">9999 8888 7777</text><text x="90" y="900">Name: Actual Person</text><text x="90" y="1000">Date of Birth: 01/01/1980</text><text x="90" y="1100">Gender: Male</text><text x="90" y="1250">Address</text><text x="90" y="1330">Village Example District Example Karnataka</text></g></svg>`;
  const unrelatedNameImage = await sharp(Buffer.from(unrelatedNameSvg)).png().toBuffer();
  const unrelatedNameResult = await testAadhaarDocument(unrelatedNameImage, 'image/png', { fullName: 'Sample Farmer', dateOfBirth: '1980-01-01', gender: 'male', address: 'Village Example District Example Karnataka' });
  assert.equal(unrelatedNameResult.extracted.fullName, 'Actual Person');
  assert.equal(unrelatedNameResult.comparisons.fullName, 'mismatch');
  assert.equal(unrelatedNameResult.status, 'mismatch');
  const small = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
  const quality = await compareAadhaarDocument(small, 'image/png', farmer);
  assert.equal(quality.status, 'unreadable');
  if (quality.status === 'unreadable') assert.ok(quality.issues.includes('low_resolution'));
});
