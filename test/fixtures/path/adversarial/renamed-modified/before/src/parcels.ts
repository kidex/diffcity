export function listParcels(): string[] {
  const parcels = ['crate', 'barrel', 'sack'];
  return parcels.filter((parcel) => parcel.length > 0);
}

export function createParcel(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase();
}

export function countParcels(): number {
  return listParcels().length;
}
