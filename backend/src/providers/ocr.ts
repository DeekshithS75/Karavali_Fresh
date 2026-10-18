import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const englishData = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
const kannadaData = require('@tesseract.js-data/kan') as { langPath: string; gzip: boolean };
const coreDirectory = path.dirname(require.resolve('tesseract.js-core'));
const tessdataDirectory = path.resolve(process.cwd(), '.cache', 'tessdata');

export type RegistrationDetails = {
  fullName: string;
  age: number;
  gender: 'male' | 'female' | 'other';
  phone: string;
  aadhaar: string;
  address: string;
};

export type ExtractedAadhaarFields = {
  aadhaarNumber: string | null;
  dateOfBirth: string | null;
  birthYear: number | null;
  gender: RegistrationDetails['gender'] | null;
  fullName: string | null;
  addressText: string | null;
};

export type OcrComparison =
  | { status: 'matched'; fields: ExtractedAadhaarFields }
  | { status: 'mismatch'; fields: ExtractedAadhaarFields; mismatches: Array<'name' | 'age' | 'gender' | 'aadhaar' | 'address'> }
  | { status: 'unreadable'; issues: Array<'low_resolution' | 'too_bright' | 'too_dark' | 'low_contrast' | 'blurred' | 'unsupported_image' | 'text_not_recognized' | 'required_fields_missing'> };
type OcrIssue = Extract<OcrComparison, { status: 'unreadable' }>['issues'][number];

export type OcrTestExpected = { fullName: string; dateOfBirth: string; gender: RegistrationDetails['gender']; address: string };
export type OcrTestResult = {
  status: 'match' | 'mismatch' | 'unreadable';
  extracted: { fullName: string | null; dateOfBirth: string | null; gender: RegistrationDetails['gender'] | null; address: string | null };
  comparisons: Record<'fullName' | 'dateOfBirth' | 'gender' | 'address', 'match' | 'mismatch' | 'unreadable'>;
  issues?: OcrIssue[];
};

let workerPromise: Promise<Worker> | null = null;
let queued = Promise.resolve();
let engineReady = false;

/** Copies only reviewed English/Kannada OCR models from installed packages. */
export async function initializeOcr() {
  await mkdir(tessdataDirectory, { recursive: true });
  for (const [code, data] of [['eng', englishData], ['kan', kannadaData]] as const) {
    await copyFile(path.join(data.langPath, `${code}.traineddata.gz`), path.join(tessdataDirectory, `${code}.traineddata.gz`));
  }
  workerPromise = createWorker(['eng', 'kan'], 1, {
    langPath: tessdataDirectory,
    corePath: coreDirectory,
    cachePath: tessdataDirectory,
    cacheMethod: 'none',
    gzip: true,
  });
  await workerPromise;
  engineReady = true;
}

export const isOcrConfigured = () => engineReady;

export async function shutdownOcr() {
  if (!workerPromise) return;
  try { await (await workerPromise).terminate(); } catch { /* Worker may already be unavailable after initialization failure. */ }
  finally { workerPromise = null; engineReady = false; }
}

async function getWorker() {
  if (!engineReady) throw new Error('ocr_engine_not_configured');
  workerPromise ??= createWorker(['eng', 'kan'], 1, {
    langPath: tessdataDirectory,
    corePath: coreDirectory,
    cachePath: tessdataDirectory,
    cacheMethod: 'none',
    gzip: true,
  });
  return workerPromise;
}

type ImagePreparation = { status: 'ready'; buffer: Buffer } | { status: 'unreadable'; issues: OcrIssue[] };

function blurVariance(gray: Buffer, width: number, height: number, channels: number) {
  const values: number[] = [];
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const center = gray[(y * width + x) * channels]!;
      const laplacian = gray[((y - 1) * width + x) * channels]! + gray[((y + 1) * width + x) * channels]! +
        gray[(y * width + x - 1) * channels]! + gray[(y * width + x + 1) * channels]! - 4 * center;
      values.push(laplacian);
    }
  }
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

async function prepareImage(input: Buffer): Promise<ImagePreparation> {
  let image: Sharp;
  let metadata: Metadata;
  try {
    image = sharp(input, { limitInputPixels: 25_000_000 }).rotate();
    metadata = await image.metadata();
  } catch {
    return { status: 'unreadable', issues: ['unsupported_image'] };
  }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) {
    return { status: 'unreadable', issues: ['unsupported_image'] };
  }
  try {
    const issues: Array<'low_resolution' | 'too_bright' | 'too_dark' | 'low_contrast' | 'blurred'> = [];
    if (Math.min(metadata.width, metadata.height) < 700) issues.push('low_resolution');
    const { data, info } = await image.clone().resize({ width: 1800, height: 3000, fit: 'inside', withoutEnlargement: true })
      .greyscale().raw().toBuffer({ resolveWithObject: true });
    const stats = await image.clone().greyscale().stats();
    if (stats.channels[0]!.mean > 254) issues.push('too_bright');
    if (stats.channels[0]!.mean < 30) issues.push('too_dark');
    if (stats.channels[0]!.stdev < 17) issues.push('low_contrast');
    if (blurVariance(data, info.width, info.height, info.channels) < 8) issues.push('blurred');
    if (issues.length) return { status: 'unreadable', issues };
    const normalized = await image.clone().resize({ width: 3200, height: 5000, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).normalize().png().toBuffer();
    return { status: 'ready', buffer: normalized };
  } catch {
    return { status: 'unreadable', issues: ['unsupported_image'] };
  }
}

type OcrLine = { text: string; confidence: number };

function collectLines(data: Awaited<ReturnType<Worker['recognize']>>['data']): OcrLine[] {
  return (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
    .map((line) => ({ text: line.text.trim(), confidence: line.confidence }))
    .filter((line) => line.text.length > 0 && line.confidence >= 15);
}

const aadhaarLabel = /aadhaar|aadhar|ಆಧಾರ್|आधार/i;
const dateLabel = /\b(?:dob|date\s+of\s+birth|year\s+of\s+birth)\b|ಜನ್ಮ|ಹುಟ್ಟಿದ/i;
const addressLabel = /\baddress\b|ವಿಳಾಸ|पता/i;
const nameLabel = /^(?:name|ಹೆಸರು)\s*[:：-]\s*(.+)$/i;
const nonNameText = /\b(?:government|unique|identification|authority|india|aadhaar|aadhar|enrollment|address|pin\s*code|district|state|karnataka|village|taluk|taluku|road|street|house|mobile|phone|barcode|gender|male|female|transgender|date\s+of\s+birth|dob|to|s\/o|d\/o|w\/o|c\/o|son\s+of|daughter\s+of|wife\s+of)\b|ವಿಳಾಸ|ಜಿಲ್ಲೆ|ರಾಜ್ಯ|ಕರ್ನಾಟಕ|ತಾಲೂಕು|ರಸ್ತೆ|ಮನೆ|ಮೊಬೈಲ್|ಲಿಂಗ|ಜನ್ಮ|ಭಾರತ/i;
const normalizeText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = (value: string) => normalizeText(value).split(/\s+/).filter((part) => part.length > 1);

function cleanNameLine(line: string): string | null {
  const labelled = nameLabel.exec(line.trim());
  const candidate = (labelled?.[1] ?? line).trim().replace(/[,:;]+$/u, '').trim();
  if (!candidate || candidate.length > 70 || /\d/u.test(candidate) || nonNameText.test(candidate) ||
      aadhaarLabel.test(candidate) || dateLabel.test(candidate) || addressLabel.test(candidate) ||
      /[^\p{L}\s'’.-]/u.test(candidate)) return null;
  const parts = tokens(candidate);
  if (!parts.length || parts.length > 5) return null;
  return candidate;
}

function extractFullName(lines: string[], dateIndex: number): string | null {
  if (dateIndex < 1) return null;
  const recipientIndex = lines.findIndex((line) => /^\s*(?:to\b|ಗೆ(?:\s|$))/i.test(line));
  const aadhaarAfterRecipient = recipientIndex >= 0
    ? lines.findIndex((line, index) => index > recipientIndex && aadhaarLabel.test(line))
    : -1;
  // A recipient block is address context. If it is present but no Aadhaar
  // section boundary can be found, do not guess a name from that block.
  if (recipientIndex >= 0 && recipientIndex < dateIndex && aadhaarAfterRecipient < 0) return null;
  // The name is associated with the lower-section DOB/gender details. Search only
  // nearby preceding lines and choose the nearest line that contains just a name.
  const start = Math.max(0, dateIndex - 3);
  for (let index = dateIndex - 1; index >= start; index--) {
    if (recipientIndex >= 0 && index > recipientIndex && index < aadhaarAfterRecipient) continue;
    const candidate = cleanNameLine(lines[index]!);
    if (candidate) return candidate;
  }
  return null;
}

function namesMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualTokens = tokens(actual);
  const expectedTokens = tokens(expected);
  return actualTokens.length > 0 && actualTokens.length === expectedTokens.length &&
    actualTokens.every((token, index) => token === expectedTokens[index]);
}

export function extractAadhaarFieldsFromLines(lines: OcrLine[]): ExtractedAadhaarFields {
  const texts = lines.map((line) => line.text);
  const dateIndex = lines.findIndex((line) => dateLabel.test(line.text));
  const context = texts.slice(Math.max(0, dateIndex - 2), Math.min(texts.length, dateIndex + 3)).join(' ');
  const dateMatch = context.match(/(?:\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\b|\b\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}\b)/);
  const yearMatch = context.match(/(?:year\s+of\s+birth|ಜನ್ಮ\s*ವರ್ಷ)\D{0,12}(19\d{2}|20\d{2})/i);
  let dateOfBirth: string | null = null;
  let birthYear: number | null = null;
  if (dateMatch) {
    const raw = dateMatch[0];
    const parts = raw.split(/[/.\-]/).map(Number);
    const [year, month, day] = parts[0]! > 31 ? parts : [parts[2]!, parts[1]!, parts[0]!];
    const date = new Date(Date.UTC(year!, month! - 1, day!));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day) {
      dateOfBirth = date.toISOString().slice(0, 10);
      birthYear = year!;
    }
  } else if (yearMatch) birthYear = Number(yearMatch[1]);

  const genderContext = texts.slice(Math.max(0, dateIndex - 2), Math.min(texts.length, dateIndex + 4)).join(' ').toLocaleLowerCase('en');
  const gender: RegistrationDetails['gender'] | null = /\b(?:female|woman)\b|ಮಹಿಳೆ|स्त्री/.test(genderContext)
    ? 'female'
    : /\b(?:male|man)\b|ಪುರುಷ|पुरुष/.test(genderContext)
      ? 'male'
      : /transgender|ತೃತೀಯ ಲಿಂಗ/i.test(genderContext) ? 'other' : null;

  const fullName = extractFullName(texts, dateIndex);

  const aadhaarNumber = (() => {
    const matches: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const match = texts[i]!.match(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/);
      if (!match) continue;
      const nearby = texts.slice(Math.max(0, i - 2), i + 1).join(' ');
      if (aadhaarLabel.test(nearby)) matches.push(match[0].replace(/\D/g, ''));
    }
    return matches.find((value) => value.length === 12) ?? null;
  })();

  const addressStarts = texts.map((line, index) => ({ line, index }))
    .filter(({ line }) => addressLabel.test(line) || /^\s*(?:to\b|ಗೆ(?:\s|$))/i.test(line));
  const addressBlocks = addressStarts.map(({ index }) => {
    const end = texts.findIndex((candidate, candidateIndex) => candidateIndex > index &&
      (aadhaarLabel.test(candidate) || /enrollment\s*(?:no|number)|ನವೀಕರಣ\s*ಸಂಖ್ಯೆ/i.test(candidate)));
    const block = texts.slice(index + 1, end >= 0 ? end : index + 13)
      .filter((candidate) => !/^\s*(?:to\b|ಗೆ(?:\s|$))/i.test(candidate));
    return block.join(' ').trim();
  }).filter((block) => block.length > 0);
  const addressLines = addressBlocks;
  const addressText = addressLines.length ? addressLines.join(' ').replace(/\s+/g, ' ').trim() : null;
  return { aadhaarNumber, dateOfBirth, birthYear, gender, fullName, addressText };
}

function calculatedAge(birthDate: string, now: Date): number {
  const date = new Date(`${birthDate}T00:00:00.000Z`);
  let age = now.getUTCFullYear() - date.getUTCFullYear();
  if (now.getUTCMonth() < date.getUTCMonth() ||
      (now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate())) age--;
  return age;
}

export function compareExtractedFields(extracted: ExtractedAadhaarFields, entered: RegistrationDetails, now: Date) {
  const nameMatches = namesMatch(extracted.fullName, entered.fullName);
  const ageMatches = extracted.dateOfBirth
    ? calculatedAge(extracted.dateOfBirth, now) === entered.age
    : extracted.birthYear !== null && [now.getUTCFullYear() - extracted.birthYear, now.getUTCFullYear() - extracted.birthYear - 1].includes(entered.age);
  const enteredAddress = [...new Set(tokens(entered.address))];
  const documentAddress = new Set(tokens(extracted.addressText ?? ''));
  const addressMatchCount = enteredAddress.filter((part) => documentAddress.has(part)).length;
  const addressMatches = enteredAddress.length >= 3 && addressMatchCount / enteredAddress.length >= 0.8;
  return {
    name: nameMatches,
    age: ageMatches,
    gender: extracted.gender === entered.gender,
    aadhaar: extracted.aadhaarNumber === entered.aadhaar,
    address: addressMatches,
  };
}

export async function compareAadhaarDocument(buffer: Buffer, mimeType: string, entered: RegistrationDetails, now = new Date()): Promise<OcrComparison> {
  if (!engineReady || !workerPromise) throw new Error('ocr_engine_unavailable');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return { status: 'unreadable', issues: ['unsupported_image'] };
  const prepared = await prepareImage(buffer);
  if (prepared.status !== 'ready') return prepared;
  const run = async (): Promise<OcrComparison> => {
    const worker = await getWorker();
    const result = await worker.recognize(prepared.buffer, {}, { text: true, blocks: true });
    const lines = collectLines(result.data);
    if (!lines.length) return { status: 'unreadable', issues: ['text_not_recognized'] };
    const fields = extractAadhaarFieldsFromLines(lines);
    const missing: string[] = [];
    if (!fields.aadhaarNumber) missing.push('aadhaar');
    if (!fields.dateOfBirth && !fields.birthYear) missing.push('date_of_birth');
    if (!fields.gender) missing.push('gender');
    if (!fields.fullName) missing.push('name');
    if (!fields.addressText) missing.push('address');
    if (missing.length) return { status: 'unreadable', issues: ['required_fields_missing'] };
    const comparison = compareExtractedFields(fields, entered, now);
    const mismatches = (Object.entries(comparison) as Array<[keyof typeof comparison, boolean]>)
      .filter(([, equal]) => !equal).map(([field]) => field);
    return mismatches.length ? { status: 'mismatch', fields, mismatches } : { status: 'matched', fields };
  };
  const current = queued.then(run, run);
  queued = current.then(() => undefined, () => undefined);
  try { return await current; } catch { throw new Error('ocr_engine_unavailable'); }
}

/** Development OCR preview. Uses the same image preparation, Tesseract worker and field parser as registration and returns no Aadhaar number. */
export async function testAadhaarDocument(buffer: Buffer, mimeType: string, expected: OcrTestExpected): Promise<OcrTestResult> {
  if (!engineReady || !workerPromise) throw new Error('ocr_engine_unavailable');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return unreadableTestResult(['unsupported_image']);
  const prepared = await prepareImage(buffer);
  if (prepared.status !== 'ready') return unreadableTestResult(prepared.issues);
  const run = async (): Promise<OcrTestResult> => {
    const worker = await getWorker();
    const result = await worker.recognize(prepared.buffer, {}, { text: true, blocks: true });
    const lines = collectLines(result.data);
    if (!lines.length) return unreadableTestResult(['text_not_recognized']);
    const fields = extractAadhaarFieldsFromLines(lines);
    const extracted = {
      fullName: fields.fullName,
      dateOfBirth: fields.dateOfBirth,
      gender: fields.gender,
      address: fields.addressText,
    };
    const nameMatches = namesMatch(fields.fullName, expected.fullName);
    const enteredAddress = [...new Set(tokens(expected.address))];
    const documentAddress = new Set(tokens(fields.addressText ?? ''));
    const addressMatches = enteredAddress.length >= 3 && enteredAddress.filter((token) => documentAddress.has(token)).length / enteredAddress.length >= 0.8;
    const comparisons = {
      fullName: !fields.fullName ? 'unreadable' as const : nameMatches ? 'match' as const : 'mismatch' as const,
      dateOfBirth: !fields.dateOfBirth ? 'unreadable' as const : fields.dateOfBirth === expected.dateOfBirth ? 'match' as const : 'mismatch' as const,
      gender: !fields.gender ? 'unreadable' as const : fields.gender === expected.gender ? 'match' as const : 'mismatch' as const,
      address: !fields.addressText ? 'unreadable' as const : addressMatches ? 'match' as const : 'mismatch' as const,
    };
    const status = Object.values(comparisons).includes('unreadable') ? 'unreadable' : Object.values(comparisons).includes('mismatch') ? 'mismatch' : 'match';
    return { status, extracted, comparisons, ...(status === 'unreadable' ? { issues: ['required_fields_missing' as const] } : {}) };
  };
  const current = queued.then(run, run);
  queued = current.then(() => undefined, () => undefined);
  try { return await current; } catch { throw new Error('ocr_engine_unavailable'); }
}

function unreadableTestResult(issues: OcrIssue[]): OcrTestResult {
  return {
    status: 'unreadable',
    extracted: { fullName: null, dateOfBirth: null, gender: null, address: null },
    comparisons: { fullName: 'unreadable', dateOfBirth: 'unreadable', gender: 'unreadable', address: 'unreadable' },
    issues,
  };
}

export const OCR_ENGINE_NAME = 'Tesseract OCR (English + Kannada)';
