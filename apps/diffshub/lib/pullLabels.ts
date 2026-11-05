import type { PullLabel } from './pullInfoClient';
import { asRecord } from './untypedJson';

// GitHub label objects (REST `labels` arrays and GraphQL `labels.nodes`)
// reduced to name and color. Labels without a name are dropped; a missing
// color becomes '' (LabelColorDot then draws no swatch).
export function parseLabels(data: unknown): PullLabel[] {
  const labels: PullLabel[] = [];
  for (const item of Array.isArray(data) ? data : []) {
    const label = asRecord(item);
    if (typeof label?.name === 'string') {
      labels.push({
        color: typeof label.color === 'string' ? label.color : '',
        name: label.name,
      });
    }
  }
  return labels;
}
