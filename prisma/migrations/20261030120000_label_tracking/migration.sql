-- Parcel tracking: the carrier's latest word on where the return parcel is.
ALTER TABLE "ReturnLabel"
  ADD COLUMN "trackingStatus"    TEXT,
  ADD COLUMN "trackingDetail"    TEXT,
  ADD COLUMN "trackingLocation"  TEXT,
  ADD COLUMN "trackingAt"        TIMESTAMP(3),
  ADD COLUMN "trackingCheckedAt" TIMESTAMP(3);
