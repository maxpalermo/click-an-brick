export function newId(len = 10): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => a[b % a.length]).join('');
}
