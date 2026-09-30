export const TAX_RATE: number = 0.2, CURRENCY = 'EUR';
export let counter = 0;
export interface Receipt<T> {
  total: T;
}
export type ReceiptId = string;
export enum Channel {
  Web,
  Store,
}
interface InternalNote {
  text: string;
}
type InternalId = number;
const helper = 1;
export { helper, helper as assistant };
export { formatReceipt } from './format';
export * from './totals';
export * as taxes from './taxes';
export default createRegistry();

function createRegistry() {
  return new Map<string, number>();
}
