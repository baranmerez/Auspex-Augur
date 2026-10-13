// Masks likely personal data in report previews by column name. This is a
// heuristic safety net, not a guarantee: free-text and JSON columns can still
// carry personal data, so reports can add columns (`mask`) or, after a
// conscious decision, exempt them (`unmask`).

// Patterns match whole name parts (split on _ and camelCase), Turkish and English.
const personalPatterns = [
  /^(ad|adi|adı|soyad|soyadi|soyadı|adsoyad|unvan|unvani|ünvan|isim|name|firstname|lastname|fullname)$/,
  /^(tel|telefon|gsm|cep|phone|mobile|fax|faks)$/,
  /^(tc|tckn|tckimlik|kimlik|kimlikno|nationalid|ssn|passport|pasaport)$/,
  /^(vkn|vergino|vdno|taxid|taxno)$/,
  /^(adres|address|addr|sokak|street|postakodu|zip|zipcode|postcode)$/,
  /^(mail|email|eposta)$/,
  /^(iban|hesapno|accountno|card|kart|cardno|kartno)$/,
  /^(dogumtarihi|birthdate|dob)$/,
  /^(ip|ipaddress)$/,
];
const wholeNamePatterns = [/(email|eposta|telefon|iban|tckimlik|kimlikno|adsoyad|fullname|dogumtarihi)/];
// Turkish names are often compounds without separators (aliciadi, gonderenunvan,
// alicitelefon). Over-masking a harmless column beats leaking a personal one.
const suffixPattern = /.{2,}(adi|adı|soyadi|soyadı|unvan|unvani|unvanı|telefon|gsm|vdno|vkn|tckn|adres|adresi|email|eposta|iban)$/;

function nameParts(column) {
  return String(column)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9çğıöşü]+/)
    .filter(Boolean);
}

export function isPersonalColumn(column) {
  const lower = String(column).toLowerCase();
  if (wholeNamePatterns.some(re => re.test(lower))) return true;
  return nameParts(column).some(part => personalPatterns.some(re => re.test(part)) || suffixPattern.test(part));
}

// Value shape kept recognizable without exposing it: "Ayşe Yılmaz" -> "A*** Y***".
export function maskValue(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!text.trim()) return text;
  return text.split(/(\s+)/).map(part => (/\s+/.test(part) || !part ? part : part[0] + '***')).join('');
}

// Returns masked rows plus the list of masked columns.
export function maskRows(columns, rows, { mask = [], unmask = [] } = {}) {
  const extra = new Set(mask.map(c => c.toLowerCase()));
  const exempt = new Set(unmask.map(c => c.toLowerCase()));
  const masked = columns.map(c => {
    const lower = c.toLowerCase();
    if (exempt.has(lower)) return false;
    return extra.has(lower) || isPersonalColumn(c);
  });
  return {
    maskedColumns: columns.filter((_, i) => masked[i]),
    rows: rows.map(row => row.map((v, i) => (masked[i] ? maskValue(v) : v))),
  };
}
