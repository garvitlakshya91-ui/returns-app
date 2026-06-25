import { Badge } from '@shopify/polaris';

// tone = colour, progress = the little pie indicator Polaris renders.
const STATUS_MAP = {
  REQUESTED:  { tone: 'attention', progress: 'incomplete',        label: 'Requested' },
  APPROVED:   { tone: 'info',      progress: 'partiallyComplete',  label: 'Approved' },
  LABEL_SENT: { tone: 'info',      progress: 'partiallyComplete',  label: 'Label sent' },
  IN_TRANSIT: { tone: 'warning',   progress: 'partiallyComplete',  label: 'In transit' },
  RECEIVED:   { tone: 'info',      progress: 'partiallyComplete',  label: 'Received' },
  INSPECTING: { tone: 'warning',   progress: 'partiallyComplete',  label: 'Inspecting' },
  PROCESSED:  { tone: 'success',   progress: 'complete',           label: 'Processed' },
  REJECTED:   { tone: 'critical',  progress: 'complete',           label: 'Rejected' },
  CANCELLED:  { tone: 'new',       progress: 'complete',           label: 'Cancelled' },
};

export default function ReturnStatusBadge({ status }) {
  const config = STATUS_MAP[status] || { tone: 'new', label: status };
  return (
    <Badge tone={config.tone} progress={config.progress}>
      {config.label}
    </Badge>
  );
}
