/**
 * Dependency-free single-page PDF builder shared by receipts and bills (#902).
 *
 * Produces a minimal PDF 1.4 document with a standards-compliant xref table.
 * Each line is rendered in Helvetica; a line may override its font size and
 * whether it is bold, and an empty string renders as a blank spacer line.
 */

export type PdfLine = string | { text: string; size?: number; bold?: boolean };

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function createTextPdf(lines: PdfLine[], options: { fontSize?: number; lineHeight?: number } = {}): Buffer {
  const defaultSize = options.fontSize ?? 14;
  const lineHeight = options.lineHeight ?? 24;
  const ops: string[] = ["BT", "72 740 Td"];
  lines.forEach((line, i) => {
    const { text, size, bold } = typeof line === "string" ? { text: line } : line;
    const font = bold ? "/F2" : "/F1";
    ops.push(`${font} ${size ?? defaultSize} Tf`);
    ops.push(i === 0 ? `(${escapePdfText(text)}) Tj` : `0 -${lineHeight} Td (${escapePdfText(text)}) Tj`);
  });
  ops.push("ET");
  const stream = ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export type PagedPdfLine = string | { text: string; size?: number; bold?: boolean; mono?: boolean };

/**
 * Multi-page variant for long reports (#873). Lines flow onto new US-letter
 * pages as needed; `mono` lines use Courier so tabular rows stay aligned.
 */
export function createPagedTextPdf(
  lines: PagedPdfLine[],
  options: { fontSize?: number; lineHeight?: number } = {},
): Buffer {
  const defaultSize = options.fontSize ?? 11;
  const lineHeight = options.lineHeight ?? 16;
  const top = 750;
  const bottom = 60;
  const perPage = Math.max(1, Math.floor((top - bottom) / lineHeight));

  const pages: PagedPdfLine[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([""]);

  // 1 catalog, 2 pages, 3-5 fonts, then (page, content) pairs.
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  ];
  const kids: string[] = [];
  pages.forEach((pageLines, p) => {
    const ops: string[] = ["BT", `72 ${top} Td`];
    pageLines.forEach((line, i) => {
      const { text, size, bold, mono } = typeof line === "string" ? { text: line } : line;
      const font = mono ? "/F3" : bold ? "/F2" : "/F1";
      ops.push(`${font} ${size ?? defaultSize} Tf`);
      ops.push(i === 0 ? `(${escapePdfText(text)}) Tj` : `0 -${lineHeight} Td (${escapePdfText(text)}) Tj`);
    });
    ops.push("ET");
    ops.push(`BT /F1 8 Tf 72 ${bottom - 24} Td (Page ${p + 1} of ${pages.length}) Tj ET`);
    const stream = ops.join("\n");
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}
