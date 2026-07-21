import { inflateRawSync } from "node:zlib";

// Minimal dependency-free .xlsx table reader for local inspection. Reads the
// first worksheet in workbook order into string records. Out of scope by
// design: styles/number formats (date cells surface as raw serial numbers),
// formulas beyond their cached values, and multi-sheet selection.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function zipEntries(bytes: Buffer): Map<string, ZipEntry> {
  const maxScan = Math.min(bytes.length, 22 + 65_536);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= bytes.length - maxScan; offset -= 1) {
    if (offset >= 0 && bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Workbook is not a valid .xlsx archive.");
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("Workbook central directory is malformed.");
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const entry: ZipEntry = {
      name: bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"),
      method: bytes.readUInt16LE(cursor + 10),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize: bytes.readUInt32LE(cursor + 24),
      localHeaderOffset: bytes.readUInt32LE(cursor + 42),
    };
    entries.set(entry.name, entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(bytes: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`Workbook part ${entry.name} exceeds the ${maxBytes}-byte local inspection limit.`);
  }
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error("Workbook entry header is malformed.");
  }
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) {
    throw new Error(`Workbook part ${entry.name} uses unsupported compression method ${entry.method}.`);
  }
  const inflated = inflateRawSync(raw, { maxOutputLength: maxBytes });
  if (inflated.length !== entry.uncompressedSize) {
    throw new Error(`Workbook part ${entry.name} did not decompress to its declared size.`);
  }
  return inflated;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const item of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    const texts = [...item[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXmlText(match[1]!));
    // A <si> with no <t> (e.g. an empty run) is an empty shared string.
    strings.push(texts.join(""));
  }
  return strings;
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function firstSheetPath(entries: Map<string, ZipEntry>, workbookXml: string, relsXml: string): string {
  const sheet = workbookXml.match(/<sheet\s[^>]*\/?>/)?.[0];
  if (!sheet) throw new Error("Workbook declares no worksheets.");
  const relId = sheet.match(/r:id="([^"]+)"/)?.[1];
  const target = relId
    ? relsXml.match(new RegExp(`<Relationship\\s[^>]*Id="${relId}"[^>]*Target="([^"]+)"`))?.[1]
      ?? relsXml.match(new RegExp(`<Relationship\\s[^>]*Target="([^"]+)"[^>]*Id="${relId}"`))?.[1]
    : undefined;
  const resolved = target
    ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`)
    : "xl/worksheets/sheet1.xml";
  if (!entries.has(resolved)) {
    throw new Error(`Workbook worksheet ${resolved} is missing from the archive.`);
  }
  return resolved;
}

function cellValue(cell: string, body: string, strings: string[]): string {
  const type = cell.match(/(?:^|\s)t="([^"]+)"/)?.[1] ?? "n";
  if (type === "inlineStr") {
    const texts = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXmlText(match[1]!));
    return texts.join("");
  }
  const value = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
  if (value === undefined) return "";
  if (type === "s") {
    const shared = strings[Number.parseInt(value, 10)];
    if (shared === undefined) throw new Error("Workbook cell names a missing shared string.");
    return shared;
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return decodeXmlText(value);
}

export type XlsxLimits = {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxFieldCharacters: number;
};

export function readXlsxRecords(bytes: Buffer, limits: XlsxLimits): string[][] {
  const entries = zipEntries(bytes);
  const part = (name: string): string | null => {
    const entry = entries.get(name);
    return entry ? readZipEntry(bytes, entry, limits.maxBytes).toString("utf8") : null;
  };
  const workbookXml = part("xl/workbook.xml");
  if (!workbookXml) throw new Error("Workbook is missing xl/workbook.xml; is this a real .xlsx file?");
  const sheetPath = firstSheetPath(entries, workbookXml, part("xl/_rels/workbook.xml.rels") ?? "");
  const sheetXml = part(sheetPath)!;
  const strings = sharedStrings(part("xl/sharedStrings.xml"));

  const records: string[][] = [];
  let width = 0;
  for (const rowMatch of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    if (records.length >= limits.maxRows + 1) {
      throw new Error(`Workbook has more than ${limits.maxRows} data rows; split it before local inspection.`);
    }
    const record: string[] = [];
    let nextColumn = 0;
    for (const cellMatch of rowMatch[1]!.matchAll(/<c((?:\s[^>]*)?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = cellMatch[1]!.match(/(?:^|\s)r="([A-Z]+)\d+"/)?.[1];
      const column = reference ? columnIndex(reference) : nextColumn;
      if (column >= limits.maxColumns) {
        throw new Error(`Workbook has more than ${limits.maxColumns} columns.`);
      }
      while (record.length < column) record.push("");
      const value = cellValue(cellMatch[1]!, cellMatch[2] ?? "", strings);
      if (value.length > limits.maxFieldCharacters) {
        throw new Error(`Workbook cell exceeds ${limits.maxFieldCharacters} characters.`);
      }
      record[column] = value;
      nextColumn = column + 1;
    }
    width = Math.max(width, record.length);
    records.push(record);
  }
  // Sparse sheets omit trailing empty cells; square the table so downstream
  // width checks see a rectangle.
  for (const record of records) {
    while (record.length < width) record.push("");
  }
  return records;
}
