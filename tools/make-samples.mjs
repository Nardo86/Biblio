// Generates the sample library (2 EPUB + 2 PDF) with original text, so the app
// can be demonstrated immediately without any real books.
// Usage: node tools/make-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createCanvas } from '@napi-rs/canvas';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'sample-library');
fs.mkdirSync(OUT, { recursive: true });

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function chapterXhtml(title, paragraphs, imageHref) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>${xmlEscape(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${xmlEscape(title)}</h1>
${paragraphs.map((p) => `<p>${xmlEscape(p)}</p>`).join('\n')}
${imageHref ? `<figure><img src="${imageHref}" alt="illustrazione"/><figcaption>Illustrazione di prova</figcaption></figure>` : ''}
</body></html>`;
}

function ncx(title, chapters) {
  const points = chapters
    .map(
      (ch, i) => `    <navPoint id="nav${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${xmlEscape(ch.title)}</text></navLabel>
      <content src="${ch.file}"/>
    </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:sample"/></head>
  <docTitle><text>${xmlEscape(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

function makeEpub({ file, title, author, year, language, publisher, description, chapters, coverJpeg, illustrationPng }) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  const mimetypeEntry = zip.getEntry('mimetype');
  if (mimetypeEntry) mimetypeEntry.header.method = 0; // must be stored, not deflated

  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`, 'utf8'),
  );

  const manifest = [
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
  ];
  const spine = [];
  if (coverJpeg) {
    manifest.push('<item id="cover-image" href="cover.jpg" media-type="image/jpeg"/>');
    manifest.push('<item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="coverpage"/>');
  }
  chapters.forEach((ch, i) => {
    manifest.push(`<item id="ch${i + 1}" href="${ch.file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${i + 1}"/>`);
  });
  if (illustrationPng) manifest.push('<item id="illu" href="images/illustration.png" media-type="image/png"/>');

  const metaCover = coverJpeg ? '<meta name="cover" content="cover-image"/>' : '';
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:creator opf:role="aut">${xmlEscape(author)}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:date>${year}</dc:date>
    <dc:publisher>${xmlEscape(publisher)}</dc:publisher>
    <dc:identifier id="bookid">urn:uuid:biblio-${encodeURIComponent(file)}</dc:identifier>
    <dc:description>${xmlEscape(description)}</dc:description>
    ${metaCover}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>
`;
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(ncx(title, chapters), 'utf8'));
  zip.addFile(
    'OEBPS/style.css',
    Buffer.from(
      `body { font-family: Georgia, serif; margin: 0; padding: 1.5em; line-height: 1.6; color: #222; }
h1 { font-size: 1.5em; margin: 0 0 1em; }
p { margin: 0 0 1em; text-align: justify; }
figure { margin: 1.5em 0; text-align: center; }
img { max-width: 100%; }
`,
      'utf8',
    ),
  );
  if (coverJpeg) {
    zip.addFile('OEBPS/cover.jpg', coverJpeg);
    zip.addFile(
      'OEBPS/cover.xhtml',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>Copertina</title>
<style>body{margin:0;padding:0;} img{width:100%;display:block;}</style></head>
<body><img src="cover.jpg" alt="Copertina"/></body></html>
`, 'utf8'),
    );
  }
  chapters.forEach((ch) => {
    const imageHref = ch.withImage && illustrationPng ? 'images/illustration.png' : null;
    zip.addFile(`OEBPS/${ch.file}`, Buffer.from(chapterXhtml(ch.title, ch.paragraphs, imageHref), 'utf8'));
  });
  if (illustrationPng) zip.addFile('OEBPS/images/illustration.png', illustrationPng);

  const target = path.join(OUT, file);
  zip.writeZip(target);
  console.log(`[samples] wrote ${path.relative(ROOT, target)}`);
}

async function makeCoverJpeg(title, author) {
  const canvas = createCanvas(600, 900);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 900);
  gradient.addColorStop(0, '#2f4a6d');
  gradient.addColorStop(1, '#12243a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 600, 900);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(28, 28, 544, 844);
  ctx.fillStyle = '#f3e9d2';
  ctx.font = 'bold 54px serif';
  ctx.textAlign = 'center';
  const words = title.split(' ');
  let y = 340;
  for (let i = 0; i < words.length; i += 2) {
    ctx.fillText(words.slice(i, i + 2).join(' '), 300, y);
    y += 68;
  }
  ctx.font = '28px serif';
  ctx.fillStyle = 'rgba(243,233,210,0.85)';
  ctx.fillText(author, 300, y + 40);
  ctx.font = '20px sans-serif';
  ctx.fillText('Edizioni Lampo', 300, 800);
  return canvas.encode('jpeg', 88);
}

function makeIllustrationPng() {
  const canvas = createCanvas(400, 240);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9eef5';
  ctx.fillRect(0, 0, 400, 240);
  ctx.fillStyle = '#7fa2c9';
  ctx.beginPath();
  ctx.arc(120, 90, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3d5c82';
  ctx.fillRect(0, 170, 400, 70);
  ctx.fillStyle = '#1d2b3a';
  ctx.font = '18px sans-serif';
  ctx.fillText('illustrazione di prova', 20, 30);
  return canvas.encode('png');
}

// ---------- minimal PDF writer ----------

function pdfEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ');
}

function contentStream(page) {
  const parts = ['BT'];
  let first = true;
  for (const line of page.lines) {
    const size = line.size || 12;
    if (first) {
      parts.push(`/F1 ${size} Tf`);
      parts.push(`60 ${line.y || 760} Td`);
      parts.push(`${Math.round(size * 1.5)} TL`);
      first = false;
    } else {
      parts.push(`/F1 ${size} Tf`);
      parts.push(`${Math.round(size * 1.5)} TL`);
    }
    parts.push(`(${pdfEscape(line.text)}) Tj`);
    parts.push('T*');
  }
  parts.push('ET');
  return parts.join('\n');
}

function buildPdf({ title, author, subject, creationDate, pages }) {
  const objects = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const contentIds = pages.map((_, i) => 5 + i * 2);
  const infoId = 4 + pages.length * 2;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    const stream = contentStream(page);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[i]} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  const infoParts = [];
  if (title) infoParts.push(`/Title (${pdfEscape(title)})`);
  if (author) infoParts.push(`/Author (${pdfEscape(author)})`);
  if (subject) infoParts.push(`/Subject (${pdfEscape(subject)})`);
  if (creationDate) infoParts.push(`/CreationDate (${creationDate})`);
  infoParts.push('/Producer (Biblioteca sample generator)');
  objects.push(`<< ${infoParts.join(' ')} >>`);

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---------- build the sample library ----------

const cover = await makeCoverJpeg('Il sentiero delle nuvole', 'Giulia Ferrando');
const illustration = await makeIllustrationPng();

makeEpub({
  file: 'Il sentiero delle nuvole.epub',
  title: 'Il sentiero delle nuvole',
  author: 'Giulia Ferrando',
  year: '2021-05-12',
  language: 'it',
  publisher: 'Edizioni Lampo',
  description:
    'Un breve racconto di montagna: una cartografa torna nel paese dove e cresciuta per ridisegnare i sentieri che nessuno percorre piu. Testo di esempio scritto apposta per questa libreria dimostrativa.',
  coverJpeg: cover,
  illustrationPng: illustration,
  chapters: [
    {
      file: 'chapter1.xhtml',
      title: 'Prima di partire',
      paragraphs: [
        'La valle si apriva come una mano che si apre lentamente. Nora contava i tornanti dal finestrino e ogni volta perdeva il conto allo stesso punto, dove la strada si nascondeva dietro un costone di roccia.',
        'Nel cassetto del cruscotto c era una mappa vecchia di trent anni, piegata secondo una logica che solo suo padre conosceva. I sentieri erano segnati a matita, con una grafia sottile che il tempo aveva reso quasi trasparente.',
        'Scese alla fermata senza pensilina, con la valigia che faceva rumore sulla ghiaia. L aria era fredda anche in maggio, e odorava di legna bagnata.',
      ],
    },
    {
      file: 'chapter2.xhtml',
      title: 'Il sentiero basso',
      paragraphs: [
        'Il sentiero basso cominciava dietro il lavatoio e saliva tra i castagni senza fretta. Nora camminava con il GPS spento: voleva sbagliare strada almeno una volta, per capire dove la memoria si era aggiustata da sola.',
        'A meta costa trovò un muretto a secco che non ricordava. Ci si sedette sopra, tirò fuori il quaderno e disegnò la curva della valle con tre tratti di matita.',
        'Quando il sole superò la cresta, la luce cambiò e ogni cosa sembrò piu vicina: i tetti, il campanile, la strada che portava al passo.',
      ],
      withImage: true,
    },
    {
      file: 'chapter3.xhtml',
      title: 'Ridisegnare',
      paragraphs: [
        'Passò tre giorni a ridisegnare i sentieri. Alcuni esistevano ancora, altri erano diventati rigagnoli, altri ancora erano soltanto un ricordo condiviso da chi li aveva percorsi.',
        'La sera, nella cucina della casa vuota, stendeva i fogli sul tavolo e li confrontava con le tracce del telefono. Ogni differenza era una storia che qualcuno le aveva raccontato senza saperlo.',
        'Parti con la mappa finita dentro una custodia di plastica. Non era una mappa perfetta. Era, per la prima volta, una mappa sua.',
      ],
    },
  ],
});

makeEpub({
  file: 'Quaderno di bottega.epub',
  title: 'Quaderno di bottega',
  author: 'Anonimo fiorentino',
  year: '1998',
  language: 'it',
  publisher: 'Stamperia privata',
  description:
    'Appunti di lavoro di un rilegatore: ricette di colla, misure di fogli, piccoli errori annotati in margine. Questo volume di esempio non ha una copertina nel file EPUB, quindi Biblioteca genera una copertina dalla prima pagina di testo.',
  coverJpeg: null,
  chapters: [
    {
      file: 'chapter1.xhtml',
      title: 'Della colla',
      paragraphs: [
        'La colla di farina si fa con una parte di farina e quattro di acqua, mescolando a freddo e poi scaldando piano. Se bolle, perde tenuta. Va usata tiepida e mai conservata oltre due giorni.',
        'Per i dorsi stretti meglio la colla animale, che tira e stringe. Per le carte leggere la pasta di amido, che non macchia e si lascia correggere con un panno umido.',
        'Ogni bottega ha la sua ricetta e nessuna e sbagliata, finche il libro resta insieme.',
      ],
    },
    {
      file: 'chapter2.xhtml',
      title: 'Delle misure',
      paragraphs: [
        'Un foglio in ottavo si ottiene piegando tre volte il foglio intero. Le misure vanno prese sempre sul taglio, mai sul dorso, perche la piega mangia un millimetro e a volte due.',
        'Segnare a matita tenera e cancellare con gomma pane. La matita dura lascia solchi che la luce radente rivela per sempre.',
        'Chi rilega un libro vecchio deve togliere il meno possibile: ogni filo che resta e una pagina che non si stacca.',
      ],
    },
  ],
});

const pdfPages = [
  {
    lines: [
      { text: 'Manuale di prova', size: 26, y: 770 },
      { text: 'Documento PDF di esempio per Biblioteca', size: 13 },
      { text: '', size: 12 },
      { text: 'Questo file serve a verificare la lettura dei PDF nel browser:', size: 12 },
      { text: 'estrazione dei metadati, copertina generata dalla prima pagina,', size: 12 },
      { text: 'navigazione tra le pagine, zoom e salvataggio della posizione.', size: 12 },
      { text: '', size: 12 },
      { text: 'Il testo e volutamente semplice e senza caratteri accentati,', size: 12 },
      { text: 'cosi da restare leggibile con i font standard del formato PDF.', size: 12 },
    ],
  },
  {
    lines: [
      { text: 'Capitolo 2 - Come funziona la scansione', size: 18, y: 770 },
      { text: '', size: 12 },
      { text: 'La scansione percorre ricorsivamente le cartelle indicate e legge', size: 12 },
      { text: 'i metadati di ogni file EPUB e PDF. Se un file e danneggiato,', size: 12 },
      { text: 'viene registrato con un errore e la scansione prosegue.', size: 12 },
      { text: '', size: 12 },
      { text: 'Le copertine vengono salvate accanto al database e servite', size: 12 },
      { text: 'dall applicazione, senza dipendere da servizi esterni.', size: 12 },
    ],
  },
  {
    lines: [
      { text: 'Capitolo 3 - Posizione di lettura', size: 18, y: 770 },
      { text: '', size: 12 },
      { text: 'Ogni libro ricorda l ultima pagina letta. Chiudendo il browser', size: 12 },
      { text: 'e riaprendo il libro, la posizione viene ripristinata.', size: 12 },
      { text: '', size: 12 },
      { text: 'Fine del documento di prova.', size: 12 },
    ],
  },
];

fs.writeFileSync(
  path.join(OUT, 'Manuale di prova.pdf'),
  buildPdf({
    title: 'Manuale di prova',
    author: 'Redazione Biblioteca',
    subject: 'Documento dimostrativo con tre pagine di testo',
    creationDate: 'D:20230314101500',
    pages: pdfPages,
  }),
);
console.log('[samples] wrote sample-library/Manuale di prova.pdf');

fs.writeFileSync(
  path.join(OUT, 'appunti_di_viaggio.pdf'),
  buildPdf({
    title: null,
    author: null,
    subject: null,
    creationDate: 'D:20190708',
    pages: [
      {
        lines: [
          { text: 'Appunti di viaggio', size: 24, y: 760 },
          { text: 'Senza metadati nel file: il titolo viene ricavato dal nome del file.', size: 12 },
          { text: '', size: 12 },
          { text: 'Questo PDF non contiene un dizionario Info con titolo e autore,', size: 12 },
          { text: 'quindi Biblioteca usa il nome del file come titolo di partenza.', size: 12 },
          { text: 'Il titolo resta modificabile a mano dalla scheda del libro.', size: 12 },
        ],
      },
      {
        lines: [
          { text: 'Seconda pagina', size: 18, y: 760 },
          { text: '', size: 12 },
          { text: 'Serve a verificare lo scorrimento tra le pagine.', size: 12 },
        ],
      },
    ],
  }),
);
console.log('[samples] wrote sample-library/appunti_di_viaggio.pdf');
console.log('[samples] done');
