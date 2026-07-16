/** IP 段 ASN 仅存/仅显数字，去掉不区分大小写的「AS」前缀 */
export function normalizeAsnDigitsOnly(o: unknown): string {
  if (o == null || o === '') return '';
  if (typeof o === 'number' && Number.isFinite(o)) return String(Math.trunc(o));
  const s = String(o).trim();
  if (!s || s === '-') return '';
  const stripped = s.replace(/^AS\s*/i, '');
  const m = stripped.match(/^(\d+)/);
  return m ? m[1] : stripped;
}
