/** Returns whether a numeric value is within the valid longitude range. */
export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
