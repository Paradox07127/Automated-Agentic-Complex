/** Query after `#…?` (or the search string) of the current URL. */
export function stackQuery(): URLSearchParams {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  return new URLSearchParams(i < 0 ? window.location.search : hash.slice(i + 1));
}
