const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
];

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat('en', {
  numeric: 'auto',
  style: 'narrow',
});

// Formats an ISO timestamp as a compact relative label ("5 min. ago",
// "2 mo. ago") for comment headers. Invalid input renders as an empty string
// rather than throwing mid-render.
export function formatRelativeTime(
  isoTimestamp: string,
  now = Date.now()
): string {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return '';
  }

  let duration = (timestamp - now) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE_FORMAT.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return '';
}
