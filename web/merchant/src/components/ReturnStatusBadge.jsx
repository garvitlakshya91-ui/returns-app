import { Badge } from '@shopify/polaris';

const STATUS_MAP = {
  REQUESTED: { tone: 'attention', label: 'Requested' },
  APPROVED: { tone: 'info', label: 'Approved' },
  LABEL_SENT: { tone: 'info', label: 'Label Sent' },
  IN_TRANSIT: { tone: 'warning', label: 'In Transit' },
  RECEIVED: { tone: 'info', label: 'Received' },
  INSPECTING: { tone: 'warning', label: 'Inspecting' },
  PROCESSED: { tone: 'success', label: 'Processed' },
  REJECTED: { tone: 'critical', label: 'Rejected' },
  CANCELLED: { tone: 'new', label: 'Cancelled' },
};

export default function ReturnStatusBadge({ status }) {
  const config = STATUS_MAP[status] || { tone: 'new', label: status };
  return <Badge tone={config.tone}>{config.label}</Badge>;
}
